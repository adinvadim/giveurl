import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRoutes, createRoute, resolveTarget } from "../src/providers/tailscale.js";

test("collects only giveurl handlers from Tailscale status", () => {
  assert.deepEqual(collectRoutes({
    Web: {
      "node.example.ts.net:443": {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:3000" },
          "/giveurl/one/": { Proxy: "http://127.0.0.1:4000" },
          "/giveurl/two/artifact.md": { Proxy: "http://127.0.0.1:4001" },
        },
      },
    },
  }), ["/giveurl/one/", "/giveurl/two/artifact.md"]);
});

test("creates collision-resistant provider routes", () => {
  const route = createRoute("/artifact.tar.gz", new Date("2026-08-02T15:45:00.000Z"));
  assert.match(route, /^\/giveurl\/20260802T154500Z-[a-f0-9]{16}\/artifact\.tar\.gz$/);
});

test("resolves files and normalizes localhost ports", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-target-test-"));
  const target = path.join(directory, "report.final.md");
  writeFileSync(target, "done\n");
  try {
    assert.deepEqual(resolveTarget(target), {
      target: realpathSync(target),
      kind: "file",
      leaf: "/artifact.final.md",
    });
    assert.deepEqual(resolveTarget("4321"), {
      target: "http://127.0.0.1:4321",
      kind: "service",
      leaf: "/",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
