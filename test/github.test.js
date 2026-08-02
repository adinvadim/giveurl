import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GITHUB_DESCRIPTION_PREFIX,
  publishGitHub,
  statusGitHub,
  stopGitHub,
} from "../src/providers/github.js";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-github-test-"));
  const executable = path.join(directory, "gh");
  const log = path.join(directory, "gh.log");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = { args, host: process.env.GH_HOST };
if (args.includes("--input") && args[args.indexOf("--input") + 1] === "-") {
  record.input = fs.readFileSync(0, "utf8");
}
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(record) + "\\n");
if (process.env.GH_HOST !== "github.com") {
  process.stderr.write("wrong GitHub host");
  process.exit(8);
}
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("octocat\\n");
  process.exit(0);
}
const description = process.env.FAKE_GH_DESCRIPTION || "${GITHUB_DESCRIPTION_PREFIX}artifact.md";
const gist = {
  id: "abc123",
  pageUrl: "https://gist.github.com/octocat/abc123",
  description,
  public: false,
  owner: "octocat",
  files: [{ filename: "artifact.md", rawUrl: "https://gist.githubusercontent.com/octocat/abc123/raw/revision/artifact.md" }],
};
if (args[0] === "api" && args.includes("--paginate")) {
  process.stdout.write(JSON.stringify(gist) + "\\n");
  process.exit(0);
}
if (args[0] === "api" && args.some((arg) => arg === "gists/abc123")) {
  process.stdout.write(JSON.stringify(gist));
  process.exit(0);
}
if (args[0] === "api" && args.includes("POST") && args.includes("gists")) {
  process.stdout.write(JSON.stringify(gist));
  process.exit(0);
}
if (args[0] === "gist" && args[1] === "delete") process.exit(0);
process.stderr.write("unexpected gh invocation: " + args.join(" "));
process.exit(9);
`);
  chmodSync(executable, 0o755);
  const environment = {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_LOG: log,
    GH_HOST: "enterprise.example.com",
  };
  return { directory, environment, log };
}

function records(log) {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("publishes a UTF-8 file as a secret Gist raw URL", async () => {
  const { directory, environment, log } = fixture();
  const target = path.join(directory, "report.md");
  writeFileSync(target, "hello from giveurl\n");

  try {
    const result = await publishGitHub(target, { environment });
    assert.equal(result.provider, "github");
    assert.equal(result.visibility, "secret");
    assert.equal(result.filename, "artifact.md");
    assert.equal(result.url, "https://gist.githubusercontent.com/octocat/abc123/raw/revision/artifact.md");

    const publish = records(log).find((record) => record.args.includes("POST"));
    const payload = JSON.parse(publish.input);
    assert.equal(payload.public, false);
    assert.equal(payload.description, `${GITHUB_DESCRIPTION_PREFIX}artifact.md`);
    assert.deepEqual(payload.files, { "artifact.md": { content: "hello from giveurl\n" } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lists and deletes only giveurl-owned Gists", () => {
  const { directory, environment, log } = fixture();

  try {
    assert.deepEqual(statusGitHub({ environment }), [{
      provider: "github",
      owner: "octocat",
      id: "abc123",
      filename: "artifact.md",
      url: "https://gist.githubusercontent.com/octocat/abc123/raw/revision/artifact.md",
      pageUrl: "https://gist.github.com/octocat/abc123",
    }]);

    const result = stopGitHub("https://gist.githubusercontent.com/octocat/abc123/raw/revision/artifact.md", {
      environment,
    });
    assert.equal(result.stopped, true);
    assert.ok(records(log).some((record) => (
      record.args[0] === "gist" && record.args[1] === "delete" && record.args.includes("--yes")
    )));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses a modified raw Gist URL", () => {
  const { directory, environment, log } = fixture();

  try {
    assert.throws(
      () => stopGitHub("https://gist.githubusercontent.com/octocat/abc123/raw/revision/other.md", { environment }),
      (error) => error.code === "INVALID_SHARE" && /unmodified/.test(error.message),
    );
    assert.ok(!records(log).some((record) => record.args[0] === "gist" && record.args[1] === "delete"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to delete a Gist without the giveurl marker", () => {
  const { directory, environment, log } = fixture();
  environment.FAKE_GH_DESCRIPTION = "personal notes";

  try {
    assert.throws(
      () => stopGitHub("https://gist.github.com/octocat/abc123", { environment }),
      (error) => error.code === "INVALID_SHARE" && /not created by giveurl/.test(error.message),
    );
    assert.ok(!records(log).some((record) => record.args[0] === "gist" && record.args[1] === "delete"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects binary files before creating a Gist", async () => {
  const { directory, environment, log } = fixture();
  const target = path.join(directory, "artifact.bin");
  writeFileSync(target, Buffer.from([0xff, 0x00, 0x01]));

  try {
    await assert.rejects(
      publishGitHub(target, { environment }),
      (error) => error.code === "INVALID_TARGET" && /UTF-8 text files/.test(error.message),
    );
    assert.ok(!records(log).some((record) => record.args.includes("POST")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
