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

async function handleFlixProxy(req, res, parsedUrl) {
  let targetUrl = parsedUrl.searchParams.get("url");
  const key = parsedUrl.searchParams.get("key");
  const isSegment = parsedUrl.searchParams.get("type") === "segment";

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("Missing URL");
  }

  try {
    const fetchUpstream = async (url) => {
      return await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://flixcloud.cc/",
          "Origin": "https://flixcloud.cc"
        }
      });
    };

    let response = await fetchUpstream(targetUrl);

    if (!response.ok) {
      res.writeHead(response.status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(`Upstream HTTP error: ${response.status}`);
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    if (isSegment) {
      let body = bodyBuffer;
      let offset = 0;
      let needsXor = false;

      const isWebp = body.length > 12 && body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 && body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50;
      const isPng = body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47 && body[4] === 0x0d && body[5] === 0x0a && body[6] === 0x1a && body[7] === 0x0a;

      if (isWebp) {
        offset = 12;
        needsXor = body[offset] !== 0x47;
      } else if (isPng) {
        offset = 8;
        needsXor = body[offset] !== 0x47;
      }

      if (offset > 0) {
        const out = Buffer.from(body.subarray(offset));
        if (needsXor) {
          for (let i = 0; i < out.length; i++) {
            out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
          }
        }
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "video/mp2t"
        });
        return res.end(out);
      }

      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "video/mp2t"
      });
      return res.end(body);
    }

    let raw = bodyBuffer.toString("utf8").trim();
    let text = raw;

    if (key && !raw.startsWith("#EXTM3U")) {
      try {
        const decKey = Buffer.from(key, "base64");
        const payload = Buffer.from(raw, "base64");
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i] ^ decKey[i % decKey.length];
        }
        text = out.toString("utf8");
      } catch (e) {
        text = raw;
      }
    }

    const host = req.headers["host"] ?? "localhost:" + PORT;
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const proxyBase = protocol + "://" + host + "/proxy/flix-stream";

    // Master Playlist & Audio Stream Rewriting (Preserves Audio & Quality Variants)
    if (text.includes("#EXT-X-STREAM-INF") || text.includes("#EXT-X-MEDIA")) {
      text = text.split(/\r?\n/).map(line => {
        let trimmed = line.trim();
        if (trimmed.startsWith("#EXT-X-MEDIA")) {
          return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUrl = new URL(uri, targetUrl).toString();
            let proxyUrl = proxyBase + "?url=" + encodeURIComponent(absoluteUrl);
            if (key) proxyUrl += "&key=" + encodeURIComponent(key);
            return `URI="${proxyUrl}"`;
          });
        }
        if (trimmed && !trimmed.startsWith("#")) {
          const absoluteUrl = new URL(trimmed, targetUrl).toString();
          let proxyUrl = proxyBase + "?url=" + encodeURIComponent(absoluteUrl);
          if (key) proxyUrl += "&key=" + encodeURIComponent(key);
          return proxyUrl;
        }
        return line;
      }).join("\n");

      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/vnd.apple.mpegurl"
      });
      return res.end(text);
    }

    // Standard Media Playlist URL Rewriting for Segments
    text = text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const absoluteUrl = new URL(trimmed, targetUrl).toString();
        let proxyUrl = proxyBase + "?url=" + encodeURIComponent(absoluteUrl);
        if (key) proxyUrl += "&key=" + encodeURIComponent(key);
        return proxyUrl + "&type=segment";
      }
      return line;
    }).join("\n");

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/vnd.apple.mpegurl"
    });
    return res.end(text);
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
    for (const [k, v] of response.headers) {
      res.setHeader(k, v);
    }
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
