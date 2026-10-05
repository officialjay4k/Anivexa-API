import "dotenv/config";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";

const PORT  = Number(process.env.PORT) || 4000;
const BASE  = process.env.BASE_PATH ?? "";
const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Static file map (served directly by this Node process)
// ---------------------------------------------------------------------------
const STATIC = {
  "/":          { file: "docs/landing.html", mime: "text/html" },
  "/docs":      { file: "docs/index.html",   mime: "text/html" },
  "/style.css": { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

// ---------------------------------------------------------------------------
// Flixcloud segment XOR key (16 bytes)
// ---------------------------------------------------------------------------
const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

// ---------------------------------------------------------------------------
// Static file server helper
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Manifest decryption: Base64 + repeating-key XOR
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Upstream fetcher — injects Referer/Origin/UA to beat the CDN's gating
// ---------------------------------------------------------------------------
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
// Segment transform: detect fake WebP/PNG headers, strip them, XOR if needed
// ---------------------------------------------------------------------------
function transformSegmentBuffer(bodyBuffer) {
  let offset  = 0;
  let needsXor = false;

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

  if (isWebp)     { offset = 12; needsXor = bodyBuffer[offset] !== 0x47; }
  else if (isPng) { offset = 8;  needsXor = bodyBuffer[offset] !== 0x47; }

  if (offset === 0) return bodyBuffer;

  const out = Buffer.from(bodyBuffer.subarray(offset));
  if (needsXor) {
    for (let i = 0; i < out.length; i++) {
      out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// /proxy/flix-stream — HLS manifest + segment proxy
//
// Tag-aware URI rewriting:
//   - Bare URI lines (variant playlists in a master, segments in a media playlist)
//     get rewritten to go back through this proxy.
//   - URIs inside #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP tags get rewritten too.
//     This is what fixes audio (rendition playlist URIs live inside #EXT-X-MEDIA)
//     and AES keys / fMP4 init maps.
//   - No flattening. The master playlist structure is preserved, so hls.js can
//     pick video + audio renditions naturally.
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

    // ---- Binary payloads (segments, AES keys, fMP4 init maps) ----
    if (isSegment) {
      const out = transformSegmentBuffer(bodyBuffer);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "video/mp2t"
      });
      return res.end(out);
    }

    // ---- Playlist payloads ----
    const text = decodeIfEncrypted(bodyBuffer.toString("utf8").trim(), key);

    const host      = req.headers["host"] ?? "localhost:" + PORT;
    const protocol  = req.headers["x-forwarded-proto"] || "http";
    const proxyBase = protocol + "://" + host + "/proxy/flix-stream";

    const buildProxyUrl = (absUrl, type) => {
      let u = proxyBase + "?url=" + encodeURIComponent(absUrl);
      if (key)  u += "&key=" + encodeURIComponent(key);
      if (type) u += "&type=" + type;
      return u;
    };

    const isMaster = text.includes("#EXT-X-STREAM-INF");

    const rewritten = text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // ---- Tag lines: rewrite URI="..." attribute if present ----
      if (trimmed.startsWith("#")) {
        const uriMatch = trimmed.match(/URI="([^"]+)"/);
        if (!uriMatch) return line;

        const originalUri = uriMatch[1];
        const absUrl      = new URL(originalUri, targetUrl).toString();

        // EXT-X-KEY and EXT-X-MAP point to binary payloads (AES key, init segment).
        // EXT-X-MEDIA and EXT-X-I-FRAME-STREAM-INF point to other playlists.
        let type = null;
        if (trimmed.startsWith("#EXT-X-KEY")) type = "segment";
        else if (trimmed.startsWith("#EXT-X-MAP")) type = "segment";

        const newUri = buildProxyUrl(absUrl, type);
        return line.replace(`URI="${originalUri}"`, `URI="${newUri}"`);
      }

      // ---- Bare URI line: variant playlist (master) or segment (media) ----
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

// ---------------------------------------------------------------------------
// /proxy/subtitle — subtitle pass-through
//
// Why this exists:
//   - Upstream serves .ass as application/octet-stream with no CORS header.
//   - libass / native <track> both want text/* + CORS.
//   - Same Referer/Origin injection as the video proxy, in case some CDN
//     nodes are stricter about subs than manifests.
//   - No XOR, no header stripping — bytes pass through untouched.
// ---------------------------------------------------------------------------
async function handleSubtitleProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");

  if (!targetUrl) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing url");
  }

  try {
    const r = await fetchUpstream(targetUrl);

    if (!r.ok) {
      res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" });
      return res.end("Upstream " + r.status);
    }

    const body = Buffer.from(await r.arrayBuffer());

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    });
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Subtitle proxy error: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// /proxy/reanime-static — pass-through for Reanime's self-hosted libass assets
//
// Reanime hosts its SubtitlesOctopus worker + WASM at:
//   https://flixcloud.cc/artplayer-new/subtitles-octopus-worker.js
//   https://flixcloud.cc/artplayer-new/subtitles-octopus-worker.wasm
// Both are cross-origin and Referer-gated. We proxy them here so the browser
// can load them as same-origin assets (and so we can serve wasm with the
// correct Content-Type).
//
// Usage: /proxy/reanime-static?path=subtitles-octopus-worker.js?v=1
// ---------------------------------------------------------------------------
async function handleReanimeStaticProxy(req, res, parsedUrl) {
  const subPath = parsedUrl.searchParams.get("path");

  if (!subPath) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing path");
  }

  // Guard: only allow files under artplayer-new/, no path traversal.
  const safePath = subPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const targetUrl = "https://flixcloud.cc/artplayer-new/" + safePath;

  try {
    const r = await fetchUpstream(targetUrl);

    if (!r.ok) {
      res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" });
      return res.end("Upstream " + r.status);
    }

    const buf    = Buffer.from(await r.arrayBuffer());
    const isWasm = safePath.endsWith(".wasm") || safePath.includes(".wasm?");

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": isWasm ? "application/wasm" : "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    });
    return res.end(buf);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Reanime static proxy error: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Node req -> Fetch API Request (for handing off to the Worker)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const host      = req.headers["host"] ?? "localhost:" + PORT;
  const parsedUrl = new URL(req.url, "http://" + host);
  const pathname  = parsedUrl.pathname;

  // Static files
  const staticEntry = STATIC[pathname];
  if (req.method === "GET" && staticEntry) {
    return serveStatic(res, staticEntry);
  }

  // HLS manifest / segment proxy
  if (req.method === "GET" && pathname === "/proxy/flix-stream") {
    return handleFlixProxy(req, res, parsedUrl);
  }

  // Subtitle pass-through proxy
  if (req.method === "GET" && pathname === "/proxy/subtitle") {
    return handleSubtitleProxy(req, res, parsedUrl);
  }

  // Reanime self-hosted libass worker + wasm proxy
  if (req.method === "GET" && pathname === "/proxy/reanime-static") {
    return handleReanimeStaticProxy(req, res, parsedUrl);
  }

  // Everything else -> Worker (Anivexa API)
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
