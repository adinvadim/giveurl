import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { GiveurlError } from "./errors.js";

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
