// ============================================================
// Cloud Hub — search.js
// ============================================================

const JIKAN_API = 'https://api.jikan.moe/v4/anime';
const $ = (id) => document.getElementById(id);

let currentPage = 1;
let hasNextPage = false;
let isLoading = false;
let currentQuery = '';
let currentFilters = {
  genre: '',
  year: '',
  format: '',
  sort: 'POPULARITY_DESC'
};

let searchToken = 0;
let observer = null;

const GENRE_MAP = {
  'Action': '1', 'Adventure': '2', 'Comedy': '4', 'Drama': '8',
  'Fantasy': '10', 'Horror': '14', 'Mecha': '18', 'Music': '19',
  'Mystery': '7', 'Psychological': '40', 'Romance': '22', 'Sci-Fi': '24',
  'Slice of Life': '36', 'Sports': '30', 'Supernatural': '37', 'Thriller': '41'
};

async function fetchJikan(page, query, filters) {
  const p = new URLSearchParams();
  p.set('page', page);
  p.set('limit', 24);
  p.set('sfw', 'true');
  p.set('status', 'airing,complete'); // Kills all unreleased slop
  
  if (query) p.set('q', query);
  if (filters.genre) p.set('genres', GENRE_MAP[filters.genre] || '');
  if (filters.year) p.set('start_date', filters.year);
  
  if (filters.format) {
     const fmt = filters.format.toLowerCase();
     if (['tv', 'movie', 'ova', 'ona', 'special'].includes(fmt)) p.set('type', fmt);
  }

  let orderBy = 'members';
  let sort = 'desc';
  
  if (filters.sort === 'SCORE_DESC') { orderBy = 'score'; }
  else if (filters.sort === 'START_DATE_DESC') { orderBy = 'start_date'; }
  else if (filters.sort === 'POPULARITY_DESC') { orderBy = 'members'; }
  else if (filters.sort === 'SEARCH_MATCH') {
    if (query) { orderBy = 'score'; } else { orderBy = 'members'; }
  }

  p.set('order_by', orderBy);
  p.set('sort', sort);

  const res = await fetch(`${JIKAN_API}?${p.toString()}`);
  if (!res.ok) throw new Error('Jikan API error');
  return res.json();
}

function updateUrl() {
  const p = new URLSearchParams();
  if (currentQuery) p.set('q', currentQuery);
  if (currentFilters.genre) p.set('genre', currentFilters.genre);
  if (currentFilters.year) p.set('year', currentFilters.year);
  if (currentFilters.format) p.set('format', currentFilters.format);
  if (currentFilters.sort !== 'POPULARITY_DESC') p.set('sort', currentFilters.sort);
  
  const newUrl = '/search' + (p.toString() ? '?' + p.toString() : '');
  if (window.location.pathname + window.location.search !== newUrl) {
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

  try {
    const json = await fetchJikan(currentPage, currentQuery, currentFilters);
    if (myToken !== searchToken) return;

    const results = json.data || [];
    hasNextPage = json.pagination?.has_next_page || false;

    if (reset) $('searchResults').innerHTML = '';

    if (!results.length && reset) {
      $('searchResults').innerHTML = '<div class="search-empty">No results found.</div>';
    } else {
      results.forEach(m => {
        const cover = m.images?.jpg?.large_image_url || m.images?.jpg?.image_url || '';
        const card = document.createElement('a');
        card.className = 'home-card';
        card.href = `/preview?mal=${m.mal_id}`; // Route using MAL ID
        
        const scoreBadge = m.score ? `<div class="home-card__chip home-card__chip--score"><span class="star">★</span>${m.score}</div>` : '';
        const year = m.year || (m.aired?.prop?.from?.year) || '';
        
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
            <div class="home-card__title-text" style="opacity:1; -webkit-line-clamp: 2; font-weight: 700;">${chEscapeHtml(m.title)}</div>
          </div>
          <div class="home-card__meta">${m.type || 'TV'}${year ? ' · ' + year : ''}</div>
        `;
        $('searchResults').appendChild(card);
      });

      if (typeof detectTitleOverflow === 'function') detectTitleOverflow($('searchResults'));
    }

    $('searchLoadMore').hidden = !hasNextPage;
    if (hasNextPage) setupObserver();
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
  
  fetchResults(true);

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
