// ============================================================
// Cloud Hub — tmdb.js
// ============================================================

const TMDB_API_KEY = 'c369a47ceeb50fba4557e4da9ac9390b';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TMDB_CACHE_KEY = 'ch_tmdb_cache_v5';
const TMDB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMDB_DEBUG = false; // set true to log match decisions to console

// Nuke any old cache keys from previous versions.
(function nukeOldCaches() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('ch_tmdb_cache_') === 0 && k !== TMDB_CACHE_KEY) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
    if (TMDB_DEBUG && toRemove.length) console.log('[TMDB] nuked old caches:', toRemove);
  } catch {}
})();

let tmdbCache = (() => {
  try { return JSON.parse(localStorage.getItem(TMDB_CACHE_KEY)) || {}; }
  catch { return {}; }
})();

function tmdbSaveCache() {
  try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(tmdbCache)); } catch {}
}
function tmdbCacheKey(title, year) {
  return `${(title || '').toLowerCase().trim()}:${year || ''}`;
}
function tmdbGetCached(title, year) {
  const k = tmdbCacheKey(title, year);
  const entry = tmdbCache[k];
  if (!entry) return null;
  if (Date.now() - entry.at > TMDB_CACHE_TTL_MS) return null;
  return entry.data;
}
function tmdbPutCached(title, year, data) {
  const k = tmdbCacheKey(title, year);
  tmdbCache[k] = { at: Date.now(), data };
  tmdbSaveCache();
}

async function tmdbFetch(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY not set');
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

function tmdbNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tmdbTitleScore(a, b) {
  const na = tmdbNorm(a);
  const nb = tmdbNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return 0.7 + 0.3 * (shorter / longer);
  }
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  const total = new Set([...wa, ...wb]).size;
  return overlap / total;
}

function tmdbResultYear(r) {
  const d = r.first_air_date || r.release_date || '';
  const m = String(d).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// Heavier scoring: penalize any title mismatch aggressively.
function scoreCandidate(r, query, year, format) {
  const titleFields = [r.name, r.original_name, r.title, r.original_title].filter(Boolean);
  let titleScore = 0;
  for (const t of titleFields) titleScore = Math.max(titleScore, tmdbTitleScore(query, t));
  if (titleScore < 0.6) return -Infinity;

  let score = titleScore * 100;

  const rYear = tmdbResultYear(r);
  if (year && rYear) {
    const diff = Math.abs(rYear - year);
    if (diff === 0) score += 50;
    else if (diff === 1) score += 30;
    else if (diff <= 3) score += 12;
    else if (diff <= 6) score += 0;
    else score -= 50;
  }

  const isMovieFormat = format === 'MOVIE' || format === 'SPECIAL';
  if (isMovieFormat && r.title && !r.name) score += 10;
  if (!isMovieFormat && r.name && !r.title) score += 10;

  if ((r.popularity || 0) === 0 && (r.vote_count || 0) === 0) score -= 60;

  if (r.popularity && r.popularity > 0) {
    score += Math.min(30, Math.log10(r.popularity + 1) * 8);
  }
  if (r.vote_count && r.vote_count > 0) {
    score += Math.min(20, Math.log10(r.vote_count + 1) * 5);
  }

  return score;
}

function pickBestResult(results, query, year, format) {
  if (!Array.isArray(results) || !results.length) return null;
  let best = null;
  let bestScore = -Infinity;
  const scored = [];
  for (const r of results) {
    const s = scoreCandidate(r, query, year, format);
    scored.push({ score: s, title: r.name || r.title, year: tmdbResultYear(r), id: r.id });
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (TMDB_DEBUG) console.log('[TMDB] scored candidates for', query, year, scored.sort((a,b) => b.score - a.score).slice(0, 5));
  return bestScore > 40 ? best : null;
}

async function tmdbLookup(title, year, format) {
  if (!TMDB_API_KEY || !title) return null;

  const cached = tmdbGetCached(title, year);
  if (cached !== null) return cached;

  const isMovie = format === 'MOVIE' || format === 'SPECIAL';

  const tries = isMovie
    ? [
        { kind: 'movie', path: '/search/movie', params: { query: title, primary_release_year: year || '' } },
        { kind: 'movie', path: '/search/movie', params: { query: title } },
        { kind: 'tv',    path: '/search/tv',    params: { query: title, first_air_date_year: year || '' } },
      ]
    : [
        { kind: 'tv',    path: '/search/tv',    params: { query: title, first_air_date_year: year || '' } },
        { kind: 'tv',    path: '/search/tv',    params: { query: title } },
        { kind: 'movie', path: '/search/movie', params: { query: title, year: year || '' } },
      ];

  for (const t of tries) {
    try {
      const search = await tmdbFetch(t.path, t.params);
      const best = pickBestResult(search?.results, title, year, format);
      if (!best?.id) continue;

      const images = await tmdbFetch(`/${t.kind}/${best.id}/images`, {
        include_image_language: 'en,null'
      });

      const pickBackdrop = () => {
        const list = images?.backdrops || [];
        const ordered = [...list].sort((a, b) => {
          const aEn = a.iso_639_1 === 'en' || a.iso_639_1 == null ? 1 : 0;
          const bEn = b.iso_639_1 === 'en' || b.iso_639_1 == null ? 1 : 0;
          if (aEn !== bEn) return bEn - aEn;
          return (b.width || 0) - (a.width || 0);
        });
        return ordered[0]?.file_path || null;
      };

      // For logos: prefer English, then null, then widest. Also filter out
      // absurdly tall/square logos (spinoff symbols, fan art) which usually
      // have aspect ratio close to 1.
      const pickLogo = () => {
        const list = (images?.logos || []).filter(l => {
          const w = l.width || 0;
          const h = l.height || 0;
          if (!w || !h) return false;
          const ar = w / h;
          // Real anime wordmarks are usually wider than tall (ar > 1.5).
          // Reject square symbols and portraits.
          return ar >= 1.4;
        });
        if (!list.length) return null;
        const ordered = [...list].sort((a, b) => {
          const aEn = a.iso_639_1 === 'en' ? 2 : (a.iso_639_1 == null ? 1 : 0);
          const bEn = b.iso_639_1 === 'en' ? 2 : (b.iso_639_1 == null ? 1 : 0);
          if (aEn !== bEn) return bEn - aEn;
          return (b.width || 0) - (a.width || 0);
        });
        return ordered[0]?.file_path || null;
      };

      const backdropFile = pickBackdrop();
      const logoFile = pickLogo();
      const fallbackBackdrop = best.backdrop_path || null;

      const data = {
        tmdbId: best.id,
        kind: t.kind,
        tmdbTitle: best.name || best.title || null,
        backdropUrl: backdropFile
          ? `${TMDB_IMG}/w1920${backdropFile}`
          : (fallbackBackdrop ? `${TMDB_IMG}/w1920${fallbackBackdrop}` : null),
        logoUrl: logoFile ? `${TMDB_IMG}/w500${logoFile}` : null
      };

      if (TMDB_DEBUG) console.log('[TMDB] matched', title, year, '→', data);

      tmdbPutCached(title, year, data);
      return data;
    } catch {
      continue;
    }
  }

  tmdbPutCached(title, year, null);
  return null;
}
