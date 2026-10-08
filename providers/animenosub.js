import { getMedia } from "../core/anilist.js";
import { findVideoExtractor } from "../extractors/index.js";
import {
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  findTopSlugs,
  getPrequelOffset,
  json,
  selectSeries,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const CF_PROXY = "https://cloudhub.itzjay4kyt.workers.dev";
const BASE = "https://animenosub.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

async function cfFetch(targetUrl, options = {}) {
  const headers = options.headers || {};
  const referer = headers["Referer"] || headers["referer"];
  const ua      = headers["User-Agent"] || headers["user-agent"];

  const params = new URLSearchParams({ url: targetUrl });
  if (referer) params.set("referer", referer);
  if (ua)      params.set("ua", ua);
  const proxyUrl = `${CF_PROXY}/fetch?${params.toString()}`;

  const proxyOptions = { method: options.method || "GET", headers: {} };
  if (options.body) {
    proxyOptions.body = options.body;
    if (headers["Content-Type"]) proxyOptions.headers["Content-Type"] = headers["Content-Type"];
  }
  return fetch(proxyUrl, proxyOptions);
}

async function fetchHtml(url, headers = {}) {
  const res = await cfFetch(url, { headers: { "User-Agent": UA, ...headers } });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`animenosub HTTP ${res.status}: ${url} — body: ${String(raw).slice(0, 200)}`);
    err.rawBody = raw;
    throw err;
  }
  return raw;
}

async function search(query) {
  console.log(`[animenosub] search("${query}") starting…`);
  const res = await cfFetch(`${BASE}/wp-admin/admin-ajax.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      "Referer": `${BASE}/`,
    },
    body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
  });
  const raw = await res.text();
  console.log(`[animenosub] search("${query}") → HTTP ${res.status}, ${raw.length} bytes`);
  if (!res.ok) {
    const err = new Error(`animenosub search HTTP ${res.status} — body: ${String(raw).slice(0, 300)}`);
    err.rawBody = raw;
    throw err;
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    const err = new Error(`animenosub search JSON parse: ${e.message} — body: ${String(raw).slice(0, 300)}`);
    err.rawBody = raw;
    throw err;
  }
  const results = [];
  for (const item of data?.anime?.[0]?.all ?? []) {
    const slug = item.post_link?.match(/\/anime\/([^/]+)\/?$/)?.[1];
    if (!slug) continue;
    results.push({ slug, text: item.post_title ?? slug.replace(/-/g, " ") });
  }
  console.log(`[animenosub] search("${query}") → parsed ${results.length} results, first: ${results[0]?.slug || "—"}`);
  return results;
}

async function scrapeSeries(slug) {
  console.log(`[animenosub] scrapeSeries("${slug}") starting…`);
  const html = await fetchHtml(`${BASE}/anime/${slug}/`, { Referer: BASE });
  console.log(`[animenosub] scrapeSeries("${slug}") → ${html.length} bytes of HTML`);
  const isSlugDub = /-dub$/.test(slug) || /(?:^|[-\s])dub(?:$|[-\s])/i.test(slug);
  const episodes = [];
  const seen = new Set();
  const listRe = /<li\b[^>]*data-index="\d+"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/animenosub\.to\/[^"]+)"[\s\S]*?<div\s+class="epl-num">([^<]+)<\/div>/gi;
  for (const m of html.matchAll(listRe)) {
    const epUrl = decodeEntities(m[1]);
    const label = m[2].trim();
    let number;
    if (/^movie$/i.test(label)) {
      number = 1;
    } else {
      const n = parseFloat(label);
      number = Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
    }
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    const isDub = isSlugDub || /-dub(?:$|\/)/.test(epUrl);
    episodes.push({ number, title: /^movie$/i.test(label) ? "Movie" : `Episode ${number}`, epUrl, hasSub: !isDub, hasDub: isDub });
  }
  episodes.sort((a, b) => a.number - b.number);
  console.log(`[animenosub] scrapeSeries("${slug}") → parsed ${episodes.length} episodes`);
  return episodes;
}

async function scrapeEmbeds(epUrl) {
  const html = await fetchHtml(epUrl, { Referer: `${BASE}/` });
  const streams = [];
  for (const m of html.matchAll(/<option\s+value="([A-Za-z0-9+/=]+)"\s+data-index="\d+"[^>]*>([^<]+)<\/option>/gi)) {
    const b64 = m[1];
    const serverName = m[2].trim();
    if (!serverName || /select video server/i.test(serverName)) continue;
    let embedUrl = null;
    try {
      const decoded = atob(b64);
      embedUrl = decoded.match(/src=["']([^"']+)["']/i)?.[1] ?? null;
    } catch { continue; }
    if (!embedUrl) continue;
    const embedOrigin = (() => { try { const u = new URL(embedUrl.startsWith("//") ? `https:${embedUrl}` : embedUrl); return `${u.protocol}//${u.host}/`; } catch { return epUrl; } })();
    streams.push({
      url: embedUrl,
      type: "embed",
      server: serverName,
      referer: embedOrigin,
      priority: streams.length === 0 ? 2 : 1,
      isActive: streams.length === 0,
    });
  }
  if (streams.length === 0) {
    for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const src = m[1];
      if (/vidmoly|vtbe|streamtape|dood|filemoon|upn\.one|bysesa/i.test(src)) {
        const embedOrigin = (() => { try { const u = new URL(src.startsWith("//") ? `https:${src}` : src); return `${u.protocol}//${u.host}/`; } catch { return epUrl; } })();
        streams.push({ url: src, type: "embed", server: "Direct", referer: embedOrigin, priority: 2, isActive: true });
        break;
      }
    }
  }
  return streams;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:animenosub:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  console.log(`[animenosub] resolveSeries ${anilistId} — trying ${titles.length} titles`);
  const candidates = await findTopSlugs(titles, search);
  console.log(`[animenosub] resolveSeries ${anilistId} — ${candidates.length} candidates after scoring`);
  const expected = expectedCount(media, ctx.anizip);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media?.status, offset);
  if (!selected) throw new Error(`animenosub match not found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeLists(anilistId, series, providerEpisodes, ctx, expected) {
  const sub = [], dub = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    const base = {
      number,
      title: meta.title ?? src.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
    };
    if (src.hasSub) sub.push({ ...base, id: `watch/animenosub/${anilistId}/sub/animenosub-${number}`, audio: "sub" });
    if (src.hasDub) dub.push({ ...base, id: `watch/animenosub/${anilistId}/dub/animenosub-${number}`, audio: "dub" });
  }
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media, ctx.anizip);
  return {
    meta: {
      id: series.slug,
      title: series.title,
      source: "animenosub",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function withRetry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (_) { if (i === attempts - 1) return null; }
  }
  return null;
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const episodes = await scrapeSeries(series.slug);
  const ep = episodes.find((e) => e.number === providerEp && (audio === "dub" ? e.hasDub : e.hasSub))
    ?? episodes.find((e) => e.number === providerEp);
  if (!ep) throw new Error(`animenosub episode ${providerEp} not found`);
  const embeds = await scrapeEmbeds(ep.epUrl);

  const resolvable = embeds.map((stream) => ({ stream, extractor: findVideoExtractor(stream.url) })).filter((item) => item.extractor);
  const resolvedList = await Promise.all(resolvable.map(({ stream, extractor }) => withRetry(() => extractor.extract(stream.url, { userAgent: UA, referer: `${BASE}/` }))));
  const resolvedMap = new Map(resolvable.map(({ stream, extractor }, index) => [stream.url, { extractor, urls: resolvedList[index] }]));

  const streams = [];
  for (const stream of embeds) {
    const resolved = resolvedMap.get(stream.url);
    if (resolved?.urls) {
      const referer = resolved.extractor.name === "vidmoly"
        ? "https://vidmoly.biz/"
        : resolved.extractor.name === "nova"
          ? "https://nova.upn.one/"
          : "https://bysesayeveum.com/";
      for (const resolvedSource of resolved.urls) {
        const source = typeof resolvedSource === "string" ? { url: resolvedSource, type: "hls" } : resolvedSource;
        streams.push({
          url: source.url,
          type: source.type,
          server: stream.server,
          referer,
          priority: stream.priority,
          isActive: stream.isActive,
        });
      }
    }
    streams.push(stream);
  }

  return json({ anilistId: Number(anilistId), episode: Number(epNum), providerEpisode: providerEp, audio, streams });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/animenosub\/(\d+)\/(sub|dub)\/animenosub-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
