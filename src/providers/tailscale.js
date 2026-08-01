import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { GiveurlError } from "../errors.js";
import { commandFailure, findCommand, runCommand } from "../process.js";

export const TAILSCALE_ROUTE_PREFIX = "/giveurl/";
const HTTPS_PORT = 443;
const START_TIMEOUT_MS = 5_000;
const WORKER_PATH = fileURLToPath(new URL("../backend-worker.js", import.meta.url));

function inspectTailscale(environment = process.env) {
  const executable = findCommand("tailscale", environment);
  if (!executable) {
    throw new GiveurlError("Tailscale is not installed or is not on PATH.", { code: "PROVIDER_NOT_FOUND" });
  }
  const result = runCommand(executable, ["status", "--json"], { timeout: 8_000, environment });
  if (result.exitCode !== 0) {
    throw new GiveurlError(commandFailure(result, "Could not read Tailscale status."), {
      code: "PROVIDER_UNAVAILABLE",
    });
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (cause) {
    throw new GiveurlError("Tailscale returned invalid status JSON.", {
      code: "PROVIDER_INVALID_RESPONSE",
      cause,
    });
  }
  if (payload.BackendState !== "Running") {
    throw new GiveurlError(`Tailscale is not running (state: ${payload.BackendState ?? "unknown"}).`, {
      code: "PROVIDER_UNAVAILABLE",
    });
  }
  const node = String(payload.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!node) {
    throw new GiveurlError("This Tailscale node has no MagicDNS name.", { code: "PROVIDER_UNAVAILABLE" });
  }
  return { executable, node };
}

function validSuffix(filename) {
  const suffixes = path.basename(filename).match(/(?:\.[a-zA-Z0-9]{1,12}){1,3}$/)?.[0] ?? "";
  return suffixes.toLowerCase();
}

export function resolveTarget(rawTarget) {
  const candidate = path.resolve(rawTarget.replace(/^~(?=$|[/\\])/, process.env.HOME ?? "~"));
  if (existsSync(candidate)) {
    const resolved = realpathSync(candidate);
    const metadata = statSync(resolved);
    if (metadata.isDirectory()) return { target: resolved, kind: "directory", leaf: "/" };
    if (metadata.isFile()) return { target: resolved, kind: "file", leaf: `/artifact${validSuffix(resolved)}` };
    throw new GiveurlError(`Unsupported filesystem target: ${resolved}`, { code: "INVALID_TARGET" });
  }

  if (/^\d+$/.test(rawTarget)) {
    const port = Number(rawTarget);
    if (port > 0 && port < 65_536) {
      return { target: `http://127.0.0.1:${port}`, kind: "service", leaf: "/" };
    }
  }

  let parsed;
  try {
    parsed = new URL(rawTarget.includes("://") ? rawTarget : `http://${rawTarget}`);
  } catch {
    parsed = null;
  }
  if (
    parsed
    && ["http:", "https:", "https+insecure:"].includes(parsed.protocol)
    && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)
  ) {
    return { target: parsed.href, kind: "service", leaf: "/" };
  }

  throw new GiveurlError(
    `Target does not exist and is not a localhost service: ${rawTarget}\nUse an existing path, a port, or an http(s)://localhost URL.`,
    { code: "INVALID_TARGET" },
  );
}

export function createRoute(leaf, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${TAILSCALE_ROUTE_PREFIX}${stamp}-${randomBytes(8).toString("hex")}${leaf}`;
}

function shareId(route) {
  const identifier = route.slice(TAILSCALE_ROUTE_PREFIX.length).split("/", 1)[0];
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) {
    throw new GiveurlError("Invalid giveurl route.", { code: "INVALID_SHARE" });
  }
  return identifier;
}

function stateDirectory(environment = process.env) {
  const root = environment.XDG_STATE_HOME || path.join(environment.HOME ?? process.cwd(), ".local", "state");
  return path.join(root, "giveurl", "tailscale");
}

function statePath(route, environment = process.env) {
  return path.join(stateDirectory(environment), `${shareId(route)}.json`);
}

function processMatches(pid, token) {
  const result = runCommand("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 });
  return result.exitCode === 0 && result.stdout.includes(token);
}

function stopProcess(pid, token) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !token) return;
  if (process.platform !== "win32" && !processMatches(pid, token)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function startBackend({ target, kind, route }) {
  const readyDirectory = mkdtempSync(path.join(tmpdir(), "giveurl-ready-"));
  const readyPath = path.join(readyDirectory, "ready.json");
  const token = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [WORKER_PATH, target, kind, route, readyPath, token], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (existsSync(readyPath)) {
        const ready = JSON.parse(readFileSync(readyPath, "utf8"));
        if (ready.error) throw new GiveurlError(`Local artifact server failed: ${ready.error}`);
        if (Number.isInteger(ready.port) && ready.port > 0) {
          return { port: ready.port, pid: child.pid, token };
        }
      }
      await wait(40);
    }
  } finally {
    rmSync(readyDirectory, { recursive: true, force: true });
  }
  stopProcess(child.pid, token);
  throw new GiveurlError("Local artifact server did not start in time.", { code: "BACKEND_START_FAILED" });
}

function writeBackendState(route, backend, environment = process.env) {
  const directory = stateDirectory(environment);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = statePath(route, environment);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...backend, route }), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
}

function stopBackend(route, environment = process.env) {
  const filename = statePath(route, environment);
  if (!existsSync(filename)) return;
  try {
    const state = JSON.parse(readFileSync(filename, "utf8"));
    if (state.route === route) stopProcess(Number(state.pid), String(state.token ?? ""));
  } catch {
    // A stale state file should not prevent removal of the Tailscale route.
  }
  rmSync(filename, { force: true });
}

function tailscaleCommand(executable, args, fallback) {
  const result = runCommand(executable, args, { timeout: 15_000 });
  if (result.exitCode !== 0) {
    throw new GiveurlError(commandFailure(result, fallback), { code: "PROVIDER_COMMAND_FAILED" });
  }
  return result;
}

export function collectRoutes(payload) {
  const routes = [];
  for (const webServer of Object.values(payload.Web ?? {})) {
    for (const route of Object.keys(webServer?.Handlers ?? {})) {
      if (route.startsWith(TAILSCALE_ROUTE_PREFIX)) routes.push(route);
    }
  }
  return routes;
}

function activeRoutes(executable) {
  const result = tailscaleCommand(executable, ["serve", "status", "--json"], "Could not read Tailscale Serve status.");
  try {
    return collectRoutes(JSON.parse(result.stdout));
  } catch (cause) {
    throw new GiveurlError("Tailscale Serve returned invalid status JSON.", {
      code: "PROVIDER_INVALID_RESPONSE",
      cause,
    });
  }
}

export async function publishTailscale(rawTarget, { dryRun = false, environment = process.env } = {}) {
  const { executable, node } = inspectTailscale(environment);
  const resolved = resolveTarget(rawTarget);
  const route = createRoute(resolved.leaf);
  const url = `https://${node}${route}`;
  let proxyTarget = resolved.target;
  let backend = null;

  if (["file", "directory"].includes(resolved.kind)) {
    proxyTarget = "http://127.0.0.1:<ephemeral>";
    if (!dryRun) {
      backend = await startBackend({ target: resolved.target, kind: resolved.kind, route });
      proxyTarget = `http://127.0.0.1:${backend.port}`;
    }
  }

  const command = [
    "serve",
    "--bg",
    "--yes",
    `--https=${HTTPS_PORT}`,
    `--set-path=${route}`,
    proxyTarget,
  ];

  if (!dryRun) {
    try {
      tailscaleCommand(executable, command, "Tailscale could not publish the target.");
      if (backend) writeBackendState(route, backend, environment);
    } catch (error) {
      if (backend) stopProcess(backend.pid, backend.token);
      try {
        tailscaleCommand(
          executable,
          ["serve", "--yes", `--https=${HTTPS_PORT}`, `--set-path=${route}`, "off"],
          "Could not roll back the Tailscale route.",
        );
      } catch {
        // Preserve the original publish failure.
      }
      throw error;
    }
  }

  return {
    dryRun,
    provider: "tailscale",
    kind: resolved.kind,
    target: resolved.target,
    node,
    route,
    transport: resolved.kind === "service" ? "tailscale-proxy" : "localhost-proxy",
    url,
    stopCommand: `giveurl stop ${url}`,
    command: [executable, ...command],
  };
}

function matchingRoute(rawUrl, node, routes) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new GiveurlError("Expected a giveurl URL.", { code: "INVALID_SHARE", cause });
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== node) {
    throw new GiveurlError(`Run stop on the source node (${parsed.hostname || "unknown"}), not ${node}.`, {
      code: "WRONG_NODE",
    });
  }
  if (parsed.search || parsed.hash || !parsed.pathname.startsWith(TAILSCALE_ROUTE_PREFIX)) {
    throw new GiveurlError("Expected an unmodified giveurl URL.", { code: "INVALID_SHARE" });
  }
  const matches = routes.filter((route) => parsed.pathname.startsWith(route));
  if (matches.length === 0) {
    throw new GiveurlError("No active giveurl route matches this URL.", { code: "SHARE_NOT_FOUND" });
  }
  return matches.sort((left, right) => right.length - left.length)[0];
}

export function stopTailscale(rawUrl, { dryRun = false, environment = process.env } = {}) {
  const { executable, node } = inspectTailscale(environment);
  const route = matchingRoute(rawUrl, node, activeRoutes(executable));
  const command = ["serve", "--yes", `--https=${HTTPS_PORT}`, `--set-path=${route}`, "off"];
  if (!dryRun) {
    tailscaleCommand(executable, command, "Tailscale could not remove the share.");
    stopBackend(route, environment);
  }
  return {
    dryRun,
    provider: "tailscale",
    node,
    route,
    stopped: !dryRun,
    url: `https://${node}${route}`,
    command: [executable, ...command],
  };
}

export function statusTailscale({ environment = process.env } = {}) {
  const { executable, node } = inspectTailscale(environment);
  return activeRoutes(executable).sort().map((route) => ({
    provider: "tailscale",
    node,
    route,
    url: `https://${node}${route}`,
  }));
}
