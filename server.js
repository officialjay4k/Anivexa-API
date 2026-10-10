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
// Static file map — served by this Node process, not by the Worker
// ---------------------------------------------------------------------------
const STATIC = {
  "/":          { file: "docs/landing.html", mime: "text/html" },
  "/docs":      { file: "docs/index.html",   mime: "text/html" },
  "/test":      { file: "docs/test.html",    mime: "text/html" },
  "/style.css": { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

// ---------------------------------------------------------------------------
// Flixcloud segment XOR key (16 bytes) — applied after stripping fake header
// ---------------------------------------------------------------------------
const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

// ---------------------------------------------------------------------------
// Static file server
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
    res.end("Not found: " + entry.file);
  }
}

// ---------------------------------------------------------------------------
// Manifest decryption: Base64 decode then repeating-key XOR
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
// Upstream headers.
//
// Priority:
//   1. If explicitReferer was supplied (from the payload), use it. Origin
//      is derived from the referer's origin. This is how KAA and Senshi
//      streams get their correct Referer — the Worker tells us what to send.
//   2. Otherwise fall back to a hostname whitelist. Flixcloud-family hosts
//      get the Flixcloud Referer, everything else gets browser UA only.
//
// If explicitUserAgent is supplied, it overrides the hardcoded UA. Mkissa's
// CDN rejects the default Chrome/120 UA — its payload declares Chrome/151,
// so we forward whatever the provider told us to use.
// ---------------------------------------------------------------------------
const FLIXCLOUD_HOSTS = [
  "flixcloud.cc",
  "fallencdn.top",
  "glaciercdn.top",
  "vortexcdn.top",
  "rundowncdn.top",
  "lunarcdn.top",
  "sirencdn.top",
  "blazecdn.top",
  "orbitcdn.top",
  "nebulacdn.top",
  "matrixcdn.top"
];

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function isFlixcloudFamily(hostname) {
  const h = hostname.toLowerCase();
  return FLIXCLOUD_HOSTS.some(domain => h === domain || h.endsWith("." + domain));
}

function headersForUpstream(targetUrl, explicitReferer, explicitUserAgent) {
  const baseHeaders = {
    "User-Agent": explicitUserAgent || DEFAULT_USER_AGENT,
    "Accept": "*/*"
  };

  if (explicitReferer) {
    const headers = { ...baseHeaders, "Referer": explicitReferer };
    try {
      const origin = new URL(explicitReferer).origin;
      headers["Origin"] = origin;
    } catch {}
    return headers;
  }

  let hostname;
  try { hostname = new URL(targetUrl).hostname; }
  catch { return baseHeaders; }

  if (isFlixcloudFamily(hostname)) {
    return {
      ...baseHeaders,
      "Referer": "https://flixcloud.cc/",
      "Origin":  "https://flixcloud.cc"
    };
  }

  return baseHeaders;
}

async function fetchUpstream(url, explicitReferer, explicitUserAgent) {
  return await fetch(url, { headers: headersForUpstream(url, explicitReferer, explicitUserAgent) });
}

// ---------------------------------------------------------------------------
// Segment transform: detect fake WebP/PNG magic, strip it, XOR if needed.
// Only applies to type=segment. MP4s pass through raw.
// ---------------------------------------------------------------------------
function transformSegmentBuffer(bodyBuffer) {
  let offset   = 0;
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
// Query params:
//   url      (required) — upstream URL to fetch
//   key      (optional) — playlist decryption key (Flixcloud family only)
//   type     (optional) — "segment" | "mp4" | unset (playlist)
//   referer  (optional) — explicit Referer to send; overrides whitelist
//   ua       (optional) — explicit User-Agent to send; overrides default
//
// Behavior:
//   - Binary payloads (segment/mp4) — transform & serve
//   - Playlists — decrypt if needed, then rewrite every URI through the proxy
//   - Every rewritten URI inherits key + referer + ua so the whole chain stays
//     authenticated as it walks through nested manifests and segments
// ---------------------------------------------------------------------------
async function handleFlixProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const key       = parsedUrl.searchParams.get("key");
  const typeParam = parsedUrl.searchParams.get("type");
  const referer   = parsedUrl.searchParams.get("referer");
  const userAgent = parsedUrl.searchParams.get("ua");

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("Missing URL");
  }

  try {
    const response = await fetchUpstream(targetUrl, referer, userAgent);

    if (!response.ok) {
      const hostname = (() => { try { return new URL(targetUrl).hostname; } catch { return '?'; } })();
      console.log(`[Proxy] Upstream ${response.status} from ${hostname} (${typeParam || 'playlist'})${referer ? ` ref=${referer}` : ''}${userAgent ? ` ua=${userAgent.slice(0, 40)}...` : ''}`);
      res.writeHead(response.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream HTTP error: ${response.status}`);
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    // ---- Binary payloads ----
    if (typeParam === "segment" || typeParam === "mp4") {
      let out, ct;
      if (typeParam === "mp4") {
        out = bodyBuffer;
        ct  = "video/mp4";
      } else {
        out = transformSegmentBuffer(bodyBuffer);
        ct  = "video/mp2t";
      }
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": ct
      });
      return res.end(out);
    }

    // ---- Playlist payloads ----
    const hostname = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
    let text = bodyBuffer.toString("utf8").trim();

    if (key && isFlixcloudFamily(hostname)) {
      text = decodeIfEncrypted(text, key);
    }

    const host      = req.headers["host"] ?? "localhost:" + PORT;
    const protocol  = req.headers["x-forwarded-proto"] || "http";
    const proxyBase = protocol + "://" + host + "/proxy/flix-stream";

    const buildProxyUrl = (absUrl, type) => {
      let u = proxyBase + "?url=" + encodeURIComponent(absUrl);
      if (key)       u += "&key=" + encodeURIComponent(key);
      if (referer)   u += "&referer=" + encodeURIComponent(referer);
      if (userAgent) u += "&ua=" + encodeURIComponent(userAgent);
      if (type)      u += "&type=" + type;
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
        if (trimmed.startsWith("#EXT-X-KEY"))      type = "segment";
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

// ---------------------------------------------------------------------------
// /proxy/subtitle.ass (or .ssa, .srt, .vtt) — subtitle passthrough
// ---------------------------------------------------------------------------
async function handleSubtitleProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const referer   = parsedUrl.searchParams.get("referer");
  const userAgent = parsedUrl.searchParams.get("ua");

  if (!targetUrl) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing url");
  }

  try {
    const r = await fetchUpstream(targetUrl, referer, userAgent);
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
// /proxy/reanime-static — libass worker + wasm proxy
// ---------------------------------------------------------------------------
async function handleReanimeStaticProxy(req, res, parsedUrl) {
  const subPath = parsedUrl.searchParams.get("path");
  if (!subPath) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing path");
  }

  const safePath  = subPath.replace(/^\/+/, "").replace(/\.\./g, "");
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
// /proxy/introdb — IntroDB segments CORS bypass
// ---------------------------------------------------------------------------
async function handleIntroDbProxy(req, res, parsedUrl) {
  const imdbId  = parsedUrl.searchParams.get("imdb_id");
  const season  = parsedUrl.searchParams.get("season");
  const episode = parsedUrl.searchParams.get("episode");
  const isMovie = parsedUrl.searchParams.get("is_movie");

  if (!imdbId) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing imdb_id");
  }

  let upstreamUrl = `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}`;
  if (isMovie === "true") {
    upstreamUrl += "&is_movie=true";
  } else {
    if (season)  upstreamUrl += `&season=${encodeURIComponent(season)}`;
    if (episode) upstreamUrl += `&episode=${encodeURIComponent(episode)}`;
  }

  try {
    const r = await fetch(upstreamUrl, { headers: { "Accept": "application/json" } });
    if (!r.ok) {
      res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" });
      return res.end("Upstream " + r.status);
    }
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    });
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("IntroDB proxy error: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// /proxy/raw — generic passthrough with upstream headers
// ---------------------------------------------------------------------------
async function handleRawProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const referer   = parsedUrl.searchParams.get("referer");
  const userAgent = parsedUrl.searchParams.get("ua");

  if (!targetUrl) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    return res.end("Missing url");
  }

  try {
    const r = await fetchUpstream(targetUrl, referer, userAgent);
    if (!r.ok) {
      res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" });
      return res.end("Upstream " + r.status);
    }
    const body = Buffer.from(await r.arrayBuffer());
    const ct   = r.headers.get("content-type") || "application/octet-stream";
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": ct,
      "Cache-Control": "public, max-age=3600"
    });
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Raw proxy error: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Convert Node request → Fetch API Request (for the Worker)
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
// Main HTTP server — routes to static files, proxies, or the Worker
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

  const staticEntry = STATIC[pathname];
  if (req.method === "GET" && staticEntry) {
    return serveStatic(res, staticEntry);
  }

  if (req.method === "GET" && pathname === "/proxy/flix-stream") {
    return handleFlixProxy(req, res, parsedUrl);
  }

  if (req.method === "GET" && /^\/proxy\/subtitle(\.(ass|ssa|srt|vtt))?$/.test(pathname)) {
    return handleSubtitleProxy(req, res, parsedUrl);
  }

  if (req.method === "GET" && pathname === "/proxy/reanime-static") {
    return handleReanimeStaticProxy(req, res, parsedUrl);
  }

  if (req.method === "GET" && pathname === "/proxy/introdb") {
    return handleIntroDbProxy(req, res, parsedUrl);
  }

  if (req.method === "GET" && pathname === "/proxy/raw") {
    return handleRawProxy(req, res, parsedUrl);
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
