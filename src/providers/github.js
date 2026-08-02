import { readFileSync } from "node:fs";
import { GiveurlError } from "../errors.js";
import { commandFailure, findCommand, runCommand } from "../process.js";
import { resolveTarget } from "../target.js";

export const GITHUB_DESCRIPTION_PREFIX = "giveurl:v1:";
const MAX_RAW_FILE_SIZE = 10_000_000;
const GIST_FIELDS_JQ = "{id: .id, pageUrl: .html_url, description: .description, public: .public, owner: .owner.login, files: [.files | to_entries[] | {filename: .key, rawUrl: .value.raw_url}]}";

function githubCommand(executable, args, fallback, { environment = process.env, input, timeout = 20_000 } = {}) {
  const result = runCommand(executable, args, { environment, input, timeout });
  if (result.exitCode !== 0) {
    throw new GiveurlError(commandFailure(result, fallback), { code: "PROVIDER_COMMAND_FAILED" });
  }
  return result;
}

function parseResponse(result, fallback) {
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new GiveurlError(fallback, { code: "PROVIDER_INVALID_RESPONSE", cause });
  }
}

function inspectGitHub(environment = process.env) {
  const providerEnvironment = { ...environment, GH_HOST: "github.com" };
  const executable = findCommand("gh", providerEnvironment);
  if (!executable) {
    throw new GiveurlError("GitHub CLI is not installed or is not on PATH.", { code: "PROVIDER_NOT_FOUND" });
  }
  const result = runCommand(executable, ["api", "user", "--jq", ".login"], {
    timeout: 8_000,
    environment: providerEnvironment,
  });
  const owner = result.stdout.trim();
  if (result.exitCode !== 0 || !owner) {
    throw new GiveurlError(commandFailure(result, "GitHub CLI is not authenticated with github.com."), {
      code: "PROVIDER_UNAVAILABLE",
    });
  }
  return { executable, owner, environment: providerEnvironment };
}

function readTextFile(filename) {
  const content = readFileSync(filename);
  if (content.length > MAX_RAW_FILE_SIZE) {
    throw new GiveurlError(
      "GitHub Gists shared by giveurl must be 10 MB or smaller so the direct raw URL remains usable.",
      { code: "INVALID_TARGET" },
    );
  }
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) {
    throw new GiveurlError(
      "GitHub Gists can only share UTF-8 text files. Use Tailscale for binary files.",
      { code: "INVALID_TARGET" },
    );
  }
  return text;
}

function primaryFile(gist) {
  const files = Array.isArray(gist.files) ? gist.files.filter((file) => file?.rawUrl) : [];
  if (files.length === 0) {
    throw new GiveurlError("GitHub returned a Gist without a raw file URL.", {
      code: "PROVIDER_INVALID_RESPONSE",
    });
  }
  return files.sort((left, right) => left.filename.localeCompare(right.filename))[0];
}

function normalizeGist(gist) {
  if (!gist?.id || !gist?.pageUrl || !gist?.owner) {
    throw new GiveurlError("GitHub returned incomplete Gist metadata.", {
      code: "PROVIDER_INVALID_RESPONSE",
    });
  }
  const file = primaryFile(gist);
  return {
    id: gist.id,
    owner: gist.owner,
    filename: file.filename,
    url: file.rawUrl,
    pageUrl: gist.pageUrl,
  };
}

export async function publishGitHub(rawTarget, { dryRun = false, environment = process.env } = {}) {
  const { executable, owner, environment: providerEnvironment } = inspectGitHub(environment);
  const resolved = resolveTarget(rawTarget);
  if (resolved.kind !== "file") {
    throw new GiveurlError(
      "GitHub Gists only support individual UTF-8 text files. Use Tailscale for directories and services.",
      { code: "INVALID_TARGET" },
    );
  }

  const filename = resolved.leaf.slice(1);
  const content = readTextFile(resolved.target);
  const description = `${GITHUB_DESCRIPTION_PREFIX}${filename}`;
  const command = [
    executable,
    "api",
    "--method",
    "POST",
    "gists",
    "--input",
    "-",
    "--jq",
    GIST_FIELDS_JQ,
  ];

  if (dryRun) {
    const url = `https://gist.githubusercontent.com/${owner}/GIST_ID/raw/REVISION/${encodeURIComponent(filename)}`;
    return {
      dryRun: true,
      provider: "github",
      kind: "file",
      target: resolved.target,
      owner,
      filename,
      visibility: "secret",
      transport: "github-gist",
      url,
      pageUrl: `https://gist.github.com/${owner}/GIST_ID`,
      stopCommand: `giveurl stop ${url}`,
      command,
    };
  }

  const payload = JSON.stringify({
    description,
    public: false,
    files: { [filename]: { content } },
  });
  const result = githubCommand(command[0], command.slice(1), "GitHub could not create the Gist.", {
    environment: providerEnvironment,
    input: payload,
    timeout: 60_000,
  });
  const gist = normalizeGist(parseResponse(result, "GitHub returned invalid Gist metadata."));
  return {
    dryRun: false,
    provider: "github",
    kind: "file",
    target: resolved.target,
    ...gist,
    visibility: "secret",
    transport: "github-gist",
    stopCommand: `giveurl stop ${gist.url}`,
    command,
  };
}

function parseGistUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new GiveurlError("Expected a giveurl GitHub Gist URL.", { code: "INVALID_SHARE", cause });
  }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) {
    throw new GiveurlError("Expected an unmodified giveurl GitHub Gist URL.", { code: "INVALID_SHARE" });
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  let owner;
  let id;
  let kind;
  if (parsed.hostname === "gist.github.com" && parts.length === 2) {
    [owner, id] = parts;
    kind = "page";
  } else if (parsed.hostname === "gist.githubusercontent.com" && parts.length >= 4 && parts[2] === "raw") {
    [owner, id] = parts;
    kind = "raw";
  } else {
    throw new GiveurlError("Expected a GitHub Gist page or raw file URL.", { code: "INVALID_SHARE" });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(owner) || !/^[A-Fa-f0-9]+$/.test(id)) {
    throw new GiveurlError("Invalid GitHub Gist URL.", { code: "INVALID_SHARE" });
  }
  return { owner, id, kind, url: parsed.href };
}

function matchesRequestedUrl(requested, gist) {
  const candidates = requested.kind === "page"
    ? [gist.pageUrl]
    : (Array.isArray(gist.files) ? gist.files.map((file) => file.rawUrl) : []);
  return candidates.some((candidate) => {
    try {
      return new URL(candidate).href === requested.url;
    } catch {
      return false;
    }
  });
}

function readGist(executable, id, environment) {
  const result = githubCommand(
    executable,
    ["api", `gists/${id}`, "--jq", GIST_FIELDS_JQ],
    "GitHub could not read the Gist.",
    { environment },
  );
  return parseResponse(result, "GitHub returned invalid Gist metadata.");
}

export function stopGitHub(rawUrl, { dryRun = false, environment = process.env } = {}) {
  const { executable, owner, environment: providerEnvironment } = inspectGitHub(environment);
  const requested = parseGistUrl(rawUrl);
  const gist = readGist(executable, requested.id, providerEnvironment);
  if (gist.owner !== owner || requested.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new GiveurlError("Run stop with the GitHub account that created this Gist.", { code: "WRONG_ACCOUNT" });
  }
  if (!String(gist.description ?? "").startsWith(GITHUB_DESCRIPTION_PREFIX)) {
    throw new GiveurlError("Refusing to delete a Gist that was not created by giveurl.", {
      code: "INVALID_SHARE",
    });
  }
  if (!matchesRequestedUrl(requested, gist)) {
    throw new GiveurlError("Expected an unmodified giveurl GitHub Gist URL.", { code: "INVALID_SHARE" });
  }

  const normalized = normalizeGist(gist);
  const command = [executable, "gist", "delete", requested.id, "--yes"];
  if (!dryRun) {
    githubCommand(command[0], command.slice(1), "GitHub could not delete the Gist.", {
      environment: providerEnvironment,
    });
  }
  return {
    dryRun,
    provider: "github",
    owner,
    id: requested.id,
    stopped: !dryRun,
    url: normalized.url,
    pageUrl: normalized.pageUrl,
    command,
  };
}

export function statusGitHub({ environment = process.env } = {}) {
  const { executable, owner, environment: providerEnvironment } = inspectGitHub(environment);
  const marker = JSON.stringify(GITHUB_DESCRIPTION_PREFIX);
  const jq = `.[] | select(((.description // "") | startswith(${marker}))) | ${GIST_FIELDS_JQ} | @json`;
  const result = githubCommand(
    executable,
    ["api", "--method", "GET", "--paginate", "gists", "-f", "per_page=100", "--jq", jq],
    "GitHub could not list Gists.",
    { environment: providerEnvironment, timeout: 60_000 },
  );
  let gists;
  try {
    gists = result.stdout.trim()
      ? result.stdout.trim().split("\n").map((line) => JSON.parse(line))
      : [];
  } catch (cause) {
    throw new GiveurlError("GitHub returned invalid Gist list metadata.", {
      code: "PROVIDER_INVALID_RESPONSE",
      cause,
    });
  }
  return gists.map((gist) => {
    const normalized = normalizeGist(gist);
    return {
      provider: "github",
      owner,
      id: normalized.id,
      filename: normalized.filename,
      url: normalized.url,
      pageUrl: normalized.pageUrl,
    };
  }).sort((left, right) => left.url.localeCompare(right.url));
}
