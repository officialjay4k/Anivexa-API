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
  "/test":      { file: "docs/test.html",    mime: "text/html" },
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
    res.end("Not found: " + entry.file);
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

// ---------------------------------------------------------------------------
// Upstream headers — only Flixcloud-family hosts get the Flixcloud Referer.
// Everything else gets browser UA and no Referer, which is what most CDNs
// expect. If a specific CDN starts blocking, add its hostname below.
// ---------------------------------------------------------------------------
function headersForUpstream(targetUrl) {
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*"
  };

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); }
  catch { return baseHeaders; }

  // Flixcloud's own domains get the full Referer/Origin. Verified working
  // for fetch8/fetch9.flixcloud.cc and the .cc domain itself.
  if (hostname.endsWith("flixcloud.cc") || hostname === "flixcloud.cc") {
    return {
      ...baseHeaders,
      "Referer": "https://flixcloud.cc/",
      "Origin":  "https://flixcloud.cc"
    };
  }

  // All other CDNs (fallencdn.top, glaciercdn.top, vortexcdn.top,
  // rundowncdn.top, anidap.biz, etc.) get no Referer.
  return baseHeaders;
}

async function fetchUpstream(url) {
  return await fetch(url, { headers: headersForUpstream(url) });
}

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

async function handleFlixProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  const key       = parsedUrl.searchParams.get("key");
  const typeParam = parsedUrl.searchParams.get("type");

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("Missing URL");
  }

  try {
    const response = await fetchUpstream(targetUrl);

    if (!response.ok) {
      const hostname = (() => { try { return new URL(targetUrl).hostname; } catch { return '?'; } })();
      console.log(`[Proxy] Upstream ${response.status} from ${hostname}`);
      res.writeHead(response.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream HTTP error: ${response.status}`);
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    // ---- Binary paths: segments and mp4 ----
    if (typeParam === "segment" || typeParam === "mp4") {
      let out;
      let ct;
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

    // ---- Playlist path ----
    const hostname = (() => { try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ''; } })();
    const isFlixcloudFamily = hostname.endsWith("flixcloud.cc") || hostname === "flixcloud.cc";

    let text = bodyBuffer.toString("utf8").trim();
    if (key && isFlixcloudFamily) {
      text = decodeIfEncrypted(text, key);
    }

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

async function handleSubtitleProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  if (!targetUrl) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing url"); }
  try {
    const r = await fetchUpstream(targetUrl);
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
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

async function handleReanimeStaticProxy(req, res, parsedUrl) {
  const subPath = parsedUrl.searchParams.get("path");
  if (!subPath) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing path"); }
  const safePath = subPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const targetUrl = "https://flixcloud.cc/artplayer-new/" + safePath;
  try {
    const r = await fetchUpstream(targetUrl);
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
    const buf = Buffer.from(await r.arrayBuffer());
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
  else {
    if (season)  upstreamUrl += `&season=${encodeURIComponent(season)}`;
    if (episode) upstreamUrl += `&episode=${encodeURIComponent(episode)}`;
  }

  try {
    const r = await fetch(upstreamUrl, { headers: { "Accept": "application/json" } });
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
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

async function handleRawProxy(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  if (!targetUrl) { res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); return res.end("Missing url"); }
  try {
    const r = await fetchUpstream(targetUrl);
    if (!r.ok) { res.writeHead(r.status, { "Access-Control-Allow-Origin": "*" }); return res.end("Upstream " + r.status); }
    const body = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type") || "application/octet-stream";
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

  const host      = req.headers["host"] ?? "localhost:" + PORT;
  const parsedUrl = new URL(req.url, "http://" + host);
  const pathname  = parsedUrl.pathname;

  const staticEntry = STATIC[pathname];
  if (req.method === "GET" && staticEntry) return serveStatic(res, staticEntry);

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
