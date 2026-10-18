// ============================================================
// Cloud Hub — search.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const $ = (id) => document.getElementById(id);

let currentPage = 1;
let hasNextPage = false;
let isLoading = false;
let currentQuery = '';
let currentFilters = {
  genre: '',
  year: '',
  format: '',
  sort: 'SEARCH_MATCH'
};

// Search token to prevent race conditions when typing fast
let searchToken = 0;

async function anilistQuery(query, variables = {}) {
  const res = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const SEARCH_QUERY = `
  query ($page: Int, $search: String, $genre: String, $year: Int, $format: MediaFormat, $sort: [MediaSort]) {
    Page(page: $page, perPage: 24) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(search: $search, genre: $genre, seasonYear: $year, format: $format, sort: $sort, isAdult: false) {
        id title { romaji english } coverImage { extraLarge large } format averageScore seasonYear
      }
    }
  }
`;

function titleOf(media) { return media?.title?.english || media?.title?.romaji || 'Untitled'; }
function formatFormat(f) { return f ? f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''; }

function updateUrl() {
  const p = new URLSearchParams();
  if (currentQuery) p.set('q', currentQuery);
  if (currentFilters.genre) p.set('genre', currentFilters.genre);
  if (currentFilters.year) p.set('year', currentFilters.year);
  if (currentFilters.format) p.set('format', currentFilters.format);
  if (currentFilters.sort !== 'SEARCH_MATCH') p.set('sort', currentFilters.sort);
  
  // Only update history if the URL actually changed to prevent spam
  const newUrl = '/search?' + p.toString();
  if (location.pathname + location.search !== newUrl) {
    history.replaceState(null, '', newUrl);
  }
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

async function fetchResults(reset = false) {
  if (isLoading) return;
  isLoading = true;

  const myToken = ++searchToken;

  if (reset) {
    currentPage = 1;
    $('searchResults').innerHTML = '<div class="search-empty">Searching…</div>';
    $('searchLoadMore').hidden = true;
  }

  const vars = {
    page: currentPage,
    search: currentQuery || null,
    genre: currentFilters.genre || null,
    year: currentFilters.year ? parseInt(currentFilters.year, 10) : null,
    format: currentFilters.format || null,
    sort: [currentFilters.sort]
  };

  try {
    const data = await anilistQuery(SEARCH_QUERY, vars);
    
    // Ignore response if a newer search was triggered while this was fetching
    if (myToken !== searchToken) return;

    const page = data?.Page;
    if (!page) throw new Error('No data');

    const results = page.media || [];
    hasNextPage = page.pageInfo?.hasNextPage || false;

    if (reset) $('searchResults').innerHTML = '';

    if (!results.length && reset) {
      $('searchResults').innerHTML = '<div class="search-empty">No results found.</div>';
    } else {
      const tmdbResults = await Promise.all(results.map(m => tmdbLookup(titleOf(m), m.seasonYear).catch(() => null)));
      
      if (myToken !== searchToken) return;

      results.forEach((m, i) => {
        const tmdb = tmdbResults[i];
        const cover = m.coverImage?.extraLarge || m.coverImage?.large || '';
        const card = document.createElement('a');
        card.className = 'home-card';
        card.href = `/preview?id=${m.id}`;
        
        const scoreBadge = m.averageScore ? `<div class="home-card__chip home-card__chip--score"><span class="star">★</span>${m.averageScore}</div>` : '';
        
        const titleWrap = tmdb?.logoUrl
          ? `<div class="home-card__title-wrap">
               <img class="home-card__title-logo" src="${chEscapeHtml(tmdb.logoUrl)}" alt="${chEscapeHtml(titleOf(m))}" loading="lazy">
               <div class="home-card__title-text">${chEscapeHtml(titleOf(m))}</div>
             </div>`
          : `<div class="home-card__title-wrap">
               <div class="home-card__title-text" style="opacity:1;">${chEscapeHtml(titleOf(m))}</div>
             </div>`;

        card.innerHTML = `
          <div class="home-card__thumb">
            <img src="${chEscapeHtml(cover)}" alt="" loading="lazy">
            <div class="home-card__ribbon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
              <span>View</span>
            </div>
            <div class="home-card__chiprow" style="pointer-events:none;">${scoreBadge}</div>
          </div>
          ${titleWrap}
          <div class="home-card__meta">${formatFormat(m.format)}${m.seasonYear ? ' · ' + m.seasonYear : ''}</div>
        `;
        $('searchResults').appendChild(card);
      });

      if (typeof detectTitleOverflow === 'function') detectTitleOverflow($('searchResults'));
    }

    $('searchLoadMore').hidden = !hasNextPage;
  } catch (e) {
    if (myToken !== searchToken) return;
    console.error(e);
    if (reset) $('searchResults').innerHTML = '<div class="search-empty">Failed to load results. Try again.</div>';
  } finally {
    if (myToken === searchToken) {
      isLoading = false;
    }
  }
}

function init() {
  const p = new URLSearchParams(location.search);
  currentQuery = p.get('q') || '';
  currentFilters.genre = p.get('genre') || '';
  currentFilters.year = p.get('year') || '';
  currentFilters.format = p.get('format') || '';
  currentFilters.sort = p.get('sort') || 'SEARCH_MATCH';

  $('searchInput').value = currentQuery;
  $('filterGenre').value = currentFilters.genre;
  $('filterYear').value = currentFilters.year;
  $('filterFormat').value = currentFilters.format;
  $('filterSort').value = currentFilters.sort;

  if (currentQuery || currentFilters.genre || currentFilters.year || currentFilters.format) {
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Filtered Results';
    fetchResults(true);
  }

  // Live search debounced by 400ms
  const debouncedSearch = debounce(() => {
    currentQuery = $('searchInput').value.trim();
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Search Anime';
    updateUrl();
    fetchResults(true);
  }, 400);

  $('searchInput').addEventListener('input', debouncedSearch);

  $('searchBtn').onclick = () => {
    currentQuery = $('searchInput').value.trim();
    updateUrl();
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Search Anime';
    fetchResults(true);
  };

  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('searchBtn').click();
  });

  ['filterGenre', 'filterYear', 'filterFormat', 'filterSort'].forEach(id => {
    $(id).onchange = () => {
      currentFilters.genre = $('filterGenre').value;
      currentFilters.year = $('filterYear').value;
      currentFilters.format = $('filterFormat').value;
      currentFilters.sort = $('filterSort').value;
      updateUrl();
      $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Filtered Results';
      fetchResults(true);
    };
  });

  $('loadMoreBtn').onclick = () => {
    if (!hasNextPage || isLoading) return;
    currentPage++;
    fetchResults(false);
  };

  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', init);
