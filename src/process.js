import { constants, accessSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function findCommand(name, environment = process.env) {
  const searchPath = environment.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH.
      }
    }
  }
  return null;
}

export function runCommand(command, args, { timeout = 10_000, environment = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout,
  });

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function commandFailure(result, fallback) {
  if (result.error?.code === "ETIMEDOUT") return `${fallback} (timed out)`;
  return (result.stderr || result.stdout || result.error?.message || fallback).trim();
}
