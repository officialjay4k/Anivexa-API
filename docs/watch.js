// ============================================================
// Cloud Hub — watch.js
// Orchestrates the watch page.
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const API_BASE = CH.API_BASE;
const SETTINGS_KEY = CH.STORAGE_SETTINGS;

const DEFAULTS = { autoSkip: false, autoNext: false, autoPlay: false, subtitlesOn: false, audio: 'dub' };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return Object.assign({}, DEFAULTS);
    return Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}
let appSettings = loadSettings();

let anilistId = '';
let currentEp = 1;
let currentAudio = appSettings.audio || 'dub';
let media = null;
let episodeList = [];
let playerApi = null;
let saveTick = 0;
let autoNextFired = false;

function parseParams() {
  const p = new URLSearchParams(location.search);
  const id = p.get('id');
  const ep = parseInt(p.get('ep') || '1', 10) || 1;
  const audio = p.get('audio') === 'sub' ? 'sub' : 'dub';
  return { id: id, ep: ep, audio: audio };
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

const MEDIA_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } coverImage { extraLarge large } format episodes duration seasonYear averageScore description(asHtml: false) genres } }';

function titleOf(m) {
  return (m && m.title && (m.title.english || m.title.romaji)) || 'Untitled';
}
function formatFormat(f) {
  if (!f) return '';
  return f.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

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

async function fetchEpisodeList() {
  try {
    const res = await fetch(API_BASE + '/episodes/reanime/' + anilistId, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const block = data.reanime;
    if (!block || block.error) return [];
    const sub = (block.episodes && block.episodes.sub) || [];
    const dub = (block.episodes && block.episodes.dub) || [];
    const list = (sub.length >= dub.length ? sub : dub).slice();
    list.sort(function (a, b) { return Number(a.number) - Number(b.number); });
    return list;
  } catch (e) { return []; }
}

function renderEpisodes() {
  const listEl = document.getElementById('watchEpList');
  const countEl = document.getElementById('watchEpCount');

  if (!episodeList.length) {
    listEl.innerHTML = '<div class="watch-sidebar__loading">No episodes found.</div>';
    countEl.textContent = '—';
    return;
  }
  countEl.textContent = episodeList.length + ' ep' + (episodeList.length === 1 ? '' : 's');

  const watched = chProgress.watchedForShow(anilistId, currentAudio);

  listEl.innerHTML = '';
  for (const raw of episodeList) {
    const n = Number(raw.number);
    if (!isFinite(n)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'watch-ep';
    btn.dataset.ep = n;
    btn.textContent = n;
    if (watched.has(n)) btn.classList.add('watched');
    if (n === currentEp) btn.classList.add('current');
    btn.addEventListener('click', function () {
      if (n === currentEp) return;
      saveNow();
      currentEp = n;
      autoNextFired = false;
      updateUrlParams({ ep: currentEp });
      renderInfo();
      renderEpisodes();
      startPlayback();
    });
    listEl.appendChild(btn);
  }

  const current = listEl.querySelector('.watch-ep.current');
  if (current) try { current.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}

function refreshControls() {
  document.getElementById('btnAutoSkip').classList.toggle('active', !!appSettings.autoSkip);
  document.getElementById('btnAutoNext').classList.toggle('active', !!appSettings.autoNext);
  document.getElementById('btnAutoPlay').classList.toggle('active', !!appSettings.autoPlay);

  const sub = document.getElementById('btnSub');
  const dub = document.getElementById('btnDub');
  sub.classList.toggle('active', currentAudio === 'sub');
  dub.classList.toggle('active', currentAudio === 'dub');

  const avail = chPipeline.getState().availability;
  sub.disabled = !avail.sub && currentAudio !== 'sub';
  dub.disabled = !avail.dub && currentAudio !== 'dub';
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
  if (next === 'sub' && !chPipeline.getState().availability.sub) return;
  if (next === 'dub' && !chPipeline.getState().availability.dub) return;
  saveNow();
  currentAudio = next;
  appSettings.audio = next;
  saveSettings(appSettings);
  autoNextFired = false;
  updateUrlParams({ audio: next });
  chPlayer.setAudioPreference(next);
  refreshControls();
  renderEpisodes();
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

async function startPlayback() {
  autoNextFired = false;
  const badge = document.getElementById('watchBadge');
  badge.textContent = 'Loading…';
  badge.className = 'watch-player__badge';
  await chPipeline.start({ anilistId: anilistId, ep: currentEp, audio: currentAudio });
}

chPipeline.on('stream', async function (data) {
  const entry = data.entry;
  const badge = document.getElementById('watchBadge');
  const providerIdx = chPipeline.getState().workList.indexOf(entry);
  badge.textContent = entry.provider.toUpperCase() + ' / ' + (entry.stream.server || '?') + ' [' + (entry.isMp4 ? 'MP4' : 'HLS') + ']';
  badge.className = 'watch-player__badge ' + (entry.isMp4 ? 'mp4' : 'provider-' + (Math.max(0, providerIdx) % 5));

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
  container.querySelectorAll('.artplayer-app').forEach(function (el) { el.remove(); });

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
      onReady: function () {},
      onPlaying: function () {},
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
      onError: function () {
        saveNow();
        chPipeline.forceFailover();
      },
      onHlsFatal: function () {
        saveNow();
        chPipeline.forceFailover();
      },
      onDestroy: function () {
        saveNow();
      }
    }
  });
});

chPipeline.on('audio', function () { refreshControls(); });

chPipeline.on('status', function (payload) {
  const lvl = payload.level === 'error' ? '[error]' : payload.level === 'warn' ? '[warn]' : '[pipe]';
  console.log(lvl + ' ' + payload.message);
});

chPipeline.on('exhausted', function () {
  const container = document.getElementById('watchPlayer');
  container.querySelectorAll('.artplayer-app, iframe').forEach(function (el) { el.remove(); });

  const badge = document.getElementById('watchBadge');
  badge.textContent = 'IFRAME FALLBACK';
  badge.className = 'watch-player__badge iframe';

  const iframe = document.createElement('iframe');
  iframe.src = 'https://megaplay.buzz/stream/ani/' + anilistId + '/' + currentEp + '/' + currentAudio;
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('referrerpolicy', 'origin');
  container.appendChild(iframe);
});

async function initWatch() {
  const params = parseParams();
  if (!params.id) {
    document.getElementById('watchTitle').textContent = 'No anime specified';
    document.getElementById('watchMeta').innerHTML = '<a href="/home">Return home</a>';
    document.getElementById('watchEpList').innerHTML = '<div class="watch-sidebar__loading">—</div>';
    return;
  }
  anilistId = params.id;
  currentEp = params.ep;
  currentAudio = params.audio;
  appSettings.audio = currentAudio;
  saveSettings(appSettings);
  chPlayer.setAudioPreference(currentAudio);

  wireControls();

  try {
    const data = await anilistQuery(MEDIA_QUERY, { id: Number(anilistId) });
    media = data && data.Media;
  } catch (e) { console.error('Media fetch failed:', e); }

  if (!media) {
    document.getElementById('watchTitle').textContent = 'Failed to load anime';
    return;
  }
  renderInfo();

  episodeList = await fetchEpisodeList();
  renderEpisodes();
  refreshControls();

  window.addEventListener('beforeunload', saveNow);

  startPlayback();
}

document.addEventListener('DOMContentLoaded', initWatch);
