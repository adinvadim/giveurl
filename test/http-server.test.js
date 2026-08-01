import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { contentTypeFor, createArtifactServer } from "../src/http-server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("serves a shared file with its content type", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-http-test-"));
  const target = path.join(directory, "note.md");
  writeFileSync(target, "# hello\n");
  const server = createArtifactServer({ target, kind: "file", route: "/giveurl/id/artifact.md" });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/anything`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await response.text(), "# hello\n");

    const range = await fetch(`http://127.0.0.1:${port}/anything`, { headers: { range: "bytes=0-0" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 0-0/8");
    assert.equal(await range.text(), "#");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps every documented file format and falls back for binary data", () => {
  const expected = {
    "file.css": "text/css; charset=utf-8",
    "file.gif": "image/gif",
    "file.htm": "text/html; charset=utf-8",
    "file.html": "text/html; charset=utf-8",
    "file.ico": "image/x-icon",
    "file.jpeg": "image/jpeg",
    "file.jpg": "image/jpeg",
    "file.js": "text/javascript; charset=utf-8",
    "file.json": "application/json; charset=utf-8",
    "file.md": "text/markdown; charset=utf-8",
    "file.pdf": "application/pdf",
    "file.png": "image/png",
    "file.svg": "image/svg+xml; charset=utf-8",
    "file.txt": "text/plain; charset=utf-8",
    "file.webp": "image/webp",
    "file.xml": "application/xml; charset=utf-8",
    "file.zip": "application/zip",
    "file.bin": "application/octet-stream",
  };
  for (const [filename, contentType] of Object.entries(expected)) {
    assert.equal(contentTypeFor(filename), contentType);
  }
});

test("serves an empty file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-http-test-"));
  const target = path.join(directory, "empty.txt");
  writeFileSync(target, "");
  const server = createArtifactServer({ target, kind: "file", route: "/giveurl/id/artifact.txt" });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/artifact.txt`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal(await response.text(), "");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serves directory assets and blocks traversal", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "giveurl-http-test-"));
  const root = path.join(directory, "site");
  mkdirSync(root);
  writeFileSync(path.join(root, "index.html"), "<h1>Hello</h1>");
  writeFileSync(path.join(directory, "secret.txt"), "secret");
  const route = "/giveurl/id/";
  const server = createArtifactServer({ target: root, kind: "directory", route });
  const port = await listen(server);

  try {
    const index = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), "<h1>Hello</h1>");

    const traversal = await fetch(`http://127.0.0.1:${port}${route}%2e%2e/secret.txt`);
    assert.equal(traversal.status, 404);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
