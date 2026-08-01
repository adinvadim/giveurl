#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "bin", "giveurl.js");

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const receiver = option("--receiver") ?? process.env.GIVEURL_RECEIVER ?? null;
const sshReceiver = option("--receiver-ssh") ?? process.env.GIVEURL_RECEIVER_SSH ?? null;
const sshIdentity = option("--identity") ?? process.env.GIVEURL_RECEIVER_IDENTITY ?? null;
const resolveSource = process.argv.includes("--resolve-source");
const workspace = mkdtempSync(path.join(tmpdir(), "giveurl-smoke-"));
const activeUrls = new Set();
const servers = [];
let curlResolve = null;

function run(command, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout);
      const diagnostics = Buffer.concat(stderr).toString("utf8").trim();
      if (exitCode === 0) resolve(output);
      else {
        reject(new Error(
          command + " " + args.join(" ") + " failed (" + (signal ?? exitCode) + "): " + diagnostics,
        ));
      }
    });
  });
}

async function giveurl(args) {
  const output = await run(process.execPath, [CLI, ...args, "--json"]);
  return JSON.parse(output.toString("utf8"));
}

async function remoteCurl(args, url) {
  if (sshReceiver) {
    const sshArgs = [
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
    ];
    if (sshIdentity) sshArgs.push("-i", sshIdentity);
    const resolveArgs = curlResolve ? ["--resolve", curlResolve] : [];
    return run("ssh", [...sshArgs, sshReceiver, "curl", ...resolveArgs, ...args, url], { timeout: 45_000 });
  }
  if (receiver) {
    const resolveArgs = curlResolve ? ["--resolve", curlResolve] : [];
    return run("tailscale", ["ssh", receiver, "curl", ...resolveArgs, ...args, url], { timeout: 45_000 });
  }
  return run("curl", [...args, url], { timeout: 45_000 });
}

async function publish(target) {
  const result = await giveurl([target]);
  activeUrls.add(result.url);
  return result.url;
}

function shareKey(rawUrl) {
  const parsed = new URL(rawUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return parsed.origin + "/" + segments.slice(0, 2).join("/");
}

async function stop(url) {
  await giveurl(["stop", url]);
  const stoppedKey = shareKey(url);
  for (const activeUrl of activeUrls) {
    if (shareKey(activeUrl) === stoppedKey) activeUrls.delete(activeUrl);
  }
}

function headerValue(headers, name) {
  const prefix = name.toLowerCase() + ":";
  return headers
    .toString("utf8")
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function buffer(value, encoding) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
}

const fixtures = [
  ["style.css", "body { color: #123; }\n", "text/css; charset=utf-8"],
  ["pixel.gif", "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "image/gif", "hex"],
  ["page.htm", "<!doctype html><title>htm</title>", "text/html; charset=utf-8"],
  ["page.html", "<!doctype html><title>html</title>", "text/html; charset=utf-8"],
  ["favicon.ico", "00000100010001010000010020003000000016000000", "image/x-icon", "hex"],
  ["photo.jpeg", "ffd8ffe000104a46494600010100000100010000ffd9", "image/jpeg", "hex"],
  ["photo.jpg", "ffd8ffe000104a46494600010100000100010000ffd9", "image/jpeg", "hex"],
  ["app.js", "export const answer = 42;\n", "text/javascript; charset=utf-8"],
  ["data.json", "{\"ok\":true}\n", "application/json; charset=utf-8"],
  ["handoff.md", "# Handoff\n\nReady.\n", "text/markdown; charset=utf-8"],
  ["document.pdf", "%PDF-1.4\n%%EOF\n", "application/pdf"],
  ["pixel.png", "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082", "image/png", "hex"],
  ["icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>", "image/svg+xml; charset=utf-8"],
  ["note.txt", "plain text\n", "text/plain; charset=utf-8"],
  ["pixel.webp", "5249464612000000574542505650382006000000100000000000", "image/webp", "hex"],
  ["feed.xml", "<?xml version=\"1.0\"?><ok/>", "application/xml; charset=utf-8"],
  ["archive.zip", "504b0506000000000000000000000000000000000000", "application/zip", "hex"],
  ["opaque.bin", "00010203feff", "application/octet-stream", "hex"],
  ["empty.txt", Buffer.alloc(0), "text/plain; charset=utf-8"],
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function serveStatus() {
  const output = await run("tailscale", ["serve", "status", "--json"]);
  return JSON.stringify(canonical(JSON.parse(output.toString("utf8"))));
}

async function configureSourceResolve() {
  if (!resolveSource) return;
  const output = await run("tailscale", ["status", "--json"]);
  const status = JSON.parse(output.toString("utf8"));
  const dnsName = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  const address = status.Self?.TailscaleIPs?.find((candidate) => candidate.includes("."));
  if (!dnsName || !address) throw new Error("source node has no MagicDNS name or IPv4 Tailscale address");
  curlResolve = dnsName + ":443:" + address;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function assertRemoteFile(url, expected, contentType) {
  const received = await remoteCurl(["-fsSL", "--max-time", "20"], url);
  if (!received.equals(expected)) throw new Error("byte mismatch for " + url);
  const headers = await remoteCurl(["-fsSI", "--max-time", "20"], url);
  const receivedType = headerValue(headers, "content-type");
  if (receivedType !== contentType) {
    throw new Error(
      "content-type mismatch for " + url + ": expected " + contentType + ", received " + receivedType,
    );
  }
}

async function main() {
  await configureSourceResolve();
  const originalServeStatus = await serveStatus();
  let checks = 0;
  let completed = false;
  console.log("receiver: " + (sshReceiver ?? receiver ?? "local machine"));
  if (curlResolve) console.log("receiver DNS override: " + curlResolve);

  try {
    for (const [name, value, contentType, encoding] of fixtures) {
      const filename = path.join(workspace, name);
      const expected = buffer(value, encoding);
      writeFileSync(filename, expected);
      const url = await publish(filename);
      await assertRemoteFile(url, expected, contentType);
      if (name === "handoff.md") {
        const code = (await remoteCurl(
          ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--range", "0-0"],
          url,
        )).toString("utf8");
        if (code !== "206") throw new Error("range request returned " + code + ", expected 206");
      }
      await stop(url);
      checks += 1;
      console.log("ok file " + name);
    }

    const site = path.join(workspace, "site");
    mkdirSync(path.join(site, "assets"), { recursive: true });
    const index = Buffer.from("<!doctype html><link rel=\"stylesheet\" href=\"assets/style.css\"><h1>Smoke</h1>");
    const style = Buffer.from("h1 { color: rebeccapurple; }\n");
    writeFileSync(path.join(site, "index.html"), index);
    writeFileSync(path.join(site, "assets", "style.css"), style);
    const directoryUrl = await publish(site);
    await assertRemoteFile(directoryUrl, index, "text/html; charset=utf-8");
    await assertRemoteFile(directoryUrl + "assets/style.css", style, "text/css; charset=utf-8");
    await stop(directoryUrl + "assets/style.css");
    checks += 2;
    console.log("ok directory index + nested asset + nested-url stop");

    const listingDirectory = path.join(workspace, "listing");
    mkdirSync(listingDirectory);
    writeFileSync(path.join(listingDirectory, "visible.txt"), "visible\n");
    const listingUrl = await publish(listingDirectory);
    const listing = (await remoteCurl(
      ["-fsSL", "--max-time", "20"],
      listingUrl,
    )).toString("utf8");
    if (!listing.includes("visible.txt")) throw new Error("directory listing omitted visible.txt");
    await stop(listingUrl);
    checks += 1;
    console.log("ok directory listing");

    const first = path.join(workspace, "concurrent-one.txt");
    const second = path.join(workspace, "concurrent-two.txt");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");
    const firstUrl = await publish(first);
    const secondUrl = await publish(second);
    await assertRemoteFile(firstUrl, Buffer.from("one\n"), "text/plain; charset=utf-8");
    await assertRemoteFile(secondUrl, Buffer.from("two\n"), "text/plain; charset=utf-8");
    await stop(firstUrl);
    await stop(secondUrl);
    checks += 2;
    console.log("ok concurrent shares");

    const httpServer = createHttpServer((request, response) => {
      const body = "http-service:" + request.url;
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    servers.push(httpServer);
    const httpPort = await listen(httpServer);

    const portUrl = await publish(String(httpPort));
    const portBody = await remoteCurl(["-fsSL", "--max-time", "20"], portUrl);
    if (portBody.toString("utf8") !== "http-service:/") {
      throw new Error("unexpected port proxy body: " + portBody);
    }
    await stop(portUrl);
    checks += 1;
    console.log("ok localhost port service");

    const localUrl = await publish("http://127.0.0.1:" + httpPort);
    const localBody = await remoteCurl(["-fsSL", "--max-time", "20"], localUrl);
    if (localBody.toString("utf8") !== "http-service:/") {
      throw new Error("unexpected localhost proxy body: " + localBody);
    }
    await stop(localUrl);
    checks += 1;
    console.log("ok localhost URL service");

    const key = path.join(workspace, "key.pem");
    const certificate = path.join(workspace, "certificate.pem");
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", certificate,
      "-subj", "/CN=localhost", "-days", "1",
    ]);
    const httpsServer = createHttpsServer(
      { key: readFileSync(key), cert: readFileSync(certificate) },
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("https-insecure-service");
      },
    );
    servers.push(httpsServer);
    const httpsPort = await listen(httpsServer);
    const insecureUrl = await publish("https+insecure://localhost:" + httpsPort);
    const insecureBody = await remoteCurl(["-fsSL", "--max-time", "20"], insecureUrl);
    if (insecureBody.toString("utf8") !== "https-insecure-service") {
      throw new Error("unexpected https+insecure proxy body");
    }
    await stop(insecureUrl);
    checks += 1;
    console.log("ok https+insecure localhost service");

    const finalServeStatus = await serveStatus();
    if (finalServeStatus !== originalServeStatus) {
      throw new Error("Tailscale Serve configuration was not restored");
    }
    const status = await giveurl(["status"]);
    if (status.shares.length !== 0) {
      throw new Error(status.shares.length + " giveurl shares remained after cleanup");
    }
    if (activeUrls.size !== 0) throw new Error(activeUrls.size + " shares remained in cleanup tracking");
    console.log("smoke passed: " + checks + " checks");
    completed = true;
  } finally {
    const cleanupFailures = [];
    for (const url of [...activeUrls].reverse()) {
      try {
        await stop(url);
      } catch (error) {
        cleanupFailures.push("cleanup failed for " + url + ": " + error.message);
      }
    }
    for (const server of servers) await close(server);
    rmSync(workspace, { recursive: true, force: true });
    if (completed && cleanupFailures.length > 0) throw new Error(cleanupFailures.join("\n"));
    for (const failure of cleanupFailures) console.error(failure);
  }
}

await main();
