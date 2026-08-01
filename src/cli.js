import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GiveurlError, UsageError } from "./errors.js";
import { discoverProviders } from "./providers/discovery.js";
import { publishTailscale, statusTailscale, stopTailscale } from "./providers/tailscale.js";

const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const PROVIDERS = new Set(["auto", "tailscale", "github", "cloudflare"]);

const HELP = `giveurl — turn something local into a URL

Usage:
  giveurl <target> [options]
  giveurl providers [--json]
  giveurl status [--json]
  giveurl stop <url> [options]

Targets:
  A file, a directory, a localhost URL, or a port number.

Options:
  --provider <name>  Use auto, tailscale, github, or cloudflare (default: auto)
  -n, --dry-run      Show what would change without publishing or stopping
  --json             Print stable machine-readable JSON
  --no-input         Never prompt (currently the default behavior)
  -h, --help         Show this help
  --version          Print the version

Examples:
  npx giveurl screenshot.png
  npx giveurl ./site --json
  npx giveurl http://127.0.0.1:3000
  npx giveurl providers
  npx giveurl stop https://node.example.ts.net/giveurl/ID/artifact.png

Tailscale is supported today. GitHub Gists and Cloudflare are detected locally
and reserved as provider names for future releases.`;

function parse(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { action: "help" };
  if (argv.includes("--version")) return { action: "version" };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        provider: { type: "string", default: "auto" },
        "dry-run": { type: "boolean", short: "n", default: false },
        json: { type: "boolean", default: false },
        "no-input": { type: "boolean", default: false },
      },
    });
  } catch (cause) {
    throw new UsageError(cause.message);
  }

  const provider = parsed.values.provider;
  if (!PROVIDERS.has(provider)) {
    throw new UsageError(`Unknown provider: ${provider}. Use auto, tailscale, github, or cloudflare.`);
  }
  const common = {
    provider,
    dryRun: parsed.values["dry-run"],
    json: parsed.values.json,
    noInput: parsed.values["no-input"],
  };
  const [first, ...rest] = parsed.positionals;

  if (!first) throw new UsageError("Provide a target, or use providers, status, or stop <url>.");
  if (first === "providers") {
    if (rest.length > 0) throw new UsageError("providers takes no arguments.");
    if (common.dryRun) throw new UsageError("providers does not support --dry-run.");
    return { action: "providers", ...common };
  }
  if (first === "status") {
    if (rest.length > 0) throw new UsageError("status takes no arguments.");
    if (common.dryRun) throw new UsageError("status does not support --dry-run.");
    return { action: "status", ...common };
  }
  if (first === "stop") {
    if (rest.length !== 1) throw new UsageError("stop requires exactly one giveurl URL.");
    return { action: "stop", url: rest[0], ...common };
  }
  if (rest.length > 0) throw new UsageError("Publish accepts exactly one target.");
  return { action: "publish", target: first, ...common };
}

function selectedProvider(requested) {
  if (requested === "auto" || requested === "tailscale") return "tailscale";
  throw new GiveurlError(`${requested} is detected by giveurl, but publishing through it is not supported yet.`, {
    code: "PROVIDER_NOT_IMPLEMENTED",
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printProviders(providers, json) {
  if (json) {
    printJson({ providers });
    return;
  }
  process.stdout.write("PROVIDER         INSTALLED  AUTHENTICATED  SUPPORT  DETAIL\n");
  for (const provider of providers) {
    const label = provider.label.padEnd(16);
    const installed = (provider.installed ? "yes" : "no").padEnd(11);
    const authenticated = (provider.authenticated ? "yes" : "no").padEnd(15);
    const support = provider.supported ? "ready" : "planned";
    process.stdout.write(`${label} ${installed}${authenticated}${support.padEnd(9)}${provider.detail}\n`);
  }
}

function printPublish(result, json) {
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write(`${result.url}\n`);
  const verb = result.dryRun ? "Would share" : "Shared";
  process.stderr.write(`${verb} ${result.kind} via ${result.provider}; Tailscale access only.\n`);
  if (result.dryRun) process.stderr.write(`Command: ${result.command.join(" ")}\n`);
  else process.stderr.write(`Stop with: ${result.stopCommand}\n`);
}

function printStop(result, json) {
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write(`${result.dryRun ? "Would stop" : "Stopped"} ${result.url}\n`);
  if (result.dryRun) process.stderr.write(`Command: ${result.command.join(" ")}\n`);
}

function printStatus(shares, json) {
  if (json) {
    printJson({ shares });
    return;
  }
  if (shares.length === 0) {
    process.stdout.write("No active giveurl shares.\n");
    return;
  }
  for (const share of shares) process.stdout.write(`${share.url}\n`);
}

function printError(error, json) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof GiveurlError ? error.code : "UNEXPECTED_ERROR";
  if (json) process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  else {
    process.stderr.write(`giveurl: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write("Run giveurl --help for usage.\n");
  }
}

function addAutoProviderHint(error, command) {
  if (
    command?.action !== "publish"
    || command.provider !== "auto"
    || !(error instanceof GiveurlError)
    || !["PROVIDER_NOT_FOUND", "PROVIDER_UNAVAILABLE", "PROVIDER_INVALID_RESPONSE"].includes(error.code)
  ) return error;

  const alternatives = discoverProviders()
    .filter((provider) => provider.authenticated && !provider.supported)
    .map((provider) => provider.label);
  const suffix = alternatives.length > 0
    ? ` Detected ${alternatives.join(" and ")}, but support for ${alternatives.length === 1 ? "that provider" : "those providers"} is planned, not yet available.`
    : "";
  return new GiveurlError(`${error.message}${suffix}\nRun giveurl providers to inspect local options.`, {
    code: error.code,
    cause: error,
  });
}

export async function main(argv) {
  let command;
  try {
    command = parse(argv);
    if (command.action === "help") {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (command.action === "version") {
      process.stdout.write(`${PACKAGE.version}\n`);
      return 0;
    }
    if (command.action === "providers") {
      printProviders(discoverProviders(), command.json);
      return 0;
    }

    const provider = selectedProvider(command.provider);
    if (provider !== "tailscale") throw new GiveurlError(`Unsupported provider: ${provider}`);

    if (command.action === "publish") {
      printPublish(await publishTailscale(command.target, { dryRun: command.dryRun }), command.json);
      return 0;
    }
    if (command.action === "stop") {
      printStop(stopTailscale(command.url, { dryRun: command.dryRun }), command.json);
      return 0;
    }
    if (command.action === "status") {
      printStatus(statusTailscale(), command.json);
      return 0;
    }
    throw new UsageError(`Unknown action: ${command.action}`);
  } catch (error) {
    error = addAutoProviderHint(error, command);
    printError(error, command?.json ?? argv.includes("--json"));
    if (!(error instanceof GiveurlError) && process.env.GIVEURL_DEBUG) {
      process.stderr.write(`${error.stack ?? error}\n`);
    }
    return error instanceof UsageError ? 2 : 1;
  }
}

export { HELP, parse };
