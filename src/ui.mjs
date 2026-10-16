// Local review page for Stashpad: waiting memories, search and the audit log, in a browser.
// Safety: it listens on 127.0.0.1 only, answers only to localhost host names, and every API
// call needs a token that is made for each start and given only to the page it serves.
// The page shows stored text as text, never as HTML, and sends a strict Content-Security-Policy.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  StoreError,
  acceptPending,
  listMemories,
  listPending,
  readAudit,
  readPending,
  rejectPending,
  searchMemories,
} from "./store.mjs";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const ASSETS = {
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const MAX_BODY_BYTES = 64 * 1024;
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function hostAllowed(req, port) {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function originAllowed(origin, port) {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new StoreError("the request is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
        resolve(value);
      } catch {
        reject(new StoreError("the request must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new StoreError(`${name} is needed`);
  return value.trim();
}

async function api(req, res, url, dir) {
  if (req.method === "GET") {
    if (url.pathname === "/api/pending") {
      const { rows, skipped } = listPending(dir);
      return sendJson(res, 200, { rows, skipped });
    }
    if (url.pathname.startsWith("/api/pending/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/pending/".length));
      return sendJson(res, 200, readPending(dir, id));
    }
    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query === "") {
        const { rows } = listMemories(dir);
        return sendJson(res, 200, { mode: "list", results: rows });
      }
      const { total, results } = searchMemories(dir, query, { limit: 20 });
      return sendJson(res, 200, { mode: "search", total, results });
    }
    if (url.pathname === "/api/audit") {
      return sendJson(res, 200, { entries: readAudit(dir, 50) });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  if (req.method === "POST") {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return sendJson(res, 415, { error: "send the request as JSON" });
    }
    const body = await readJson(req);
    if (url.pathname === "/api/accept") {
      const id = requireText(body.id, "id");
      acceptPending(dir, id);
      const message = id.startsWith("forget-")
        ? `Beëindigd: ${id.slice("forget-".length)}. Het blijft in de store met een einddatum.`
        : `Geaccepteerd: ${id}.`;
      return sendJson(res, 200, { message });
    }
    if (url.pathname === "/api/reject") {
      const id = requireText(body.id, "id");
      const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : null;
      rejectPending(dir, id, reason);
      return sendJson(res, 200, { message: `Afgewezen: ${id}. Bewaard in het logboek.` });
    }
  }
  return sendJson(res, 404, { error: "not found" });
}

async function handle(req, res, ctx) {
  const port = ctx.port();
  if (!hostAllowed(req, port)) return sendJson(res, 403, { error: "Open this page from localhost." });

  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, "text/html; charset=utf-8", ctx.page);
  }
  if (req.method === "GET" && ASSETS[url.pathname]) {
    const [file, type] = ASSETS[url.pathname];
    return send(res, 200, type, readFileSync(`${UI_DIR}${file}`, "utf8"));
  }
  if (!url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

  if (req.headers["x-stashpad-token"] !== ctx.token) {
    return sendJson(res, 403, { error: "The page has expired. Reload it, or restart stashpad ui." });
  }
  if (!originAllowed(req.headers.origin, port)) return sendJson(res, 403, { error: "This origin is not allowed." });

  try {
    return await api(req, res, url, ctx.dir);
  } catch (error) {
    if (error instanceof StoreError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

// Starts the page on 127.0.0.1. Port 0 picks any free port (used by the tests).
export function startUi({ dir, port = 4317 }) {
  const token = randomBytes(16).toString("hex");
  const page = readFileSync(`${UI_DIR}index.html`, "utf8").replace("__TOKEN__", token);
  const ctx = { dir, token, page, port: () => server.address().port };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch(() => sendJson(res, 500, { error: "Unexpected problem. Check the terminal." }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        token,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

// Opens the link in the default browser on Windows, macOS or Linux. Failure is ignored: the link is printed anyway.
export function openInBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}
