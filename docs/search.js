// ============================================================
// Cloud Hub — search.js
// ============================================================

(() => {
  'use strict';

  const ANILIST_GRAPHQL =
    window.CH?.ANILIST_GRAPHQL || 'https://graphql.anilist.co';

  const $ = (id) => document.getElementById(id);

  const PER_PAGE = 30;
  const REQUEST_TIMEOUT_MS = 20000;

  const VALID_SORTS = new Set([
    'SEARCH_MATCH',
    'POPULARITY_DESC',
    'SCORE_DESC',
    'START_DATE_DESC',
    'TRENDING_DESC'
  ]);

  const MEDIA_FIELDS = `
    id
    title {
      romaji
      english
    }
    coverImage {
      extraLarge
      large
    }
    format
    status
    averageScore
    seasonYear
  `;

  // Active filters are inserted below; inactive arguments are omitted.
  const SEARCH_QUERY = `
    query SearchAnime(
      $page: Int!
      $search: String!
      $sort: [MediaSort]!
      __FILTER_VARIABLES__
    ) {
      Page(page: $page, perPage: ${PER_PAGE}) {
        pageInfo {
          currentPage
          hasNextPage
        }
        media(
          type: ANIME
          isAdult: false
          search: $search
          sort: $sort
          status_in: [FINISHED, RELEASING, HIATUS]
          __FILTER_ARGUMENTS__
        ) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  const POPULAR_QUERY = `
    query BrowseAnime(
      $page: Int!
      $sort: [MediaSort]!
      __FILTER_VARIABLES__
    ) {
      Page(page: $page, perPage: ${PER_PAGE}) {
        pageInfo {
          currentPage
          hasNextPage
        }
        media(
          type: ANIME
          isAdult: false
          sort: $sort
          status_in: [FINISHED, RELEASING, HIATUS]
          __FILTER_ARGUMENTS__
        ) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  let currentPage = 0;
  let hasNextPage = false;
  let isLoading = false;
  let currentQuery = '';

  let currentFilters = {
    genre: '',
    year: '',
    format: '',
    sort: 'POPULARITY_DESC'
  };

  let generation = 0;
  let requestController = null;
  let observer = null;
  let debounceTimer = null;
  let renderedIds = new Set();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function titleOf(media) {
    return media?.title?.english ||
      media?.title?.romaji ||
      'Untitled';
  }

  function formatFormat(value) {
    if (!value) return '';

    return value
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function selectedValue(id, requestedValue, fallback = '') {
    const select = $(id);
    const requested = String(requestedValue ?? '');

    const exists = Array.from(select.options).some(
      (option) => option.value === requested
    );

    select.value = exists ? requested : fallback;
    return select.value;
  }

  function readControls() {
    currentQuery = $('searchInput').value.trim();

    currentFilters = {
      genre: $('filterGenre').value,
      year: $('filterYear').value,
      format: $('filterFormat').value,
      sort: VALID_SORTS.has($('filterSort').value)
        ? $('filterSort').value
        : 'POPULARITY_DESC'
    };
  }

  function updateTitle() {
    if (currentQuery) {
      $('searchTitle').textContent = `Results for "${currentQuery}"`;
      return;
    }

    const hasFilters =
      currentFilters.genre ||
      currentFilters.year ||
      currentFilters.format;

    if (hasFilters) {
      $('searchTitle').textContent = 'Browse Anime';
    } else if (currentFilters.sort === 'TRENDING_DESC') {
      $('searchTitle').textContent = 'Trending Anime';
    } else if (currentFilters.sort === 'SCORE_DESC') {
      $('searchTitle').textContent = 'Highest Rated Anime';
    } else if (currentFilters.sort === 'START_DATE_DESC') {
      $('searchTitle').textContent = 'Newest Anime';
    } else {
      $('searchTitle').textContent = 'Popular Anime';
    }
  }

  function updateUrl() {
    const params = new URLSearchParams();

    if (currentQuery) params.set('q', currentQuery);
    if (currentFilters.genre) params.set('genre', currentFilters.genre);
    if (currentFilters.year) params.set('year', currentFilters.year);
    if (currentFilters.format) params.set('format', currentFilters.format);

    if (currentFilters.sort !== 'POPULARITY_DESC') {
      params.set('sort', currentFilters.sort);
    }

    const queryString = params.toString();
    const nextUrl =
      location.pathname +
      (queryString ? `?${queryString}` : '') +
      location.hash;

    const existingUrl =
      location.pathname + location.search + location.hash;

    if (existingUrl !== nextUrl) {
      history.replaceState(null, '', nextUrl);
    }
  }

  function buildRequest(pageNumber) {
    const declarations = [];
    const argumentsList = [];

    let sort;

    if (currentQuery) {
      sort = (
        currentFilters.sort === 'POPULARITY_DESC' ||
        currentFilters.sort === 'SEARCH_MATCH'
      )
        ? ['SEARCH_MATCH', 'POPULARITY_DESC']
        : [currentFilters.sort, 'SEARCH_MATCH'];
    } else {
      sort = [
        currentFilters.sort === 'SEARCH_MATCH'
          ? 'POPULARITY_DESC'
          : currentFilters.sort
      ];
    }

    const variables = {
      page: pageNumber,
      sort
    };

    if (currentQuery) {
      variables.search = currentQuery;
    }

    if (currentFilters.genre) {
      declarations.push('$genre: String!');
      argumentsList.push('genre: $genre');
      variables.genre = currentFilters.genre;
    }

    if (currentFilters.year) {
      declarations.push('$year: Int!');
      argumentsList.push('seasonYear: $year');
      variables.year = Number(currentFilters.year);
    }

    if (currentFilters.format) {
      declarations.push('$format: MediaFormat!');
      argumentsList.push('format: $format');
      variables.format = currentFilters.format;
    }

    const template = currentQuery ? SEARCH_QUERY : POPULAR_QUERY;

    const query = template
      .replace('__FILTER_VARIABLES__', declarations.join('\n'))
      .replace('__FILTER_ARGUMENTS__', argumentsList.join('\n'));

    return { query, variables };
  }

  async function anilistQuery(query, variables, signal) {
    const response = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal
    });

    const text = await response.text();

    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new Error('The anime API returned an invalid JSON response.');
      }
    }

    if (!response.ok) {
      const message = json?.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join('; ');

      const error = new Error(
        message || `Anime API request failed (HTTP ${response.status}).`
      );

      error.status = response.status;
      error.retryAfter = response.headers.get('Retry-After');
      throw error;
    }

    if (json?.errors?.length) {
      throw new Error(
        json.errors.map((error) => error.message).join('; ')
      );
    }

    if (!json?.data?.Page || !Array.isArray(json.data.Page.media)) {
      throw new Error('The anime API returned an unexpected response.');
    }

    return json.data;
  }

  function disconnectObserver() {
    if (observer) observer.disconnect();
  }

  function showSkeleton() {
    $('searchResults').innerHTML = Array.from(
      { length: 12 },
      () => `
        <div class="home-card" aria-hidden="true">
          <div
            class="home-card__thumb"
            style="background:var(--ch-bg-2);animation:home-shimmer 1.6s infinite;"
          ></div>
          <div class="home-card__title-wrap">
            <div
              class="ch-skel ch-skel-line"
              style="width:80%;margin-top:8px;"
            ></div>
          </div>
        </div>
      `
    ).join('');
  }

  function renderCards(mediaList) {
    const fragment = document.createDocumentFragment();

    for (const media of mediaList) {
      if (!media || renderedIds.has(media.id)) continue;

      renderedIds.add(media.id);

      const title = titleOf(media);
      const cover =
        media.coverImage?.extraLarge ||
        media.coverImage?.large ||
        '';

      const card = document.createElement('a');
      card.className = 'home-card';
      card.href = `/preview?id=${encodeURIComponent(media.id)}`;

      const scoreBadge = media.averageScore != null
        ? `
          <div class="home-card__chip home-card__chip--score">
            <span class="star">★</span>${escapeHtml(media.averageScore)}
          </div>
        `
        : '';

      const metadata = [
        formatFormat(media.format),
        media.seasonYear
      ].filter(Boolean).join(' · ');

      card.innerHTML = `
        <div class="home-card__thumb">
          ${cover ? `
            <img
              src="${escapeHtml(cover)}"
              alt="${escapeHtml(title)}"
              loading="lazy"
              decoding="async"
            >
          ` : ''}
          <div class="home-card__ribbon">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <polygon points="6 4 20 12 6 20"></polygon>
            </svg>
            <span>View</span>
          </div>
          <div
            class="home-card__chiprow"
            style="pointer-events:none;"
          >${scoreBadge}</div>
        </div>
        <div class="home-card__title-wrap">
          <div
            class="home-card__title-text"
            style="opacity:1;-webkit-line-clamp:2;font-weight:700;"
          >${escapeHtml(title)}</div>
        </div>
        <div class="home-card__meta">${escapeHtml(metadata)}</div>
      `;

      const image = card.querySelector('img');

      if (image) {
        image.addEventListener('error', () => {
          image.hidden = true;
        }, { once: true });
      }

      fragment.appendChild(card);
    }

    $('searchResults').appendChild(fragment);

    if (typeof window.detectTitleOverflow === 'function') {
      try {
        window.detectTitleOverflow($('searchResults'));
      } catch (error) {
        console.warn('[Search] Title layout failed:', error);
      }
    }
  }

  function showLoadMore() {
    disconnectObserver();

    const sentinel = $('searchLoadMore');
    sentinel.hidden = !hasNextPage;
    sentinel.replaceChildren();

    if (!hasNextPage) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ch-btn';
    button.textContent = 'Load more';
    button.addEventListener('click', () => fetchResults(false));

    sentinel.appendChild(button);

    if (!('IntersectionObserver' in window)) return;

    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          hasNextPage &&
          !isLoading
        ) {
          fetchResults(false);
        }
      }, { rootMargin: '200px' });
    }

    observer.observe(sentinel);
  }

  function showError(error, reset) {
    const message = error.status === 429
      ? 'The anime API is rate-limiting requests. Wait a moment, then retry.'
      : error.name === 'TimeoutError'
        ? 'The anime API took too long to respond. Try again.'
        : 'Could not load anime. Try again.';

    const container = reset
      ? $('searchResults')
      : $('searchLoadMore');

    container.replaceChildren();
    container.hidden = false;

    const wrapper = document.createElement('div');
    wrapper.className = 'search-empty';
    wrapper.setAttribute('role', 'alert');

    const text = document.createElement('p');
    text.textContent = message;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ch-btn ch-btn--primary';
    button.textContent = 'Retry';
    button.addEventListener('click', () => fetchResults(reset));

    wrapper.append(text, button);
    container.appendChild(wrapper);
  }

  function invalidateRequest() {
    generation++;

    if (requestController) {
      requestController.abort();
      requestController = null;
    }

    isLoading = false;
    hasNextPage = false;

    disconnectObserver();
    $('searchLoadMore').hidden = true;
    $('searchResults').setAttribute('aria-busy', 'false');
  }

  async function fetchResults(reset = false) {
    if (reset) {
      invalidateRequest();
      currentPage = 0;
      renderedIds = new Set();
      showSkeleton();
    } else if (isLoading || !hasNextPage) {
      return;
    }

    const myGeneration = generation;
    const requestedPage = reset ? 1 : currentPage + 1;

    const controller = new AbortController();
    requestController = controller;
    isLoading = true;

    disconnectObserver();
    $('searchResults').setAttribute('aria-busy', 'true');

    if (!reset) {
      $('searchLoadMore').hidden = false;
      $('searchLoadMore').textContent = 'Loading more results…';
    }

    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let succeeded = false;

    try {
      const { query, variables } = buildRequest(requestedPage);

      const data = await anilistQuery(
        query,
        variables,
        controller.signal
      );

      if (myGeneration !== generation) return;

      const page = data.Page;

      if (reset) {
        $('searchResults').replaceChildren();
      }

      renderCards(page.media);

      currentPage = requestedPage;
      hasNextPage =
        Boolean(page.pageInfo?.hasNextPage) &&
        page.media.length > 0;

      if (!renderedIds.size) {
        const empty = document.createElement('div');
        empty.className = 'search-empty';
        empty.textContent = 'No results found.';
        $('searchResults').replaceChildren(empty);
      }

      succeeded = true;
    } catch (error) {
      if (myGeneration !== generation) return;
      if (controller.signal.aborted && !timedOut) return;

      if (timedOut) {
        error = new Error('Request timed out.');
        error.name = 'TimeoutError';
      }

      console.error('[Search] Request failed:', error);
      showError(error, reset);
    } finally {
      clearTimeout(timeout);

      if (myGeneration === generation) {
        isLoading = false;
        requestController = null;
        $('searchResults').setAttribute('aria-busy', 'false');

        if (succeeded) {
          showLoadMore();
        }
      }
    }
  }

  function runSearch() {
    clearTimeout(debounceTimer);
    readControls();
    updateTitle();
    updateUrl();
    fetchResults(true);
  }

  function restoreFromUrl() {
    const params = new URLSearchParams(location.search);

    $('searchInput').value = (params.get('q') || '').trim();

    selectedValue('filterGenre', params.get('genre'));
    selectedValue('filterYear', params.get('year'));
    selectedValue('filterFormat', params.get('format'));
    selectedValue(
      'filterSort',
      params.get('sort') || 'POPULARITY_DESC',
      'POPULARITY_DESC'
    );

    readControls();
    updateTitle();
  }

  function init() {
    const requiredIds = [
      'searchInput',
      'searchBtn',
      'searchTitle',
      'searchResults',
      'searchLoadMore',
      'filterGenre',
      'filterYear',
      'filterFormat',
      'filterSort'
    ];

    const missing = requiredIds.filter((id) => !$(id));

    if (missing.length) {
      console.error('[Search] Missing page elements:', missing);
      if (typeof window.chPageReady === 'function') {
        window.chPageReady();
      }
      return;
    }

    restoreFromUrl();

    $('searchInput').addEventListener('input', () => {
      clearTimeout(debounceTimer);

      // Invalidate immediately, before the debounce delay.
      invalidateRequest();
      showSkeleton();

      debounceTimer = setTimeout(runSearch, 400);
    });

    $('searchBtn').addEventListener('click', (event) => {
      event.preventDefault();
      runSearch();
    });

    $('searchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    });

    [
      'filterGenre',
      'filterYear',
      'filterFormat',
      'filterSort'
    ].forEach((id) => {
      $(id).addEventListener('change', runSearch);
    });

    window.addEventListener('popstate', () => {
      clearTimeout(debounceTimer);
      restoreFromUrl();
      fetchResults(true);
    });

    fetchResults(true);

    if (typeof window.chPageReady === 'function') {
      window.chPageReady();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
