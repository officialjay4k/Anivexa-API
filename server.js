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

// ---------------------------------------------------------------------------
// Segment transform: robust detection + offset scanning.
// ---------------------------------------------------------------------------

// Detect fake image headers and return the offset where the real payload begins.
function detectFakeHeaderOffset(buf) {
  const isWebp = buf.length > 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (isWebp) return 12;

  const isPng = buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  if (isPng) return 8;

  return 0;
}

// Check whether a buffer begins at a valid TS packet boundary.
// Requires at least 2 sync bytes at 188-byte intervals.
function looksLikeTs(buf) {
  if (buf.length < 189) return false;
  if (buf[0] !== 0x47) return false;
  if (buf[188] !== 0x47) return false;
  return true;
}

// Scan the first `maxScan` bytes for a 0x47 that's followed by another 0x47
// at +188. Returns the offset, or -1 if not found.
function findTsStart(buf, maxScan = 64) {
  const limit = Math.min(buf.length - 188, maxScan);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47) return i;
  }
  return -1;
}

function xorBuffer(buf, key) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  return out;
}

function scoreTs(buf) {
  let hits = 0;
  const max = Math.min(buf.length - 188, 188 * 20);
  for (let i = 0; i <= max; i += 188) {
    if (buf[i] === 0x47) hits++;
  }
  return hits;
}

function transformSegmentBuffer(bodyBuffer) {
  // Bail on tiny / empty segments — they're almost always CDN placeholders.
  if (bodyBuffer.length < 200) {
    return { buffer: bodyBuffer, mode: "too-small", upstreamBytes: bodyBuffer.length };
  }

  // Strip any fake image header first.
  const headerOffset = detectFakeHeaderOffset(bodyBuffer);
  const payload = bodyBuffer.subarray(headerOffset);

  // Strategy 1: try raw as-is.
  if (looksLikeTs(payload)) {
    return { buffer: payload, mode: "raw", headerOffset, upstreamBytes: bodyBuffer.length };
  }

  // Strategy 2: try raw but scan for offset (in case there's extra junk).
  const rawScan = findTsStart(payload);
  if (rawScan > 0) {
    const trimmed = payload.subarray(rawScan);
    if (looksLikeTs(trimmed)) {
      return { buffer: trimmed, mode: `raw-scan+${rawScan}`, headerOffset, upstreamBytes: bodyBuffer.length };
    }
  }

  // Strategy 3: XOR the whole payload.
  const xored = xorBuffer(payload, flixImageSegmentXorKey);
  if (looksLikeTs(xored)) {
    return { buffer: xored, mode: "xor", headerOffset, upstreamBytes: bodyBuffer.length };
  }

  // Strategy 4: XOR then scan.
  const xorScan = findTsStart(xored);
  if (xorScan > 0) {
    const trimmed = xored.subarray(xorScan);
    if (looksLikeTs(trimmed)) {
      return { buffer: trimmed, mode: `xor-scan+${xorScan}`, headerOffset, upstreamBytes: bodyBuffer.length };
    }
  }

  // Strategy 5: neither validates. Score both at TS boundaries and pick the
  // one that looks more TS-like. If both score zero, we're lost — return raw
  // so hls.js gets a clean error and retries rather than being fed XOR'd junk.
  const rawScore = scoreTs(payload);
  const xorScore = scoreTs(xored);
  if (rawScore === 0 && xorScore === 0) {
    return { buffer: payload, mode: "raw-fallback-no-sync", headerOffset, upstreamBytes: bodyBuffer.length };
  }
  if (xorScore > rawScore) {
    return { buffer: xored, mode: "xor-fallback", headerOffset, upstreamBytes: bodyBuffer.length };
  }
  return { buffer: payload, mode: "raw-fallback", headerOffset, upstreamBytes: bodyBuffer.length };
}

// ---------------------------------------------------------------------------
// Debug peek: dumps the first N bytes (hex) of an upstream URL for inspection.
// ---------------------------------------------------------------------------

function hexDump(buf, maxBytes = 256) {
  const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
  const lines = [];
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16);
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
    lines.push(`${i.toString(16).padStart(4, "0")}  ${hex.padEnd(48)}  ${ascii}`);
  }
  return lines.join("\n");
}

async function handlePeek(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  if (!targetUrl) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing url");
  }
  try {
    const r = await fetchUpstream(targetUrl);
    if (!r.ok) {
      res.writeHead(r.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream ${r.status}`);
    }
    const body = Buffer.from(await r.arrayBuffer());

    const isWebp = body.length > 12 && body[0] === 0x52 && body[8] === 0x57;
    const isPng = body.length > 8 && body[0] === 0x89 && body[1] === 0x50;
    const headerOffset = detectFakeHeaderOffset(body);
    const payload = body.subarray(headerOffset);
    const xored = xorBuffer(payload, flixImageSegmentXorKey);

    const report = [
      `URL: ${targetUrl}`,
      `Upstream status: ${r.status}`,
      `Upstream Content-Type: ${r.headers.get("content-type") || "(none)"}`,
      `Upstream Content-Length: ${r.headers.get("content-length") || "(none)"}`,
      `Bytes received: ${body.length}`,
      `Detected WebP: ${isWebp}`,
      `Detected PNG: ${isPng}`,
      `Header offset: ${headerOffset}`,
      `Payload length after header strip: ${payload.length}`,
      `Payload looksLikeTs (raw): ${looksLikeTs(payload)}`,
      `Payload looksLikeTs (xor): ${looksLikeTs(xored)}`,
      `findTsStart(raw) first 64 bytes: ${findTsStart(payload)}`,
      `findTsStart(xor) first 64 bytes: ${findTsStart(xored)}`,
      ``,
      `--- First 256 bytes of UPSTREAM RAW ---`,
      hexDump(body, 256),
      ``,
      `--- First 256 bytes AFTER header strip ---`,
      hexDump(payload, 256),
    ].join("\n");

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(report);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    res.end("Peek error: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Playlist + segment proxy (main path).
// ---------------------------------------------------------------------------

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
      const result = transformSegmentBuffer(bodyBuffer);
      console.log(`[seg] mode=${result.mode} header=${result.headerOffset} in=${result.upstreamBytes} out=${result.buffer.length}`);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "video/mp2t",
        "X-Segment-Mode":        result.mode,
        "X-Segment-Header":      String(result.headerOffset),
        "X-Segment-Upstream":    String(result.upstreamBytes),
        "X-Segment-Out":         String(result.buffer.length)
      });
      return res.end(result.buffer);
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

  if (req.method === "GET" && pathname === "/proxy/peek-segment") {
    return handlePeek(req, res, parsedUrl);
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
