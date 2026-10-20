import "dotenv/config";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";

const PORT  = Number(process.env.PORT) || 4000;
const BASE  = process.env.BASE_PATH ?? "";
const __dir = dirname(fileURLToPath(import.meta.url));
const DOCS  = join(__dir, "docs");

const PAGE_ROUTES = {
  "/":               "landing.html",
  "/home":           "home.html",
  "/preview":        "preview.html",
  "/watch":          "watch.html",
  "/settings":       "settings.html",
  "/test":           "test.html",
  "/auth/signup":    "signup.html",
  "/auth/login":     "login.html",
  "/auth/callback":  "callback.html",
  "/user/settings":  "settings.html",
  "/user/dashboard": "dashboard.html",
  "/search":         "search.html",
  "/users":          "users.html",
  "/admin":          "admin.html"
};

const MIME = {
  html: "text/html; charset=utf-8",
  css:  "text/css; charset=utf-8",
  js:   "application/javascript; charset=utf-8",
  mjs:  "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg:  "image/svg+xml",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif:  "image/gif",
  ico:  "image/x-icon",
  woff: "font/woff",
  woff2:"font/woff2",
  txt:  "text/plain; charset=utf-8"
};

function serveStatic(res, filename) {
  const safe = filename.replace(/^\/+/, "").replace(/\.\.+/g, "");
  const full = join(DOCS, safe);
  if (!full.startsWith(DOCS)) {
    res.writeHead(403, { "Access-Control-Allow-Origin": "*" });
    return res.end("Forbidden");
  }
  if (!existsSync(full)) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    return res.end("Not found: " + safe);
  }
  const ext = (safe.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  try {
    const body = readFileSync(full);
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Read error: " + e.message);
  }
}

function matchStaticRoute(pathname) {
  if (PAGE_ROUTES[pathname]) return PAGE_ROUTES[pathname];
  if (/^\/user\/[A-Za-z0-9_.-]{1,32}\/?$/.test(pathname)) return "profile.html";
  const m = pathname.match(/^\/([a-zA-Z0-9_\-./]+\.(?:html|css|js|mjs|json|svg|png|jpg|jpeg|webp|gif|ico|woff2?|txt))$/i);
  if (m) return m[1];
  return null;
}

const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

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

const FLIXCLOUD_HOSTS = [
  "flixcloud.cc", "fallencdn.top", "glaciercdn.top", "vortexcdn.top",
  "rundowncdn.top", "lunarcdn.top", "sirencdn.top", "blazecdn.top",
  "orbitcdn.top", "nebulacdn.top", "matrixcdn.top", "vividcdn.top",
  "cobaltcdn.top"
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
    try { headers["Origin"] = new URL(explicitReferer).origin; } catch {}
    return headers;
  }
  let hostname;
  try { hostname = new URL(targetUrl).hostname; } catch { return baseHeaders; }
  if (isFlixcloudFamily(hostname)) {
    return { ...baseHeaders, "Referer": "https://flixcloud.cc/", "Origin": "https://flixcloud.cc" };
  }
  return baseHeaders;
}

async function fetchUpstream(url, explicitReferer, explicitUserAgent, extraHeaders) {
  const headers = headersForUpstream(url, explicitReferer, explicitUserAgent);
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) if (v != null) headers[k] = v;
  return await fetch(url, { headers });
}

function transformSegmentBuffer(bodyBuffer) {
  let offset = 0, needsXor = false;
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
  if (needsXor) for (let i = 0; i < out.length; i++) out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
  return out;
}

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
    const extra = {};
    if (req.headers["range"]) extra["Range"] = req.headers["range"];
    const response = await fetchUpstream(targetUrl, referer, userAgent, extra);

    if (!response.ok && response.status !== 206) {
      res.writeHead(response.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream HTTP error: ${response.status}`);
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    if (typeParam === "segment" || typeParam === "mp4") {
      if (typeParam === "mp4") {
        const outHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "video/mp4",
          "Content-Length": String(bodyBuffer.length),
          "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
          "Cache-Control": "no-cache"
        };
        const cr = response.headers.get("content-range");
        if (cr) outHeaders["Content-Range"] = cr;
        res.writeHead(response.status === 206 ? 206 : 200, outHeaders);
        return res.end(bodyBuffer);
      }
      const out = transformSegmentBuffer(bodyBuffer);
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "video/mp2t" });
      return res.end(out);
    }

    const hostname = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
    let text = bodyBuffer.toString("utf8").trim();
    if (key && isFlixcloudFamily(hostname)) text = decodeIfEncrypted(text, key);

    if (/#EXT-X-MEDIA/i.test(text)) {
      const verMatch = text.match(/#EXT-X-VERSION:(\d+)/);
      if (verMatch && parseInt(verMatch[1], 10) < 4) {
        text = text.replace(/#EXT-X-VERSION:\d+/, "#EXT-X-VERSION:4");
      }
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

    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(rewritten);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    res.end("Proxy error: " + err.message);
  }
}

async function handleSubtitleProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const referer   = parsedUrl.searchParams.get("referer");
  const userAgent = parsedUrl.searchParams.get("ua");
  if (!targetUrl) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing url"); }
  try {
    const r = await fetchUpstream(targetUrl, referer, userAgent);
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Subtitle proxy error: " + e.message);
  }
}

async function handleReanimeStaticProxy(req, res, parsedUrl) {
  const subPath = parsedUrl.searchParams.get("path");
  if (!subPath) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing path"); }
  const safePath  = subPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const targetUrl = "https://flixcloud.cc/artplayer-new/" + safePath;
  try {
    const r = await fetchUpstream(targetUrl);
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
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

async function handleIntroDbProxy(req, res, parsedUrl) {
  const imdbId  = parsedUrl.searchParams.get("imdb_id");
  const season  = parsedUrl.searchParams.get("season");
  const episode = parsedUrl.searchParams.get("episode");
  const isMovie = parsedUrl.searchParams.get("is_movie");
  if (!imdbId) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing imdb_id"); }
  let upstreamUrl = `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}`;
  if (isMovie === "true") upstreamUrl += "&is_movie=true";
  else { if (season) upstreamUrl += `&season=${encodeURIComponent(season)}`; if (episode) upstreamUrl += `&episode=${encodeURIComponent(episode)}`; }
  try {
    const r = await fetch(upstreamUrl, { headers: { "Accept": "application/json" } });
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("IntroDB proxy error: " + e.message);
  }
}

async function handleRawProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const referer   = parsedUrl.searchParams.get("referer");
  const userAgent = parsedUrl.searchParams.get("ua");
  if (!targetUrl) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing url"); }
  try {
    const extra = {};
    if (req.headers["range"]) extra["Range"] = req.headers["range"];
    const r = await fetchUpstream(targetUrl, referer, userAgent, extra);
    if (!r.ok && r.status !== 206) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
    const body = Buffer.from(await r.arrayBuffer());
    const ct   = r.headers.get("content-type") || "application/octet-stream";
    const outHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": ct, "Cache-Control": "public, max-age=3600" };
    const cr = r.headers.get("content-range");
    if (cr) outHeaders["Content-Range"] = cr;
    const ar = r.headers.get("accept-ranges");
    if (ar) outHeaders["Accept-Ranges"] = ar;
    res.writeHead(r.status === 206 ? 206 : 200, outHeaders);
    return res.end(body);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Raw proxy error: " + e.message);
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
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length"
    });
    return res.end();
  }

  const host      = req.headers["host"] ?? "localhost:" + PORT;
  const parsedUrl = new URL(req.url, "http://" + host);
  const pathname  = parsedUrl.pathname;

  if (req.method === "GET") {
    const staticFile = matchStaticRoute(pathname);
    if (staticFile) return serveStatic(res, staticFile);
  }

  if (req.method === "GET" && pathname === "/proxy/flix-stream") return handleFlixProxy(req, res, parsedUrl);
  if (req.method === "GET" && /^\/proxy\/subtitle(\.(ass|ssa|srt|vtt))?$/.test(pathname)) return handleSubtitleProxy(req, res, parsedUrl);
  if (req.method === "GET" && pathname === "/proxy/reanime-static") return handleReanimeStaticProxy(req, res, parsedUrl);
  if (req.method === "GET" && pathname === "/proxy/introdb") return handleIntroDbProxy(req, res, parsedUrl);
  if (req.method === "GET" && pathname === "/proxy/raw") return handleRawProxy(req, res, parsedUrl);

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, {});
    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Worker crash: " + err.message }));
  }
});

server.listen(PORT, () => {
  console.log("Anivexa dev server → http://localhost:" + PORT);
});
