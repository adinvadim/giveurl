import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendError(response, statusCode, message) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendFile(request, response, filename) {
  const metadata = statSync(filename);
  const headers = {
    "content-type": MIME_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  let start = 0;
  let end = metadata.size - 1;
  let statusCode = 200;
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && metadata.size > 0) {
    if (!range[1] && range[2]) {
      const suffixLength = Number(range[2]);
      start = Math.max(0, metadata.size - suffixLength);
    } else {
      start = Number(range[1] || 0);
      end = range[2] ? Math.min(Number(range[2]), metadata.size - 1) : metadata.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= metadata.size) {
      response.writeHead(416, { "content-range": `bytes */${metadata.size}` }).end();
      return;
    }
    statusCode = 206;
    headers["content-range"] = `bytes ${start}-${end}/${metadata.size}`;
  }
  headers["content-length"] = Math.max(0, end - start + 1);
  response.writeHead(statusCode, headers);
  if (request.method === "HEAD" || metadata.size === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(filename, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

function sendDirectory(response, directory, requestPath) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const links = entries.map((entry) => {
    const suffix = entry.isDirectory() ? "/" : "";
    return `<li><a href="${encodeURIComponent(entry.name)}${suffix}">${escapeHtml(entry.name)}${suffix}</a></li>`;
  }).join("\n");
  const title = `Index of ${requestPath}`;
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1><ul>${links}</ul>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function safeDirectoryTarget(root, requestPath) {
  const candidate = path.resolve(root, `.${requestPath}`);
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

export function createArtifactServer({ target, kind, route }) {
  const resolvedTarget = realpathSync(target);
  const root = kind === "directory" ? resolvedTarget : path.dirname(resolvedTarget);

  return http.createServer((request, response) => {
    try {
      if (!request.url || !["GET", "HEAD"].includes(request.method ?? "")) {
        sendError(response, 405, "Method not allowed");
        return;
      }

      if (kind === "file") {
        sendFile(request, response, resolvedTarget);
        return;
      }

      let requestPath;
      try {
        requestPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      } catch {
        sendError(response, 400, "Invalid URL");
        return;
      }
      if (requestPath.startsWith(route)) requestPath = requestPath.slice(route.length - 1);
      if (!requestPath.startsWith("/")) requestPath = `/${requestPath}`;

      const resolved = safeDirectoryTarget(root, requestPath);
      if (!resolved) {
        sendError(response, 404, "Not found");
        return;
      }
      const metadata = statSync(resolved);
      if (metadata.isDirectory()) {
        const index = safeDirectoryTarget(root, path.posix.join(requestPath, "index.html"));
        if (index && statSync(index).isFile()) sendFile(request, response, index);
        else if (request.method === "HEAD") response.writeHead(200).end();
        else sendDirectory(response, resolved, requestPath);
        return;
      }
      if (metadata.isFile()) {
        sendFile(request, response, resolved);
        return;
      }
      sendError(response, 404, "Not found");
    } catch {
      if (!response.headersSent) sendError(response, 500, "Could not read artifact");
      else response.destroy();
    }
  });
}
