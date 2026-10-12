// ============================================================
// Cloud Hub — tmdb.js
// ============================================================

const TMDB_API_KEY = 'c369a47ceeb50fba4557e4da9ac9390b';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TMDB_CACHE_KEY = 'ch_tmdb_cache_v3';
const TMDB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let tmdbCache = (() => {
  try { return JSON.parse(localStorage.getItem(TMDB_CACHE_KEY)) || {}; }
  catch { return {}; }
})();

function tmdbSaveCache() {
  try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(tmdbCache)); }
  catch {}
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

async function tmdbLookup(title, year) {
  if (!TMDB_API_KEY || !title) return null;

  const cached = tmdbGetCached(title, year);
  if (cached !== null) return cached;

  const tries = [
    { kind: 'tv',    path: '/search/tv',    params: { query: title, first_air_date_year: year } },
    { kind: 'tv',    path: '/search/tv',    params: { query: title } },
    { kind: 'movie', path: '/search/movie', params: { query: title, year } },
    { kind: 'movie', path: '/search/movie', params: { query: title } }
  ];

  for (const t of tries) {
    try {
      const search = await tmdbFetch(t.path, t.params);
      const first = search?.results?.[0];
      if (!first?.id) continue;

      const images = await tmdbFetch(`/${t.kind}/${first.id}/images`, {
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
      const fallbackBackdrop = first.backdrop_path || null;

      const data = {
        tmdbId: first.id,
        kind: t.kind,
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
