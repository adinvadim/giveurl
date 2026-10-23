import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { publishVercel, statusVercel, stopVercel } from "../src/providers/vercel.js";
import { detectVercel } from "../src/providers/discovery.js";

function fixture(t, mode = "success") {
  const root = mkdtempSync(path.join(tmpdir(), "giveurl-vercel-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "site");
  mkdirSync(target);
  const log = path.join(root, "calls.jsonl");
  const executable = path.join(root, "vercel");
  writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stderr.write(${JSON.stringify(mode === "old" ? "deploy --yes" : "deploy --temporary")});
  process.exit(${JSON.stringify(mode)} === "help2" ? 2 : 0);
}
const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), {withFileTypes: true}).flatMap(entry => {
  const name = path.join(rel, entry.name);
  return entry.isDirectory() ? walk(dir, name) : [name];
});
const files = walk(args[1]);
const stagingRealpath = fs.realpathSync(args[1]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, pid: process.pid, cwd: process.cwd(), files,
  stagingRealpath,
  content: files.map(name => fs.readFileSync(path.join(args[1], name)).toString("base64")),
  config: fs.readdirSync(args[args.indexOf("--global-config") + 1]),
  credentials: Object.keys(process.env).filter(k => /^(VERCEL_|NOW_)/.test(k) && k !== "VERCEL_TELEMETRY_DISABLED")}) + "\\n");
if (${JSON.stringify(mode)} === "slow") {
  fs.mkdirSync(path.join(args[1], ".vercel"));
  fs.writeFileSync(path.join(args[1], ".vercel/anonymous.json"), "fixture ephemeral credential");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(mode)} === "login") {
  process.stderr.write("Temporary deployments aren't available for this attempt. Log in to continue.");
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(mode)} === "failure") {
  process.stderr.write("build failed");
  process.exit(1);
} else {
  const deployment = {url: "https://temporary-example.vercel.app", claimUrl: "https://vercel.com/claim-deployment?code=fixture", expiresAt: Date.now() + 3600000};
  if (${JSON.stringify(mode)} === "native") deployment.url = "https://temporary-example.tmp.now";
  if (${JSON.stringify(mode)} === "spoofed") deployment.url = "https://temporary-example.tmp.now.attacker.test";
  if (${JSON.stringify(mode)} === "invalid") delete deployment.claimUrl;
  if (${JSON.stringify(mode)} === "authenticated") {delete deployment.claimUrl; delete deployment.expiresAt;}
  process.stdout.write(JSON.stringify(["envelope", "native"].includes(${JSON.stringify(mode)}) ? {status: "ok", deployment} : deployment));
}
`, { mode: 0o755 });
  return {
    root, target, log,
    environment: { ...process.env, PATH: root, VERCEL_TOKEN: "fixture", VERCEL_PROJECT_ID: "fixture", VERCEL_ORG_ID: "fixture", NOW_TOKEN: "fixture" },
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("discovers temporary deploy support without requiring authentication", t => {
  const f = fixture(t);
  const detected = detectVercel(f.environment);
  assert.equal(detected.ready, true);
  assert.equal(detected.authenticated, false);
  assert.equal(detectVercel({ PATH: "" }).installed, false);
  assert.equal(detectVercel(fixture(t, "old").environment).ready, false);
  assert.equal(detectVercel(fixture(t, "help2").environment).ready, true);
  assert.deepEqual(f.calls(), []);
});

test("publishes HTML from an isolated copy, excludes credentials, and leaves source unchanged", async t => {
  const f = fixture(t, "envelope");
  for (const name of ["index.html", ".env", ".env.local", ".envrc", ".env-production", ".npmrc"]) writeFileSync(path.join(f.target, name), name);
  for (const name of [".git", ".vercel", "node_modules", "assets"]) {
    mkdirSync(path.join(f.target, name));
    writeFileSync(path.join(f.target, name, "file"), name);
  }
  const result = await publishVercel(f.target, { environment: f.environment });
  assert.equal(result.url, "https://temporary-example.vercel.app/");
  assert.equal(result.visibility, "public");
  assert.equal(result.temporary, true);
  assert.match(result.claimUrl, /^https:\/\/vercel.com\//);
  assert.ok(result.expiresAt > Date.now());
  assert.equal(result.stopCommand, null);
  const [call] = f.calls();
  assert.deepEqual(call.files.sort(), ["assets/file", "index.html"]);
  assert.deepEqual(call.credentials, []);
  assert.deepEqual(call.config, []);
  assert.ok(call.args.includes("--temporary"));
  assert.ok(call.args.includes("--non-interactive"));
  assert.equal(call.cwd, call.stagingRealpath);
  assert.equal(existsSync(call.args[1]), false);
  assert.equal(readFileSync(path.join(f.target, ".vercel/file"), "utf8"), ".vercel");
});

test("single HTML opens at the root; binary artifacts retain exact bytes", async t => {
  const f = fixture(t);
  const html = path.join(f.target, "lesson.html");
  writeFileSync(html, "<h1>hello</h1>");
  assert.equal((await publishVercel(html, { environment: f.environment })).url, "https://temporary-example.vercel.app/");
  assert.deepEqual(f.calls()[0].files, ["index.html"]);
  const image = path.join(f.target, "pic.png");
  const bytes = Buffer.from([0, 255, 128, 12]);
  writeFileSync(image, bytes);
  assert.equal((await publishVercel(image, { environment: f.environment })).url, "https://temporary-example.vercel.app/artifact.png");
  assert.deepEqual(Buffer.from(f.calls()[1].content[0], "base64"), bytes);
});

test("dry-run reports the upload plan without deploying or writing source state", async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.target, "index.html"), "hello");
  const result = await publishVercel(f.target, { dryRun: true, environment: f.environment });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.files, ["index.html"]);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(path.join(f.target, ".vercel")), false);
});

test("accepts the JS Vercel CLI's help exit status 2", async t => {
  const f = fixture(t, "help2");
  writeFileSync(path.join(f.target, "index.html"), "hello");
  const result = await publishVercel(f.target, { dryRun: true, environment: f.environment });
  assert.equal(result.provider, "vercel");
});

test("rejects explicitly selected .env-prefixed credentials", async t => {
  const f = fixture(t);
  for (const name of [".envrc", ".env-production"]) {
    const filename = path.join(f.target, name);
    writeFileSync(filename, "fixture credential");
    await assert.rejects(publishVercel(filename, { environment: f.environment }), { code: "INVALID_TARGET" });
  }
  assert.deepEqual(f.calls(), []);
});

test("rejects excluded directories selected as the deployment root", async t => {
  const f = fixture(t);
  for (const name of [".aws", ".ssh", ".vercel", ".envrc", "node_modules", ".git"]) {
    const directory = path.join(f.target, name);
    mkdirSync(directory);
    writeFileSync(path.join(directory, "credentials"), "fixture credential");
    for (const dryRun of [false, true]) {
      await assert.rejects(publishVercel(directory, { dryRun, environment: f.environment }), { code: "INVALID_TARGET" });
      await assert.rejects(publishVercel(path.join(directory, "credentials"), { dryRun, environment: f.environment }), { code: "INVALID_TARGET" });
    }
  }
  assert.deepEqual(f.calls(), []);
});

test("parent cancellation terminates the detached deploy and removes credential staging", { timeout: 15_000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX process-group cancellation");
  const f = fixture(t, "slow");
  writeFileSync(path.join(f.target, "index.html"), "hello");
  const cli = new URL("../bin/giveurl.js", import.meta.url);
  const child = spawn(process.execPath, [cli.pathname, f.target, "--provider", "vercel", "--json"], { env: f.environment });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 100 && f.calls().length === 0; attempt++) await delay(30);
  const [call] = f.calls();
  assert.ok(call, "deployment process started");
  t.after(() => { try { process.kill(call.pid, "SIGKILL"); } catch {} });
  child.kill("SIGINT");
  const outcome = await completed;
  assert.equal(outcome.code, 1);
  assert.equal(outcome.signal, null);
  assert.match(stderr, /cancelled/);
  assert.equal(existsSync(call.args[1]), false);
  assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
});

test("rejects services, secret targets, nested symlinks, and outdated CLIs before mutation", async t => {
  const f = fixture(t);
  await assert.rejects(publishVercel("3000", { environment: f.environment }), { code: "INVALID_TARGET" });
  const secret = path.join(f.target, ".env");
  writeFileSync(secret, "fixture");
  await assert.rejects(publishVercel(secret, { environment: f.environment }), { code: "INVALID_TARGET" });
  symlinkSync(secret, path.join(f.target, "linked.txt"));
  await assert.rejects(publishVercel(f.target, { environment: f.environment }), { code: "INVALID_TARGET" });
  const old = fixture(t, "old");
  writeFileSync(path.join(old.target, "index.html"), "hello");
  await assert.rejects(publishVercel(old.target, { environment: old.environment }), { code: "PROVIDER_UNAVAILABLE" });
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(old.calls(), []);
});

for (const mode of ["failure", "invalid", "authenticated", "login", "spoofed"]) {
  test(`cleans staging after ${mode} and refuses login or ordinary deployments`, async t => {
    const f = fixture(t, mode);
    writeFileSync(path.join(f.target, "index.html"), "hello");
    await assert.rejects(publishVercel(f.target, { environment: f.environment }), {
      code: mode === "failure" ? "PROVIDER_COMMAND_FAILED" : mode === "login" ? "PROVIDER_UNAVAILABLE" : "PROVIDER_INVALID_RESPONSE",
    });
    assert.equal(existsSync(f.calls()[0].args[1]), false);
  });
}

test("accepts native Vercel temporary domains and routes their lifecycle correctly", async t => {
  const f = fixture(t, "native");
  writeFileSync(path.join(f.target, "index.html"), "hello");
  const result = await publishVercel(f.target, { environment: f.environment });
  assert.equal(result.url, "https://temporary-example.tmp.now/");
  assert.equal(result.previewUrl, "https://temporary-example.tmp.now");
  const cli = new URL("../bin/giveurl.js", import.meta.url);
  const stop = spawnSync(process.execPath, [cli.pathname, "stop", result.url, "--json"], { env: f.environment, encoding: "utf8" });
  assert.equal(JSON.parse(stop.stderr).error.code, "PROVIDER_UNSUPPORTED_ACTION");
});

test("CLI supports explicit Vercel, preserves URL stdout, and never selects public temporary deploys automatically", t => {
  const f = fixture(t);
  writeFileSync(path.join(f.target, "index.html"), "hello");
  const cli = new URL("../bin/giveurl.js", import.meta.url);
  for (const json of [false, true]) {
    const result = spawnSync(process.execPath, [cli.pathname, f.target, "--provider", "vercel", ...(json ? ["--json"] : [])], {
      env: f.environment, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    if (json) assert.equal(JSON.parse(result.stdout).provider, "vercel");
    else {
      assert.equal(result.stdout, "https://temporary-example.vercel.app/\n");
      assert.match(result.stderr, /Expires:/);
      assert.match(result.stderr, /Claim/);
      assert.doesNotMatch(result.stderr, /Stop with: null/);
    }
  }
  const auto = spawnSync(process.execPath, [cli.pathname, f.target, "--json"], { env: f.environment, encoding: "utf8" });
  assert.equal(auto.status, 1);
  assert.equal(JSON.parse(auto.stderr).error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(f.calls().length, 2);
  const stop = spawnSync(process.execPath, [cli.pathname, "stop", "https://temporary-example.vercel.app/", "--json"], { env: f.environment, encoding: "utf8" });
  assert.equal(JSON.parse(stop.stderr).error.code, "PROVIDER_UNSUPPORTED_ACTION");
  const status = spawnSync(process.execPath, [cli.pathname, "status", "--provider", "vercel", "--json"], { env: f.environment, encoding: "utf8" });
  assert.equal(JSON.parse(status.stderr).error.code, "PROVIDER_UNSUPPORTED_ACTION");
});

test("temporary lifecycle points to expiry and claim instead of pretending deletion is available", () => {
  assert.throws(statusVercel, { code: "PROVIDER_UNSUPPORTED_ACTION" });
  assert.throws(stopVercel, { code: "PROVIDER_UNSUPPORTED_ACTION" });
});
