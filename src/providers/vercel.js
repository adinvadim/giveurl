import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GiveurlError } from "../errors.js";
import { commandFailure, findCommand, runCommand } from "../process.js";
import { resolveTarget } from "../target.js";

const EXCLUDED = new Set([".git", ".vercel", "node_modules", ".env", ".npmrc", ".yarnrc.yml", ".ssh", ".aws"]);

function excluded(name) {
  return EXCLUDED.has(name) || name.startsWith(".env");
}

function collectFiles(directory, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(directory, filename));
    else if (entry.isFile()) files.push(filename);
    else {
      throw new GiveurlError(`Vercel shares require regular files; unsupported entry: ${filename}`, {
        code: "INVALID_TARGET",
      });
    }
  }
  return files;
}

function inspectVercel(environment) {
  const executable = findCommand("vercel", environment);
  if (!executable) {
    throw new GiveurlError("Vercel CLI is not installed. Install a current version with npm install -g vercel.", {
      code: "PROVIDER_NOT_FOUND",
    });
  }
  const help = runCommand(executable, ["deploy", "--help"], { environment, timeout: 10_000 });
  if (![0, 2].includes(help.exitCode) || !`${help.stdout}\n${help.stderr}`.includes("--temporary")) {
    throw new GiveurlError("This Vercel CLI does not support deploy --temporary. Update the Vercel CLI.", {
      code: "PROVIDER_UNAVAILABLE",
    });
  }
  return executable;
}

function anonymousEnvironment(environment) {
  return Object.fromEntries(Object.entries({
    ...environment,
    VERCEL_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  }).filter(([name]) => (!name.startsWith("VERCEL_") && !name.startsWith("NOW_")) || name === "VERCEL_TELEMETRY_DISABLED"));
}

function deploymentResult(stdout) {
  let deployment;
  try {
    const payload = JSON.parse(stdout);
    deployment = payload.deployment ?? payload;
    const url = new URL(deployment.url);
    const claimUrl = new URL(deployment.claimUrl);
    if (url.protocol !== "https:" || ![".vercel.app", ".tmp.now"].some(suffix => url.hostname.endsWith(suffix))
      || url.username || url.password || url.search || url.hash
      || claimUrl.protocol !== "https:" || claimUrl.hostname !== "vercel.com"
      || claimUrl.username || claimUrl.password
      || !Number.isFinite(deployment.expiresAt) || deployment.expiresAt <= Date.now()) {
      throw new Error("Not a temporary deployment");
    }
  } catch (cause) {
    throw new GiveurlError("Vercel did not return a temporary deployment URL, claim URL, and future expiry.", {
      code: "PROVIDER_INVALID_RESPONSE", cause,
    });
  }
  return deployment;
}

function deploy(executable, args, environment, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment, cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let killTimer;
    function stop(message, code = "PROVIDER_COMMAND_FAILED") {
      if (failure) return;
      failure = new GiveurlError(message, { code });
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill();
      }
      killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // The deployment group may already have exited.
        }
      }, 2_000);
    }
    const cancel = () => stop("Vercel temporary deployment cancelled.");
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    function cleanup() {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    const timer = setTimeout(() => stop("Vercel temporary deployment timed out."), 600_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) stop("Vercel output exceeded the supported size.");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (/temporary deployments aren.t available|starting login flow|vercel\.com\/.*(?:activate|device)/i.test(stderr)) {
        stop("Vercel refused the anonymous temporary deployment; stopped the CLI login fallback. Try again later or use another provider.", "PROVIDER_UNAVAILABLE");
      }
      if (stderr.length > 4 * 1024 * 1024) stop("Vercel output exceeded the supported size.");
    });
    child.on("error", (cause) => {
      cleanup();
      reject(new GiveurlError("Could not start Vercel CLI.", { code: "PROVIDER_COMMAND_FAILED", cause }));
    });
    child.on("close", (exitCode) => {
      if (failure && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch {
          // Reap any remaining build processes after their launcher exits.
        }
      }
      cleanup();
      if (failure) reject(failure);
      else if (exitCode !== 0) reject(new GiveurlError(commandFailure({ stdout, stderr }, "Vercel temporary deployment failed."), {
        code: "PROVIDER_COMMAND_FAILED",
      }));
      else resolve(stdout);
    });
  });
}

export async function publishVercel(rawTarget, { dryRun = false, environment = process.env } = {}) {
  const resolved = resolveTarget(rawTarget);
  if (resolved.kind === "service") {
    throw new GiveurlError("Vercel temporary deployments support files and directories. Use Tailscale for localhost services.", {
      code: "INVALID_TARGET",
    });
  }
  if (resolved.target.split(path.sep).some(excluded)) {
    throw new GiveurlError("Vercel shares exclude credential files, credential directories, and local provider state.", {
      code: "INVALID_TARGET",
    });
  }
  const executable = inspectVercel(environment);
  const files = resolved.kind === "directory" ? collectFiles(resolved.target) : [path.basename(resolved.target)];
  if (files.length === 0) {
    throw new GiveurlError("No publishable files; Vercel shares exclude credentials and local provider state.", {
      code: "INVALID_TARGET",
    });
  }
  const leaf = resolved.kind === "file" && !/\.html?$/i.test(resolved.target) ? resolved.leaf : "/";
  const command = [executable, "deploy", "<staging-directory>", "--temporary", "--yes", "--json", "--non-interactive", "--global-config", "<isolated-config-directory>"];
  const result = {
    dryRun, provider: "vercel", kind: resolved.kind, target: resolved.target,
    visibility: "public", temporary: true, transport: "vercel-temporary",
    url: `https://DEPLOYMENT.tmp.now${leaf}`, stopCommand: null, command,
  };
  if (dryRun) return { ...result, files };

  const temporary = mkdtempSync(path.join(tmpdir(), "giveurl-vercel-"));
  const staging = path.join(temporary, "site");
  const config = path.join(temporary, "config");
  try {
    mkdirSync(staging);
    mkdirSync(config, { mode: 0o700 });
    for (const filename of files) {
      const source = resolved.kind === "directory" ? path.join(resolved.target, filename) : resolved.target;
      if (!lstatSync(source).isFile()) {
        throw new GiveurlError(`Target changed while preparing deployment: ${filename}`, { code: "INVALID_TARGET" });
      }
      const destination = resolved.kind === "directory" ? filename : leaf === "/" ? "index.html" : resolved.leaf.slice(1);
      const output = path.join(staging, destination);
      mkdirSync(path.dirname(output), { recursive: true });
      copyFileSync(source, output);
    }
    const args = ["deploy", staging, "--temporary", "--yes", "--json", "--non-interactive", "--global-config", config];
    const stdout = await deploy(executable, args, anonymousEnvironment(environment), staging);
    const deployment = deploymentResult(stdout);
    return {
      ...result,
      url: new URL(leaf, deployment.url).href,
      previewUrl: deployment.url,
      claimUrl: deployment.claimUrl,
      expiresAt: deployment.expiresAt,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function statusVercel() {
  throw new GiveurlError("Anonymous Vercel shares cannot be listed. Keep the returned URL, claimUrl, and expiresAt.", {
    code: "PROVIDER_UNSUPPORTED_ACTION",
  });
}

export function stopVercel() {
  throw new GiveurlError("Anonymous Vercel shares expire at expiresAt. To manage or delete one earlier, open its claimUrl and claim it in your Vercel account.", {
    code: "PROVIDER_UNSUPPORTED_ACTION",
  });
}
