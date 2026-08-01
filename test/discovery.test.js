import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectCloudflare, detectGitHub, detectTailscale } from "../src/providers/discovery.js";

function fakeCommand(directory, name, body) {
  const filename = path.join(directory, name);
  writeFileSync(filename, `#!/bin/sh\n${body}\n`);
  chmodSync(filename, 0o755);
}

test("discovers installed and authenticated local providers", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-provider-test-"));
  fakeCommand(directory, "tailscale", "printf '%s' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"node.example.ts.net.\"}}'");
  fakeCommand(directory, "gh", "exit 0");
  fakeCommand(directory, "wrangler", "printf '%s' 'You are logged in'\nexit 0");
  const environment = { ...process.env, PATH: directory };

  try {
    assert.deepEqual(detectTailscale(environment), {
      id: "tailscale",
      label: "Tailscale",
      supported: true,
      installed: true,
      authenticated: true,
      ready: true,
      detail: "node.example.ts.net",
    });
    assert.equal(detectGitHub(environment).authenticated, true);
    assert.equal(detectCloudflare(environment).authenticated, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports absent providers without configuration", () => {
  const environment = { PATH: "" };
  assert.equal(detectTailscale(environment).installed, false);
  assert.equal(detectGitHub(environment).installed, false);
  assert.equal(detectCloudflare(environment).installed, false);
});
