import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "bin", "giveurl.js");

test("parses the default publish action", () => {
  assert.deepEqual(parse(["artifact.md", "--json"]), {
    action: "publish",
    target: "artifact.md",
    provider: "auto",
    dryRun: false,
    json: true,
    noInput: false,
  });
});

test("help wins over otherwise invalid arguments", () => {
  assert.deepEqual(parse(["--unknown", "--help"]), { action: "help" });
});

test("prints a bare semantic version", () => {
  assert.match(execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }), /^\d+\.\d+\.\d+\n$/);
});

test("dry-run emits stable JSON without mutating Tailscale", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-cli-test-"));
  const target = path.join(directory, "artifact.md");
  const fakeTailscale = path.join(directory, "tailscale");
  writeFileSync(target, "hello\n");
  writeFileSync(fakeTailscale, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { DNSName: "test-node.example.ts.net." } }));
  process.exit(0);
}
process.stderr.write("unexpected mutation");
process.exit(9);
`);
  chmodSync(fakeTailscale, 0o755);

  try {
    const result = spawnSync(process.execPath, [CLI, target, "--dry-run", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.dryRun, true);
    assert.equal(output.provider, "tailscale");
    assert.equal(output.kind, "file");
    assert.match(output.url, /^https:\/\/test-node\.example\.ts\.net\/giveurl\/.+\/artifact\.md$/);
    assert.match(output.command.at(-1), /^http:\/\/127\.0\.0\.1:<ephemeral>$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
