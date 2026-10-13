// ============================================================
// Cloud Hub — watch.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const API_BASE = CH.API_BASE;
const SETTINGS_KEY = CH.STORAGE_SETTINGS;
const EP_FETCH_PROVIDERS = ['reanime', 'anikoto', 'animegg', 'aniwaves', 'senshi', 'anizone', 'kaa'];
const CARD_LAYOUT_THRESHOLD = 12;

const DEFAULTS = { autoSkip: false, autoNext: false, autoPlay: false, subtitlesOn: false, audio: 'dub' };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return Object.assign({}, DEFAULTS);
    return Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {} }
let appSettings = loadSettings();

let anilistId = '';
let currentEp = 1;
let currentAudio = appSettings.audio || 'dub';
let media = null;
let episodeList = [];
let playerApi = null;
let saveTick = 0;
let autoNextFired = false;
let audioAvail = { sub: false, dub: false };
let epCache = { sub: null, dub: null };

function parseParams() {
  const p = new URLSearchParams(location.search);
  return {
    id: p.get('id'),
    ep: parseInt(p.get('ep') || '1', 10) || 1,
    audio: p.get('audio') === 'sub' ? 'sub' : 'dub'
  };
}
function updateUrlParams(opts) {
  const p = new URLSearchParams(location.search);
  p.set('id', anilistId);
  if (opts.ep != null) p.set('ep', opts.ep);
  if (opts.audio != null) p.set('audio', opts.audio);
  history.replaceState(null, '', location.pathname + '?' + p.toString());
}

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  if (!res.ok) throw new Error('AniList HTTP ' + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const MEDIA_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } coverImage { extraLarge large } format episodes duration seasonYear averageScore description(asHtml: false) genres tags { id name rank isMediaSpoiler } } }';

function titleOf(m) { return (m && m.title && (m.title.english || m.title.romaji)) || 'Untitled'; }
function formatFormat(f) {
  if (!f) return '';
  return f.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// ============================================================
// Availability check: use /episodes list counts, PLUS probe /watch
// for the first ep of each provider. A provider only counts for dub
// if the /watch endpoint returns a stream. This prevents false-positive
// dub labels (the "12 eps but shows nothing" bug).
// ============================================================
async function fetchProvidersEpisodes(anilistId) {
  const reqs = EP_FETCH_PROVIDERS.map(function (p) {
    return fetch(API_BASE + '/episodes/' + p + '/' + anilistId, { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return null;
        const block = data[p];
        if (!block || block.error) return null;
        return {
          provider: p,
          sub: (block.episodes && block.episodes.sub) || [],
          dub: (block.episodes && block.episodes.dub) || []
        };
      })
      .catch(function () { return null; });
  });
  const results = (await Promise.all(reqs)).filter(Boolean);

  // Probe /watch for the first ep in each audio mode to confirm usability.
  const probeAudio = async function (audio) {
    for (const r of results) {
      const list = audio === 'sub' ? r.sub : r.dub;
      if (!list.length) continue;
      const epId = String(list[0].id).split('/').pop();
      try {
        const res = await fetch(API_BASE + '/watch/' + r.provider + '/' + anilistId + '/' + audio + '/' + epId, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        const streams = (data && data.streams) || [];
        if (streams.length) return true;
      } catch (e) {}
    }
    return false;
  };

  const [subOk, dubOk] = await Promise.all([probeAudio('sub'), probeAudio('dub')]);

  return { results: results, hasSub: subOk, hasDub: dubOk };
}

function pickBestEpisodeList(results, audio, expectedCount) {
  let best = { provider: null, list: [] };
  if (!results.length) return best;

  const scoreList = function (list) {
    if (!list || !list.length) return -Infinity;
    if (expectedCount != null && expectedCount > 0) {
      const diff = Math.abs(list.length - expectedCount);
      return -diff * 10 + list.length * 0.1;
    }
    return list.length;
  };

  let bestScore = -Infinity;
  for (const r of results) {
    const list = audio === 'sub' ? r.sub : r.dub;
    const s = scoreList(list);
    if (s > bestScore) { bestScore = s; best = { provider: r.provider, list: list }; }
  }
  return best;
}

// ============================================================
// Render
// ============================================================
function renderInfo() {
  if (!media) return;
  document.title = titleOf(media) + ' — Ep ' + currentEp + ' — Cloud Hub';
  const titleEl = document.getElementById('watchTitle');
  titleEl.innerHTML = '<span class="watch-title__ep">EP ' + currentEp + '</span>' + chEscapeHtml(titleOf(media));

  const metaBits = [];
  if (media.averageScore) metaBits.push('<span class="text-cream">★ ' + media.averageScore + '%</span>');
  if (media.format) metaBits.push('<span>' + formatFormat(media.format) + '</span>');
  if (media.seasonYear) metaBits.push('<span>' + media.seasonYear + '</span>');
  if (media.genres && media.genres.length) metaBits.push('<span>' + media.genres.slice(0, 2).join(' · ') + '</span>');
  document.getElementById('watchMeta').innerHTML = metaBits.join('<span class="sep">·</span>');

  document.getElementById('watchPreviewLink').href = '/preview?id=' + media.id;

  const wlBtn = document.getElementById('watchWatchlistBtn');
  const inList = (function () {
    try {
      const w = JSON.parse(localStorage.getItem(CH.STORAGE_WATCHLIST)) || {};
      return !!w[String(media.id)];
    } catch (e) { return false; }
  })();
  wlBtn.textContent = inList ? 'In List' : 'Add to List';
  wlBtn.classList.toggle('ch-btn--ghost', !inList);
  wlBtn.onclick = function () {
    let w = {};
    try { w = JSON.parse(localStorage.getItem(CH.STORAGE_WATCHLIST)) || {}; } catch (e) {}
    const k = String(media.id);
    if (w[k]) delete w[k];
    else w[k] = {
      anilistId: k,
      title: titleOf(media),
      image: media.coverImage && (media.coverImage.extraLarge || media.coverImage.large),
      addedAt: Date.now()
    };
    localStorage.setItem(CH.STORAGE_WATCHLIST, JSON.stringify(w));
    const now = !!w[k];
    wlBtn.textContent = now ? 'In List' : 'Add to List';
    wlBtn.classList.toggle('ch-btn--ghost', !now);
    if (typeof showToast === 'function') showToast(now ? 'Added to your list' : 'Removed from your list');
  };
}

function renderEpisodes() {
  const listEl = document.getElementById('watchEpList');
  const countEl = document.getElementById('watchEpCount');
  listEl.classList.remove('cards', 'pills');

  if (!episodeList.length) {
    listEl.innerHTML = '<div class="watch-ep-loading">No episodes found.</div>';
    countEl.textContent = '—';
    return;
  }
  countEl.textContent = episodeList.length + ' ep' + (episodeList.length === 1 ? '' : 's');

  const watched = chProgress.watchedForShow(anilistId, currentAudio);
  const useCards = episodeList.length <= CARD_LAYOUT_THRESHOLD;
  listEl.classList.add(useCards ? 'cards' : 'pills');
  listEl.innerHTML = '';

  for (const raw of episodeList) {
    const n = Number(raw.number);
    if (!isFinite(n)) continue;
    const isWatched = watched.has(n);
    const isCurrent = n === currentEp;
    const title = raw.title || ('Episode ' + n);
    const thumb = raw.image || (media && media.coverImage && (media.coverImage.extraLarge || media.coverImage.large)) || '';

    if (useCards) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'watch-ep-card';
      if (isWatched) btn.classList.add('watched');
      if (isCurrent) btn.classList.add('current');
      btn.dataset.ep = n;
      btn.innerHTML =
        '<div class="watch-ep-card__thumb" style="background-image:url(\'' + chEscapeHtml(thumb).replace(/'/g, '%27') + '\')"></div>' +
        '<div class="watch-ep-card__body">' +
          '<div class="watch-ep-card__num">Episode ' + n + '</div>' +
          '<div class="watch-ep-card__title">' + chEscapeHtml(title) + '</div>' +
        '</div>';
      btn.addEventListener('click', function () { goToEpisode(n); });
      listEl.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'watch-ep-pill';
      if (isWatched) btn.classList.add('watched');
      if (isCurrent) btn.classList.add('current');
      btn.dataset.ep = n;
      btn.textContent = n;
      btn.title = 'Episode ' + n + (title && title !== 'Episode ' + n ? ' — ' + title : '');
      btn.addEventListener('click', function () { goToEpisode(n); });
      listEl.appendChild(btn);
    }
  }

  const current = listEl.querySelector('.current');
  if (current) try { current.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}

function goToEpisode(n) {
  if (n === currentEp) return;
  saveNow();
  currentEp = n;
  autoNextFired = false;
  updateUrlParams({ ep: currentEp });
  renderInfo();
  renderEpisodes();
  startPlayback();
}

function refreshControls() {
  document.getElementById('btnAutoSkip').classList.toggle('active', !!appSettings.autoSkip);
  document.getElementById('btnAutoNext').classList.toggle('active', !!appSettings.autoNext);
  document.getElementById('btnAutoPlay').classList.toggle('active', !!appSettings.autoPlay);

  const sub = document.getElementById('btnSub');
  const dub = document.getElementById('btnDub');
  sub.classList.toggle('active', currentAudio === 'sub');
  dub.classList.toggle('active', currentAudio === 'dub');

  // Availability: hide the unavailable, keep the current one always visible.
  if (!audioAvail.sub && !audioAvail.dub) {
    // Neither confirmed — show both so user can try.
    sub.style.display = '';
    dub.style.display = '';
  } else {
    sub.style.display = (audioAvail.sub || currentAudio === 'sub') ? '' : 'none';
    dub.style.display = (audioAvail.dub || currentAudio === 'dub') ? '' : 'none';
  }
}

function wireControls() {
  document.getElementById('btnAutoSkip').addEventListener('click', function () {
    appSettings.autoSkip = !appSettings.autoSkip;
    saveSettings(appSettings);
    chPlayer.setSettings(appSettings);
    refreshControls();
  });
  document.getElementById('btnAutoNext').addEventListener('click', function () {
    appSettings.autoNext = !appSettings.autoNext;
    saveSettings(appSettings);
    refreshControls();
  });
  document.getElementById('btnAutoPlay').addEventListener('click', function () {
    appSettings.autoPlay = !appSettings.autoPlay;
    saveSettings(appSettings);
    chPlayer.setSettings(appSettings);
    refreshControls();
  });
  document.getElementById('btnSub').addEventListener('click', function () { switchAudio('sub'); });
  document.getElementById('btnDub').addEventListener('click', function () { switchAudio('dub'); });
  document.getElementById('btnFailover').addEventListener('click', function () {
    saveNow();
    chPipeline.forceFailover();
  });
  refreshControls();
}

function switchAudio(next) {
  if (next === currentAudio) return;
  if (next === 'sub' && audioAvail.sub === false && audioAvail.dub === true) return;
  if (next === 'dub' && audioAvail.dub === false && audioAvail.sub === true) return;

  saveNow();
  currentAudio = next;
  appSettings.audio = next;
  saveSettings(appSettings);
  autoNextFired = false;
  updateUrlParams({ audio: next });
  chPlayer.setAudioPreference(next);
  refreshControls();

  // Swap episode list instantly from cache if available.
  if (epCache[next]) {
    episodeList = epCache[next].list.slice();
    renderEpisodes();
  }

  // Show skeleton again and start playback.
  showPlayerSkeleton();
  startPlayback();
}

function saveNow() {
  if (!playerApi || !playerApi.art || !playerApi.art.video) return;
  const v = playerApi.art.video;
  if (!v.currentTime || v.currentTime < 5) return;
  if (!isFinite(v.duration) || v.duration <= 0) return;
  chProgress.set(
    anilistId,
    titleOf(media),
    media && media.coverImage && (media.coverImage.extraLarge || media.coverImage.large),
    currentEp,
    currentAudio,
    v.currentTime,
    v.duration
  );
}

function computeResumeAt() {
  const saved = chProgress.get(anilistId, currentAudio, currentEp);
  if (saved && saved.currentTime > 5) return saved.currentTime;
  return null;
}

async function resolveSkipIntervals(anilistId, ep, watchData) {
  const s0 = (watchData && watchData.streams && watchData.streams[0]) || {};
  function tryNum(a, b) {
    const s = Number(a), e = Number(b);
    return (isFinite(s) && isFinite(e) && e > s) ? { startTime: s, endTime: e } : null;
  }
  if (s0.intro || s0.outro) {
    const op = tryNum(s0.intro && (s0.intro.start != null ? s0.intro.start : s0.intro.startTime),
                    s0.intro && (s0.intro.end != null ? s0.intro.end : s0.intro.endTime));
    const ed = tryNum(s0.outro && (s0.outro.start != null ? s0.outro.start : s0.outro.startTime),
                    s0.outro && (s0.outro.end != null ? s0.outro.end : s0.outro.endTime));
    if (op || ed) return { op: op, ed: ed };
  }
  if (watchData && (watchData.intro || watchData.outro)) {
    const op = tryNum(watchData.intro && watchData.intro.start, watchData.intro && watchData.intro.end);
    const ed = tryNum(watchData.outro && watchData.outro.start, watchData.outro && watchData.outro.end);
    if (op || ed) return { op: op, ed: ed };
  }
  if (watchData && (watchData.intro_start != null || watchData.outro_start != null)) {
    const op = tryNum(watchData.intro_start, watchData.intro_end);
    const ed = tryNum(watchData.outro_start, watchData.outro_end);
    if (op || ed) return { op: op, ed: ed };
  }
  return { op: null, ed: null };
}

function showPlayerSkeleton() {
  const skel = document.getElementById('watchPlayerSkeleton');
  if (!skel) return;
  skel.classList.remove('is-hidden');
  skel.style.display = '';
}
function hidePlayerSkeleton() {
  const skel = document.getElementById('watchPlayerSkeleton');
  if (!skel) return;
  skel.classList.add('is-hidden');
  skel.style.display = 'none';
}

async function startPlayback() {
  autoNextFired = false;
  const badge = document.getElementById('watchBadge');
  if (badge) { badge.textContent = 'Loading…'; badge.className = 'watch-player-badge'; }
  showPlayerSkeleton();
  await chPipeline.start({ anilistId: anilistId, ep: currentEp, audio: currentAudio });
}

chPipeline.on('stream', async function (data) {
  const entry = data.entry;
  const badge = document.getElementById('watchBadge');
  if (badge) {
    const providerIdx = chPipeline.getState().workList.indexOf(entry);
    badge.textContent = entry.provider.toUpperCase() + ' / ' + (entry.stream.server || '?') + ' [' + (entry.isMp4 ? 'MP4' : 'HLS') + ']';
    badge.className = 'watch-player-badge ' + (entry.isMp4 ? 'mp4' : 'provider-' + (Math.max(0, providerIdx) % 5));
  }

  const stream = entry.stream;
  const key = stream.playlist_key || stream.key || '';
  const type = entry.isMp4 ? 'mp4' : '';
  let proxied = API_BASE + '/proxy/flix-stream?url=' + encodeURIComponent(stream.url) + '&key=' + encodeURIComponent(key);
  if (type) proxied += '&type=' + type;
  if (data.referer) proxied += '&referer=' + encodeURIComponent(data.referer);
  if (data.userAgent) proxied += '&ua=' + encodeURIComponent(data.userAgent);

  const fonts = entry.isMp4 ? null : await chSubs.fetchFonts(entry.watchData);
  const skip = await resolveSkipIntervals(anilistId, currentEp, entry.watchData).catch(function () { return null; });
  chPlayer.setSkipIntervals(skip && skip.op, skip && skip.ed);

  const resumeAt = computeResumeAt();
  chPlayer.setSettings(appSettings);
  chPlayer.setAudioPreference(currentAudio);

  const container = document.getElementById('watchPlayer');
  if (container) {
    container.querySelectorAll('.artplayer-app, iframe').forEach(function (el) { el.remove(); });
  }

  playerApi = await chPlayer.mount({
    container: container,
    streamUrl: proxied,
    isMp4: entry.isMp4,
    watchData: entry.watchData,
    fonts: fonts,
    settings: appSettings,
    subtitlesOn: appSettings.subtitlesOn,
    resumeAt: resumeAt,
    onSelectSubtitle: function (item) {
      appSettings.subtitlesOn = !!item.url;
      saveSettings(appSettings);
    },
    callbacks: {
      onReady: function () { hidePlayerSkeleton(); },
      onPlaying: function () { hidePlayerSkeleton(); },
      onTimeUpdate: function (t, d) {
        const now = Date.now();
        if (now - saveTick < 5000) return;
        saveTick = now;
        if (!isFinite(t) || t < 5) return;
        if (!isFinite(d) || d <= 0) return;
        chProgress.set(
          anilistId,
          titleOf(media),
          media && media.coverImage && (media.coverImage.extraLarge || media.coverImage.large),
          currentEp,
          currentAudio,
          t,
          d
        );
      },
      onEnded: function () {
        if (!appSettings.autoNext || autoNextFired) return;
        autoNextFired = true;
        const state = chPipeline.getState();
        const next = currentEp + 1;
        if (next > state.maxEp) return;
        saveNow();
        currentEp = next;
        updateUrlParams({ ep: currentEp });
        renderInfo();
        renderEpisodes();
        startPlayback();
      },
      onError: function () { saveNow(); chPipeline.forceFailover(); },
      onHlsFatal: function () { saveNow(); chPipeline.forceFailover(); },
      onDestroy: function () { saveNow(); }
    }
  });
});

chPipeline.on('audio', function () { refreshControls(); });

chPipeline.on('status', function (payload) {
  const lvl = payload.level === 'error' ? '[error]' : payload.level === 'warn' ? '[warn]' : '[pipe]';
  console.log(lvl + ' ' + payload.message);
});

chPipeline.on('exhausted', function () {
  hidePlayerSkeleton();
  const container = document.getElementById('watchPlayer');
  if (!container) return;
  container.querySelectorAll('.artplayer-app, iframe').forEach(function (el) { el.remove(); });
  const badge = document.getElementById('watchBadge');
  if (badge) {
    badge.textContent = 'IFRAME FALLBACK';
    badge.className = 'watch-player-badge iframe';
  }
  const iframe = document.createElement('iframe');
  iframe.src = 'https://megaplay.buzz/stream/ani/' + anilistId + '/' + currentEp + '/' + currentAudio;
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('referrerpolicy', 'origin');
  container.appendChild(iframe);
});

// ============================================================
// Similar anime — no box, free layout, with timeout
// ============================================================
const SIMILAR_RECS_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { recommendations(perPage: 10, sort: RATING_DESC) { nodes { mediaRecommendation { id title { romaji english } coverImage { large extraLarge } format averageScore seasonYear } } } } }';
const SIMILAR_TAG_QUERY = 'query ($tag: String) { Page(page: 1, perPage: 12) { media(type: ANIME, tag: $tag, sort: POPULARITY_DESC, isAdult: false) { id title { romaji english } coverImage { large extraLarge } format averageScore seasonYear } } }';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })
  ]);
}

async function renderSimilar(mediaArg) {
  const wrap = document.getElementById('watchSimilarList');
  if (!wrap || !mediaArg) return;

  let items = [];
  try {
    const data = await withTimeout(anilistQuery(SIMILAR_RECS_QUERY, { id: mediaArg.id }), 8000);
    const nodes = (data && data.Media && data.Media.recommendations && data.Media.recommendations.nodes) || [];
    items = nodes.map(function (n) { return n.mediaRecommendation; }).filter(function (m) { return m && m.id !== mediaArg.id; });
  } catch (e) { console.warn('Similar recs failed:', e.message); }

  if (items.length < 6) {
    const topTags = (mediaArg.tags || []).filter(function (t) { return !t.isMediaSpoiler; })
      .sort(function (a, b) { return b.rank - a.rank; }).slice(0, 2);
    for (const tag of topTags) {
      if (items.length >= 8) break;
      try {
        const data = await withTimeout(anilistQuery(SIMILAR_TAG_QUERY, { tag: tag.name }), 6000);
        const extra = (data && data.Page && data.Page.media) || [];
        const seen = new Set(items.map(function (m) { return m.id; }));
        for (const m of extra) {
          if (seen.has(m.id) || m.id === mediaArg.id) continue;
          items.push(m); seen.add(m.id);
          if (items.length >= 10) break;
        }
      } catch (e) {}
    }
  }

  items = items.slice(0, 8);
  if (!items.length) {
    wrap.innerHTML = '<div class="watch-similar-loading">No recommendations.</div>';
    return;
  }

  wrap.innerHTML = '';
  for (const m of items) {
    const cover = (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '';
    const a = document.createElement('a');
    a.className = 'watch-similar-item';
    a.href = '/preview?id=' + m.id;

    const metaBits = [];
    if (m.format) metaBits.push(formatFormat(m.format));
    if (m.seasonYear) metaBits.push(m.seasonYear);
    const scoreHtml = m.averageScore ? '<span class="watch-similar-item__score">★ ' + m.averageScore + '</span>' : '';

    a.innerHTML =
      '<div class="watch-similar-item__thumb"><img src="' + chEscapeHtml(cover) + '" alt="" loading="lazy"></div>' +
      '<div class="watch-similar-item__body">' +
        '<div class="watch-similar-item__title">' + chEscapeHtml(titleOf(m)) + '</div>' +
        '<div class="watch-similar-item__meta">' + metaBits.join(' · ') + (scoreHtml ? '  ' + scoreHtml : '') + '</div>' +
      '</div>';
    wrap.appendChild(a);
  }
}

// ============================================================
// Boot
// ============================================================
async function initWatch() {
  const params = parseParams();
  if (!params.id) {
    document.getElementById('watchTitle').textContent = 'No anime specified';
    document.getElementById('watchMeta').innerHTML = '<a href="/home">Return home</a>';
    document.getElementById('watchEpList').innerHTML = '<div class="watch-ep-loading">—</div>';
    return;
  }
  anilistId = params.id;
  currentEp = params.ep;
  currentAudio = params.audio;
  appSettings.audio = currentAudio;
  saveSettings(appSettings);
  chPlayer.setAudioPreference(currentAudio);

  wireControls();
  if (typeof mountReportButton === 'function') mountReportButton('Watch page — ' + anilistId);

  const mediaPromise = anilistQuery(MEDIA_QUERY, { id: Number(anilistId) }).catch(function (e) { console.error(e); return null; });
  const epsPromise = fetchProvidersEpisodes(anilistId).catch(function () { return { results: [], hasSub: false, hasDub: false }; });

  const mediaData = await mediaPromise;
  media = mediaData && mediaData.Media;
  if (!media) {
    document.getElementById('watchTitle').textContent = 'Failed to load anime';
    return;
  }
  renderInfo();

  const fetched = await epsPromise;
  audioAvail = { sub: fetched.hasSub, dub: fetched.hasDub };

  // Auto-correct if requested audio unavailable.
  if (currentAudio === 'dub' && !audioAvail.dub && audioAvail.sub) {
    currentAudio = 'sub';
    appSettings.audio = 'sub';
    saveSettings(appSettings);
    updateUrlParams({ audio: 'sub' });
    chPlayer.setAudioPreference('sub');
  } else if (currentAudio === 'sub' && !audioAvail.sub && audioAvail.dub) {
    currentAudio = 'dub';
    appSettings.audio = 'dub';
    saveSettings(appSettings);
    updateUrlParams({ audio: 'dub' });
    chPlayer.setAudioPreference('dub');
  }
  refreshControls();

  // Cache both lists.
  epCache.sub = pickBestEpisodeList(fetched.results, 'sub', media.episodes);
  epCache.dub = pickBestEpisodeList(fetched.results, 'dub', media.episodes);
  const chosen = currentAudio === 'sub' ? epCache.sub : epCache.dub;
  episodeList = (chosen.list || []).slice().sort(function (a, b) { return Number(a.number) - Number(b.number); });
  renderEpisodes();

  window.addEventListener('beforeunload', saveNow);
  renderSimilar(media).catch(function (e) { console.warn('Similar render error:', e); });
  startPlayback();
}

document.addEventListener('DOMContentLoaded', initWatch);
