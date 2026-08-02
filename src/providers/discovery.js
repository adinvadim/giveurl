import { findCommand, runCommand } from "../process.js";

function unavailable(id, label, supported) {
  return {
    id,
    label,
    supported,
    installed: false,
    authenticated: false,
    ready: false,
    detail: "not installed",
  };
}

export function detectTailscale(environment = process.env) {
  const executable = findCommand("tailscale", environment);
  if (!executable) return unavailable("tailscale", "Tailscale", true);

  const result = runCommand(executable, ["status", "--json"], { timeout: 5_000, environment });
  if (result.exitCode !== 0) {
    return {
      ...unavailable("tailscale", "Tailscale", true),
      installed: true,
      detail: "installed, but unavailable",
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    const running = payload.BackendState === "Running";
    const dnsName = String(payload.Self?.DNSName ?? "").replace(/\.$/, "");
    return {
      id: "tailscale",
      label: "Tailscale",
      supported: true,
      installed: true,
      authenticated: running,
      ready: running && Boolean(dnsName),
      detail: running ? (dnsName || "running without MagicDNS") : `state: ${payload.BackendState ?? "unknown"}`,
    };
  } catch {
    return {
      ...unavailable("tailscale", "Tailscale", true),
      installed: true,
      detail: "returned invalid status",
    };
  }
}

export function detectGitHub(environment = process.env) {
  const executable = findCommand("gh", environment);
  if (!executable) return unavailable("github", "GitHub Gists", true);
  const result = runCommand(executable, ["auth", "status", "--hostname", "github.com"], {
    timeout: 5_000,
    environment,
  });
  const authenticated = result.exitCode === 0;
  return {
    id: "github",
    label: "GitHub Gists",
    supported: true,
    installed: true,
    authenticated,
    ready: authenticated,
    detail: authenticated ? "authenticated; UTF-8 text files ready" : "not authenticated",
  };
}

export function detectCloudflare(environment = process.env) {
  const executable = findCommand("wrangler", environment);
  if (!executable) return unavailable("cloudflare", "Cloudflare", false);
  const result = runCommand(executable, ["whoami"], { timeout: 8_000, environment });
  const output = `${result.stdout}\n${result.stderr}`;
  const denied = /not authenticated|not logged in|not authorized|login required/i.test(output);
  const authenticated = result.exitCode === 0 && !denied;
  return {
    id: "cloudflare",
    label: "Cloudflare",
    supported: false,
    installed: true,
    authenticated,
    ready: false,
    detail: authenticated ? "authenticated; provider planned" : "not authenticated",
  };
}

export function discoverProviders(environment = process.env) {
  return [
    detectTailscale(environment),
    detectGitHub(environment),
    detectCloudflare(environment),
  ];
}
