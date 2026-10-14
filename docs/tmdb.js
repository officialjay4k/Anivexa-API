// ============================================================
// Cloud Hub — tmdb.js
// ============================================================

const TMDB_API_KEY = 'c369a47ceeb50fba4557e4da9ac9390b';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TMDB_CACHE_KEY = 'ch_tmdb_cache_v4';
const TMDB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

// Normalize a title for comparison: lowercase, strip punctuation.
function tmdbNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple similarity: fraction of words in common (Jaccard-ish, weighted toward containment).
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

// Extract a year from a TMDB result. TV uses first_air_date, movie uses release_date.
function tmdbResultYear(r) {
  const d = r.first_air_date || r.release_date || '';
  const m = String(d).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// Score one candidate result against what we're looking for.
function scoreCandidate(r, query, year, format) {
  const titleFields = [r.name, r.original_name, r.title, r.original_title].filter(Boolean);
  let titleScore = 0;
  for (const t of titleFields) titleScore = Math.max(titleScore, tmdbTitleScore(query, t));
  if (titleScore < 0.35) return -Infinity;  // reject wildly different results

  let score = titleScore * 60;

  // Year match
  const rYear = tmdbResultYear(r);
  if (year && rYear) {
    const diff = Math.abs(rYear - year);
    if (diff === 0) score += 30;
    else if (diff === 1) score += 18;
    else if (diff <= 3) score += 6;
    else if (diff <= 6) score += 0;
    else score -= 25;
  } else if (!year) {
    // No year to compare — small nudge for very old or very new doesn't apply.
  }

  // Format intent
  const isMovieFormat = format === 'MOVIE' || format === 'SPECIAL';
  if (isMovieFormat && r.title && !r.name) score += 8;   // movie result
  if (!isMovieFormat && r.name && !r.title) score += 8;   // tv result

  // Popularity — reject ghosts with 0 popularity
  if ((r.popularity || 0) === 0 && (r.vote_count || 0) === 0) score -= 40;

  // Small popularity tiebreaker (log scale so it doesn't overwhelm)
  if (r.popularity && r.popularity > 0) {
    score += Math.min(20, Math.log10(r.popularity + 1) * 6);
  }
  if (r.vote_count && r.vote_count > 0) {
    score += Math.min(12, Math.log10(r.vote_count + 1) * 3);
  }

  return score;
}

// Pick the best candidate from TMDB search results.
function pickBestResult(results, query, year, format) {
  if (!Array.isArray(results) || !results.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const s = scoreCandidate(r, query, year, format);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore > 20 ? best : null;
}

async function tmdbLookup(title, year, format) {
  if (!TMDB_API_KEY || !title) return null;

  const cached = tmdbGetCached(title, year);
  if (cached !== null) return cached;

  const isMovie = format === 'MOVIE' || format === 'SPECIAL';

  // Ordered search attempts. Prefer the format-consistent endpoint first.
  const tries = isMovie
    ? [
        { kind: 'movie', path: '/search/movie', params: { query: title, year: year || '', primary_release_year: year || '' } },
        { kind: 'movie', path: '/search/movie', params: { query: title } },
        { kind: 'tv',    path: '/search/tv',    params: { query: title, first_air_date_year: year || '' } },
        { kind: 'tv',    path: '/search/tv',    params: { query: title } },
      ]
    : [
        { kind: 'tv',    path: '/search/tv',    params: { query: title, first_air_date_year: year || '' } },
        { kind: 'tv',    path: '/search/tv',    params: { query: title } },
        { kind: 'movie', path: '/search/movie', params: { query: title, year: year || '' } },
        { kind: 'movie', path: '/search/movie', params: { query: title } },
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

      const pickLogo = () => {
        const list = images?.logos || [];
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

      tmdbPutCached(title, year, data);
      return data;
    } catch {
      continue;
    }
  }

  tmdbPutCached(title, year, null);
  return null;
}
