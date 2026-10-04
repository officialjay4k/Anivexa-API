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
  "/":          { file: "docs/landing.html", mime: "text/html" },
  "/docs":      { file: "docs/index.html",   mime: "text/html" },
  "/style.css": { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

function serveStatic(res, entry) {
  try {
    const body = readFileSync(join(__dir, entry.file));
    res.writeHead(200, {
      "Content-Type":  entry.mime + "; charset=utf-8",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("Not found");
  }
}

function decodeIfEncrypted(raw, key) {
  if (!key) return raw;
  if (raw.startsWith("#EXTM3U")) return raw;
  try {
    const decKey  = Buffer.from(key, "base64");
    const payload = Buffer.from(raw, "base64");
    const out     = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      out[i] = payload[i] ^ decKey[i % decKey.length];
    }
    return out.toString("utf8");
  } catch {
    return raw;
  }
}

async function fetchUpstream(url) {
  return await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://flixcloud.cc/",
      "Origin":  "https://flixcloud.cc"
    }
  });
}

// Check whether a buffer looks like a raw MPEG-TS stream.
// MPEG-TS is packetized in 188-byte chunks, each starting with 0x47.
function looksLikeTs(buf) {
  if (buf.length < 376) return false;                 // need at least 2 packets
  if (buf[0] !== 0x47) return false;
  if (buf[188] !== 0x47) return false;
  if (buf.length >= 564 && buf[376] !== 0x47) return false;
  return true;
}

function xorBuffer(buf, key) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    out[i] ^= key[i % key.length];
  }
  return out;
}

function transformSegmentBuffer(bodyBuffer) {
  // Step 1: detect and strip a fake image header if present.
  const isWebp = bodyBuffer.length > 12 &&
    bodyBuffer[0] === 0x52 && bodyBuffer[1] === 0x49 &&
    bodyBuffer[2] === 0x46 && bodyBuffer[3] === 0x46 &&
    bodyBuffer[8] === 0x57 && bodyBuffer[9] === 0x45 &&
    bodyBuffer[10] === 0x42 && bodyBuffer[11] === 0x50;

  const isPng = bodyBuffer.length > 8 &&
    bodyBuffer[0] === 0x89 && bodyBuffer[1] === 0x50 &&
    bodyBuffer[2] === 0x4e && bodyBuffer[3] === 0x47 &&
    bodyBuffer[4] === 0x0d && bodyBuffer[5] === 0x0a &&
    bodyBuffer[6] === 0x1a && bodyBuffer[7] === 0x0a;

  let offset = 0;
  if (isWebp) offset = 12;
  else if (isPng) offset = 8;

  const sliced = bodyBuffer.subarray(offset);

  // Step 2: try raw first — if it already looks like TS, ship it.
  if (looksLikeTs(sliced)) {
    return { buffer: sliced, mode: "raw" };
  }

  // Step 3: try XOR — this is what most segments will need.
  const xored = xorBuffer(sliced, flixImageSegmentXorKey);
  if (looksLikeTs(xored)) {
    return { buffer: xored, mode: "xor" };
  }

  // Step 4: neither validated. Pick whichever has more 0x47 at packet
  // boundaries (weak heuristic) so we at least send hls.js something
  // plausible and let it try.
  const sliceScore = scoreTs(sliced);
  const xorScore   = scoreTs(xored);
  if (xorScore >= sliceScore) {
    return { buffer: xored, mode: "xor-fallback" };
  }
  return { buffer: sliced, mode: "raw-fallback" };
}

// Count 0x47 sync bytes at 188-byte boundaries. Used only to break ties.
function scoreTs(buf) {
  let hits = 0;
  for (let i = 0; i < buf.length && i < 188 * 20; i += 188) {
    if (buf[i] === 0x47) hits++;
  }
  return hits;
}

async function handleFlixProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const key       = parsedUrl.searchParams.get("key");
  const isSegment = parsedUrl.searchParams.get("type") === "segment";

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("Missing URL");
  }

  try {
    const response = await fetchUpstream(targetUrl);

    if (!response.ok) {
      res.writeHead(response.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream HTTP error: ${response.status}`);
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    if (isSegment) {
      const { buffer: out, mode } = transformSegmentBuffer(bodyBuffer);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "video/mp2t",
        "X-Segment-Mode": mode,
        "X-Segment-Bytes-In":  String(bodyBuffer.length),
        "X-Segment-Bytes-Out": String(out.length)
      });
      return res.end(out);
    }

    const text = decodeIfEncrypted(bodyBuffer.toString("utf8").trim(), key);

    const host      = req.headers["host"] ?? "localhost:" + PORT;
    const protocol  = req.headers["x-forwarded-proto"] || "http";
    const proxyBase = protocol + "://" + host + "/proxy/flix-stream";

    const buildProxyUrl = (absUrl, type) => {
      let u = proxyBase + "?url=" + encodeURIComponent(absUrl);
      if (key) u += "&key=" + encodeURIComponent(key);
      if (type) u += "&type=" + type;
      return u;
    };

    const isMaster = text.includes("#EXT-X-STREAM-INF");

    const rewritten = text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        const uriMatch = trimmed.match(/URI="([^"]+)"/);
        if (!uriMatch) return line;

        const originalUri = uriMatch[1];
        const absUrl      = new URL(originalUri, targetUrl).toString();

        let type = null;
        if (trimmed.startsWith("#EXT-X-KEY")) type = "segment";
        else if (trimmed.startsWith("#EXT-X-MAP")) type = "segment";

        const newUri = buildProxyUrl(absUrl, type);
        return line.replace(`URI="${originalUri}"`, `URI="${newUri}"`);
      }

      const absUrl = new URL(trimmed, targetUrl).toString();
      const type   = isMaster ? null : "segment";
      return buildProxyUrl(absUrl, type);
    }).join("\n");

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/vnd.apple.mpegurl"
    });
    return res.end(rewritten);
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const host = req.headers["host"] ?? "localhost:" + PORT;
  const parsedUrl = new URL(req.url, "http://" + host);
  const pathname  = parsedUrl.pathname;

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
    res.setHeader("Access-Control-Allow-Origin", "*");

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    res.writeHead(500, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify({ error: "Worker crash: " + err.message }));
  }
});

server.listen(PORT, () => {
  console.log("Anivexa dev server → http://localhost:" + PORT);
});
