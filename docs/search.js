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
  sort: 'POPULARITY_DESC' // Default to popular if empty
};

let searchToken = 0;
let observer = null;

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
    Page(page: $page, perPage: 30) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(search: $search, genre: $genre, seasonYear: $year, format: $format, sort: $sort, isAdult: false) {
        id 
        title { romaji english } 
        coverImage { extraLarge large } 
        format 
        averageScore 
        seasonYear
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
  if (currentFilters.sort !== 'POPULARITY_DESC') p.set('sort', currentFilters.sort);
  
  const newUrl = '/search' + (p.toString() ? '?' + p.toString() : '');
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

function showSkeleton() {
  const results = $('searchResults');
  results.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    results.innerHTML += `
      <div class="home-card">
        <div class="home-card__thumb" style="background:var(--ch-bg-2); animation: home-shimmer 1.6s infinite;"></div>
        <div class="home-card__title-wrap"><div class="ch-skel ch-skel-line" style="width:80%; margin-top:8px;"></div></div>
      </div>
    `;
  }
}

async function fetchResults(reset = false) {
  if (isLoading) return;
  isLoading = true;

  const myToken = ++searchToken;

  if (reset) {
    currentPage = 1;
    showSkeleton();
    $('searchLoadMore').hidden = true;
  }

  // If sort is SEARCH_MATCH and there's no query, fallback to POPULARITY_DESC
  let finalSort = currentFilters.sort;
  if (finalSort === 'SEARCH_MATCH' && !currentQuery) finalSort = 'POPULARITY_DESC';

  const vars = {
    page: currentPage,
    search: currentQuery || null,
    genre: currentFilters.genre || null,
    year: currentFilters.year ? parseInt(currentFilters.year, 10) : null,
    format: currentFilters.format || null,
    sort: [finalSort]
  };

  try {
    const data = await anilistQuery(SEARCH_QUERY, vars);
    if (myToken !== searchToken) return;

    const page = data?.Page;
    if (!page) throw new Error('No data');

    const results = page.media || [];
    hasNextPage = page.pageInfo?.hasNextPage || false;

    if (reset) $('searchResults').innerHTML = '';

    if (!results.length && reset) {
      $('searchResults').innerHTML = '<div class="search-empty">No results found.</div>';
    } else {
      results.forEach(m => {
        const cover = m.coverImage?.extraLarge || m.coverImage?.large || '';
        const card = document.createElement('a');
        card.className = 'home-card';
        card.href = `/preview?id=${m.id}`;
        
        const scoreBadge = m.averageScore ? `<div class="home-card__chip home-card__chip--score"><span class="star">★</span>${m.averageScore}</div>` : '';
        
        card.innerHTML = `
          <div class="home-card__thumb">
            <img src="${chEscapeHtml(cover)}" alt="" loading="lazy">
            <div class="home-card__ribbon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
              <span>View</span>
            </div>
            <div class="home-card__chiprow" style="pointer-events:none;">${scoreBadge}</div>
          </div>
          <div class="home-card__title-wrap">
            <div class="home-card__title-text" style="opacity:1; -webkit-line-clamp: 2; font-weight: 700;">${chEscapeHtml(titleOf(m))}</div>
          </div>
          <div class="home-card__meta">${formatFormat(m.format)}${m.seasonYear ? ' · ' + m.seasonYear : ''}</div>
        `;
        $('searchResults').appendChild(card);
      });

      if (typeof detectTitleOverflow === 'function') detectTitleOverflow($('searchResults'));
    }

    $('searchLoadMore').hidden = !hasNextPage;
    if (hasNextPage) setupObserver(); // Setup infinite scroll
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

function setupObserver() {
  if (observer) observer.disconnect();
  const sentinel = $('searchLoadMore');
  
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasNextPage && !isLoading) {
      currentPage++;
      fetchResults(false);
    }
  }, { rootMargin: '200px' });
  
  observer.observe(sentinel);
}

function init() {
  const p = new URLSearchParams(location.search);
  currentQuery = p.get('q') || '';
  currentFilters.genre = p.get('genre') || '';
  currentFilters.year = p.get('year') || '';
  currentFilters.format = p.get('format') || '';
  currentFilters.sort = p.get('sort') || (currentQuery ? 'SEARCH_MATCH' : 'POPULARITY_DESC');

  $('searchInput').value = currentQuery;
  $('filterGenre').value = currentFilters.genre;
  $('filterYear').value = currentFilters.year;
  $('filterFormat').value = currentFilters.format;
  $('filterSort').value = currentFilters.sort;

  if (currentQuery || currentFilters.genre || currentFilters.year || currentFilters.format) {
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Trending Anime';
  } else {
    $('searchTitle').textContent = 'Popular Anime';
  }
  
  fetchResults(true); // Always fetch initially

  const debouncedSearch = debounce(() => {
    currentQuery = $('searchInput').value.trim();
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Popular Anime';
    updateUrl();
    fetchResults(true);
  }, 400);

  $('searchInput').addEventListener('input', debouncedSearch);

  $('searchBtn').onclick = () => {
    currentQuery = $('searchInput').value.trim();
    updateUrl();
    $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Popular Anime';
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
      $('searchTitle').textContent = currentQuery ? `Results for "${currentQuery}"` : 'Trending Anime';
      fetchResults(true);
    };
  });

  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', init);
