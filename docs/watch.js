// ============================================================
// Cloud Hub — watch.js
// Orchestrator for the watch page:
//   - URL params → anilistId, ep, audio
//   - Fetch AniList media for title/meta/description
//   - Fetch reanime episodes for sidebar
//   - Render info block, sidebar, controls
//   - Start pipeline, mount player on 'stream'
//   - Handle progress save, auto-next, sub/dub switch
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const API_BASE = CH.API_BASE;
const SETTINGS_KEY = CH.STORAGE_SETTINGS;

// ---------- settings ----------
const DEFAULTS = { autoSkip: false, autoNext: false, autoPlay: false, subtitlesOn: false, audio: 'dub' };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
let appSettings = loadSettings();

// ---------- page state ----------
let anilistId = '';
let currentEp = 1;
let currentAudio = appSettings.audio || 'dub';
let media = null;
let episodeList = [];
let playerApi = null;
let currentEntry = null;
let saveTick = 0;
let autoNextFired = false;

// ---------- URL params ----------
function parseParams() {
  const p = new URLSearchParams(location.search);
  const id = p.get('id');
  const ep = parseInt(p.get('ep') || '1', 10) || 1;
  const audio = p.get('audio') === 'sub' ? 'sub' : 'dub';
  return { id, ep, audio };
}
function updateUrlParams({ ep, audio }) {
  const p = new URLSearchParams(location.search);
  p.set('id', anilistId);
  if (ep != null) p.set('ep', ep);
  if (audio != null) p.set('audio', audio);
  history.replaceState(null, '', `${location.pathname}?${p}`);
}

// ---------- AniList ----------
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

const MEDIA_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title { romaji english }
      coverImage { extraLarge large }
      format
      episodes
      duration
      seasonYear
      averageScore
      description(asHtml: false)
      genres
    }
  }
`;

function titleOf(m) {
  return m?.title?.english || m?.title?.romaji || 'Untitled';
}
function formatFormat(f) {
  if (!f) return '';
  return f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- render info ----------
function renderInfo() {
  if (!media) return;
  document.title = `${titleOf(media)} — Ep ${currentEp} — Cloud Hub`;

  const titleEl = document.getElementById('watchTitle');
  titleEl.innerHTML = `
    <span class="watch-title__ep">EP ${currentEp}</span>${chEscapeHtml(titleOf(media))}
  `;

  const metaBits = [];
  if (media.averageScore) metaBits.push(`<span class="text-cream">★ ${media.averageScore}%</span>`);
  if (media.format) metaBits.push(`<span>${formatFormat(media.format)}</span>`);
  if (media.seasonYear) metaBits.push(`<span>${media.seasonYear}</span>`);
  if (media.genres?.length) metaBits.push(`<span>${media.genres.slice(0, 2).join(' · ')}</span>`);
  document.getElementById('watchMeta').innerHTML = metaBits.join('<span class="sep">·</span>');

  const link = document.getElementById('watchPreviewLink');
  link.href = `/preview?id=${media.id}`;

  const wlBtn = document.getElementById('watchWatchlistBtn');
  const inList = (() => {
    try {
      const w = JSON.parse(localStorage.getItem(CH.STORAGE_WATCHLIST)) || {};
      return !!w[String(media.id)];
    } catch { return false; }
  })();
  wlBtn.textContent = inList ? 'In List' : 'Add to List';
  wlBtn.classList.toggle('ch-btn--ghost', !inList);
  wlBtn.onclick = () => {
    const w = (() => {
      try { return JSON.parse(localStorage.getItem(CH.STORAGE_WATCHLIST)) || {}; }
      catch { return {}; }
    })();
    const k = String(media.id);
    if (w[k]) delete w[k];
    else w[k] = {
      anilistId: k,
      title: titleOf(media),
      image: media.coverImage?.extraLarge || media.coverImage?.large,
      addedAt: Date.now()
    };
    localStorage.setItem(CH.STORAGE_WATCHLIST, JSON.stringify(w));
    const now = !!w[k];
    wlBtn.textContent = now ? 'In List' : 'Add to List';
    wlBtn.classList.toggle('ch-btn--ghost', !now);
    if (typeof showToast === 'function') showToast(now ? 'Added to your list' : 'Removed from your list');
  };
}

// ---------- render episodes sidebar ----------
async function fetchEpisodeList() {
  try {
    const res = await fetch(`${API_BASE}/episodes/reanime/${anilistId}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const block = data.reanime;
    if (!block || block.error) return [];
    const sub = block.episodes?.sub || [];
    const dub = block.episodes?.dub || [];
    // Use sub list as canonical (more complete).
    const list = (sub.length >= dub.length ? sub : dub).slice();
    list.sort((a, b) => Number(a.number) - Number(b.number));
    return list;
  } catch { return []; }
}

function renderEpisodes() {
  const listEl = document.getElementById('watchEpList');
  const countEl = document.getElementById('watchEpCount');

  if (!episodeList.length) {
    listEl.innerHTML = '<div class="watch-sidebar__loading">No episodes found.</div>';
    countEl.textContent = '—';
    return;
  }
  countEl.textContent = `${episodeList.length} ep${episodeList.length === 1 ? '' : 's'}`;

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
    btn.addEventListener('click', () => {
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

  // Scroll current into view
  const current = listEl.querySelector('.watch-ep.current');
  if (current) try { current.scrollIntoView({ block: 'nearest' }); } catch {}
}

// ---------- control toggles ----------
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
  const { ep, audio } = parseParams();
  if (audio) { currentAudio = audio; appSettings.audio = audio; saveSettings(appSettings); }
  if (ep) currentEp = ep;

  document.getElementById('btnAutoSkip').addEventListener('click', () => {
    appSettings.autoSkip = !appSettings.autoSkip;
    saveSettings(appSettings);
    chPlayer.setSettings(appSettings);
    refreshControls();
  });
  document.getElementById('btnAutoNext').addEventListener('click', () => {
    appSettings.autoNext = !appSettings.autoNext;
    saveSettings(appSettings);
    refreshControls();
  });
  document.getElementById('btnAutoPlay').addEventListener('click', () => {
    appSettings.autoPlay = !appSettings.autoPlay;
    saveSettings(appSettings);
    chPlayer.setSettings(appSettings);
    refreshControls();
  });

  document.getElementById('btnSub').addEventListener('click', () => switchAudio('sub'));
  document.getElementById('btnDub').addEventListener('click', () => switchAudio('dub'));

  document.getElementById('btnFailover').addEventListener('click', () => {
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
  currentEp = currentEp; // reset
  autoNextFired = false;
  updateUrlParams({ audio: next });
  chPlayer.setAudioPreference(next);
  refreshControls();
  renderEpisodes();
  startPlayback();
}

// ---------- progress save ----------
function saveNow() {
  if (!playerApi?.art?.video) return;
  const v = playerApi.art.video;
  if (!v.currentTime || v.currentTime < 5) return;
  if (!isFinite(v.duration) || v.duration <= 0) return;
  chProgress.set(
    anilistId,
    titleOf(media),
    media?.coverImage?.extraLarge || media?.coverImage?.large,
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

// ---------- skip intervals ----------
async function resolveSkipIntervals(anilistId, ep, watchData) {
  // 1) payload sources
  const s0 = (watchData?.streams && watchData.streams[0]) || {};
  const tryNum = (a, b) => {
    const s = Number(a), e = Number(b);
    return Number.isFinite(s) && Number.isFinite(e) && e > s ? { startTime: s, endTime: e } : null;
  };
  if (s0.intro || s0.outro) {
    const op = tryNum(s0.intro?.start ?? s0.intro?.startTime, s0.intro?.end ?? s0.intro?.endTime);
    const ed = tryNum(s0.outro?.start ?? s0.outro?.startTime, s0.outro?.end ?? s0.outro?.endTime);
    if (op || ed) return { op, ed };
  }
  if (watchData?.intro || watchData?.outro) {
    const op = tryNum(watchData.intro?.start, watchData.intro?.end);
    const ed = tryNum(watchData.outro?.start, watchData.outro?.end);
    if (op || ed) return { op, ed };
  }
  if (watchData?.intro_start != null || watchData?.outro_start != null) {
    const op = tryNum(watchData.intro_start, watchData.intro_end);
    const ed = tryNum(watchData.outro_start, watchData.outro_end);
    if (op || ed) return { op, ed };
  }
  // 2) external — best-effort, silent failure
  return { op: null, ed: null };
}

// ---------- playback ----------
async function startPlayback() {
  autoNextFired = false;
  document.getElementById('watchBadge').textContent = 'Loading…';
  document.getElementById('watchBadge').className = 'watch-player__badge';
  await chPipeline.start({ anilistId, ep: currentEp, audio: currentAudio });
}

chPipeline.on('stream', async (data) => {
  currentEntry = data.entry;

  const badge = document.getElementById('watchBadge');
  const providerIdx = chPipeline.getState().workList.findIndex(w => w === data.entry);
  badge.textContent = `${data.entry.provider.toUpperCase()} / ${data.entry.stream.server || '?'} [${data.entry.isMp4 ? 'MP4' : 'HLS'}]`;
  badge.className = `watch-player__badge ${data.entry.isMp4 ? 'mp4' : 'provider-' + (Math.max(0, providerIdx) % 5)}`;

  // Build proxy URL
  const stream = data.entry.stream;
  const key = stream.playlist_key || stream.key || '';
  const type = data.entry.isMp4 ? 'mp4' : '';
  let proxied = `${API_BASE}/proxy/flix-stream?url=${encodeURIComponent(stream.url)}&key=${encodeURIComponent(key)}`;
  if (type) proxied += `&type=${type}`;
  if (data.referer) proxied += `&referer=${encodeURIComponent(data.referer)}`;
  if (data.userAgent) proxied += `&ua=${encodeURIComponent(data.userAgent)}`;

  // Fonts (only for HLS with libass)
  const fonts = data.entry.isMp4 ? null : await chSubs.fetchFonts(data.entry.watchData);

  // Skip intervals
  const skip = await resolveSkipIntervals(anilistId, currentEp, data.entry.watchData).catch(() => null);
  chPlayer.setSkipIntervals(skip?.op, skip?.ed);

  // Resume
  const resumeAt = computeResumeAt();

  // Wire player
  chPlayer.setSettings(appSettings);
  chPlayer.setAudioPreference(currentAudio);

  const container = document.getElementById('watchPlayer');
  // Remove old artplayer-app if present
  container.querySelectorAll('.artplayer-app').forEach(el => el.remove());

  playerApi = await chPlayer.mount({
    container,
    streamUrl: proxied,
    isMp4: data.entry.isMp4,
    watchData: data.entry.watchData,
    fonts,
    settings: appSettings,
    subtitlesOn: appSettings.subtitlesOn,
    resumeAt,
    onSelectSubtitle: (item) => {
      appSettings.subtitlesOn = !!item.url;
      saveSettings(appSettings);
    },
    callbacks: {
      onReady: () => {},
      onPlaying: () => {
        // Badge stays visible for a beat then fades
      },
      onTimeUpdate: (t, d) => {
        const now = Date.now();
        if (now - saveTick < 5000) return;
        saveTick = now;
        if (!isFinite(t) || t < 5) return;
        if (!isFinite(d) || d <= 0) return;
        chProgress.set(
          anilistId,
          titleOf(media),
          media?.coverImage?.extraLarge || media?.coverImage?.large,
          currentEp,
          currentAudio,
          t, d
        );
      },
      onEnded: () => {
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
      onError: (reason) => {
        saveNow();
        chPipeline.forceFailover();
      },
      onHlsFatal: (reason) => {
        saveNow();
        chPipeline.forceFailover();
      },
      onDestroy: () => {
        saveNow();
      }
    }
  });
});

chPipeline.on('audio', () => {
  refreshControls();
});

chPipeline.on('status', ({ message, level }) => {
  // For now, log only — the UI doesn't render pipeline logs.
  const prefix = level === 'error' ? '[error]' : level === 'warn' ? '[warn]' : '[pipe]';
  console.log(`${prefix} ${message}`);
});

chPipeline.on('exhausted', () => {
  // No provider worked — show iframe fallback
  const container = document.getElementById('watchPlayer');
  container.querySelectorAll('.artplayer-app, iframe').forEach(el => el.remove());

  const badge = document.getElementById('watchBadge');
  badge.textContent = 'IFRAME FALLBACK';
  badge.className = 'watch-player__badge iframe';

  const iframe = document.createElement('iframe');
  iframe.src = `https://megaplay.buzz/stream/ani/${anilistId}/${currentEp}/${currentAudio}`;
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('referrerpolicy', 'origin');
  container.appendChild(iframe);
});

// ---------- Boot ----------
async function initWatch() {
  const { id, ep, audio } = parseParams();
  if (!id) {
    document.getElementById('watchTitle').textContent = 'No anime specified';
    document.getElementById('watchMeta').innerHTML = '<a href="/home">Return home</a>';
    document.getElementById('watchEpList').innerHTML = '<div class="watch-sidebar__loading">—</div>';
    return;
  }
  anilistId = id;
  currentEp = ep;
  currentAudio = audio;
  chPlayer.setAudioPreference(currentAudio);

  // Wire controls first so toggles work during load
  wireControls();

  // Fetch media
  try {
    const data = await anilistQuery(MEDIA_QUERY, { id: Number(anilistId) });
    media = data?.Media;
  } catch (e) { console.error('Media fetch failed:', e); }

  if (!media) {
    document.getElementById('watchTitle').textContent = 'Failed to load anime';
    return;
  }
  renderInfo();

  // Fetch episode list (async, not blocking)
  episodeList = await fetchEpisodeList();
  renderEpisodes();
  refreshControls();

  // Save on unload
  window.addEventListener('beforeunload', saveNow);

  // Start playback
  startPlayback();
}

document.addEventListener('DOMContentLoaded', initWatch);
