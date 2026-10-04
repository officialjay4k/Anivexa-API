import "dotenv/config";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";

const PORT  = Number(process.env.PORT) || 4000;
const BASE  = process.env.BASE_PATH ?? "";
const __dir = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/":           { file: "docs/landing.html", mime: "text/html" },
  "/docs":       { file: "docs/index.html",   mime: "text/html" },
  "/style.css":  { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":   { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

function serveStatic(res, entry) {
  try {
    const body = readFileSync(join(__dir, entry.file));
    res.writeHead(200, {
      "Content-Type":  entry.mime + "; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}
// notation //
async function handleFlixProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const key = parsedUrl.searchParams.get("key");

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("Missing URL");
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://flixcloud.cc/",
        "Origin": "https://flixcloud.cc"
      }
    });

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    if (key) {
      const raw = bodyBuffer.toString("utf8").trim();
      if (!raw.startsWith("#EXTM3U")) {
        const decKey = Buffer.from(key, "base64");
        const payload = Buffer.from(raw, "base64");
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i] ^ decKey[i % decKey.length];
        }
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/vnd.apple.mpegurl"
        });
        return res.end(out);
      }
    }

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/vnd.apple.mpegurl"
    });
    res.end(bodyBuffer);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    res.end("Proxy error: " + err.message);
  }
}

async function nodeToRequest(req) {
  const host     = req.headers["host"] ?? "localhost:" + PORT;
  const stripped = BASE && req.url.startsWith(BASE) ? req.url.slice(BASE.length) || "/" : req.url;
  const url      = "http://" + host + stripped;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method:  req.method,
    headers: req.headers,
    body:    body?.length ? body : undefined,
    duplex:  "half",
  });
}

const server = http.createServer(async (req, res) => {
  console.log("→ " + req.method + " " + req.url);

  const host = req.headers["host"] ?? "localhost:" + PORT;
  const parsedUrl = new URL(req.url, "http://" + host);
  const pathname = parsedUrl.pathname;

  const staticEntry = STATIC[pathname];

  if (req.method === "GET" && staticEntry) {
    return serveStatic(res, staticEntry);
  }

  if (req.method === "GET" && pathname === "/proxy/flix-stream") {
    return handleFlixProxy(req, res, parsedUrl);
  }

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log("Anivexa dev server → http://localhost:" + PORT);
});
