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
let currentProvider = null;
let countdownTimer = null;
let pendingServerJump = null;
let playbackUnavailable = false;

const serverCache = new Map();

function parseParams() {
  const p = new URLSearchParams(location.search);
  const langRaw = p.get('lang') || p.get('audio') || 'dub';
  return {
    id: p.get('id'),
    ep: parseInt(p.get('ep') || '1', 10) || 1,
    lang: langRaw === 'sub' ? 'sub' : 'dub'
  };
}
function updateUrlParams(opts) {
  const p = new URLSearchParams(location.search);
  p.set('id', anilistId);
  if (opts.ep != null) p.set('ep', opts.ep);
  if (opts.lang != null) p.set('lang', opts.lang);
  p.delete('audio');
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

const MEDIA_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } coverImage { extraLarge large } format episodes duration seasonYear averageScore description(asHtml: false) genres tags { id name rank isMediaSpoiler } status nextAiringEpisode { episode airingAt } } }';

function titleOf(m) { return (m && m.title && (m.title.english || m.title.romaji)) || 'Untitled'; }
function formatFormat(f) {
  if (!f) return '';
  return f.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// ============================================================
// Fetch providers episodes + availability
// ============================================================
async function fetchProvidersEpisodes(anilistId) {
  const reqs = EP_FETCH_PROVIDERS.map(function (p) {
    const url = API_BASE + '/episodes/' + p + '/' + anilistId;
    return fetch(url, { cache: 'no-store' })
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

  // Probe availability
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

// Cap: if nextAiringEpisode exists, only episodes <= episode-1 have aired.
function computeAiredCap(media) {
  if (!media) return null;
  const next = media.nextAiringEpisode;
  if (next && Number.isFinite(Number(next.episode))) return Number(next.episode) - 1;
  return null;
}

function pickBestEpisodeList(results, audio, media) {
  let best = { provider: null, list: [] };
  if (!results.length) return best;

  const airedCap = computeAiredCap(media);
  const expectedCount = (function () {
    const mediaEps = media && Number.isFinite(media.episodes) ? media.episodes : null;
    if (airedCap != null && mediaEps != null) return Math.min(mediaEps, airedCap);
    if (airedCap != null) return airedCap;
    return mediaEps;
  })();

  // Filter candidate lists down to aired eps
  const filterAired = function (list) {
    if (!list || !list.length) return [];
    if (airedCap == null) return list;
    return list.filter(function (e) { return Number(e.number) <= airedCap; });
  };

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
    const raw = audio === 'sub' ? r.sub : r.dub;
    const list = filterAired(raw);
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

  renderNextAiring();
}

// Countdown — always show for RELEASING shows with a next episode, regardless of current ep.
function renderNextAiring() {
  const box = document.getElementById('watchCountdown');
  if (!box) return;
  const next = media && media.nextAiringEpisode;
  if (!next || !next.airingAt) { box.hidden = true; return; }

  const nowSec = Math.floor(Date.now() / 1000);
  if (next.airingAt <= nowSec - 3600) { box.hidden = true; return; } // stale data, don't show

  box.hidden = false;

  const d = new Date(next.airingAt * 1000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() +
    ' · ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  document.getElementById('watchCountdownDate').textContent = 'EP ' + next.episode + ' — ' + dateStr;

  if (countdownTimer) clearInterval(countdownTimer);
  function tick() {
    const n = Math.floor(Date.now() / 1000);
    let diff = next.airingAt - n;
    const el = document.getElementById('watchCountdownTimer');
    if (!el) return;
    if (diff <= 0) { el.textContent = 'Aired'; return; }
    const days = Math.floor(diff / 86400); diff -= days * 86400;
    const hours = Math.floor(diff / 3600); diff -= hours * 3600;
    const mins = Math.floor(diff / 60);
    const secs = diff - mins * 60;
    const parts = [];
    if (days) parts.push(days + 'd');
    if (hours || days) parts.push(hours + 'h');
    if (mins || hours || days) parts.push(mins + 'm');
    parts.push(secs + 's');
    el.textContent = parts.join(' ');
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
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

  const cur = listEl.querySelector('.current');
  if (cur) try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}

function goToEpisode(n) {
  if (n === currentEp) return;
  const found = episodeList.find(function (e) { return Number(e.number) === Number(n); });
  if (!found) {
    if (typeof showToast === 'function') showToast('Episode ' + n + ' isn\'t available');
    return;
  }
  saveNow();
  currentEp = Number(n);
  autoNextFired = false;
  updateUrlParams({ ep: currentEp });
  renderInfo();
  renderEpisodes();
  startPlayback();
}

// Lang toggles removed from top bar; server rows handle it.
function refreshControls() {
  const btnAutoSkip = document.getElementById('btnAutoSkip');
  const btnAutoNext = document.getElementById('btnAutoNext');
  const btnAutoPlay = document.getElementById('btnAutoPlay');
  if (btnAutoSkip) btnAutoSkip.classList.toggle('active', !!appSettings.autoSkip);
  if (btnAutoNext) btnAutoNext.classList.toggle('active', !!appSettings.autoNext);
  if (btnAutoPlay) btnAutoPlay.classList.toggle('active', !!appSettings.autoPlay);
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
  document.getElementById('btnFailover').addEventListener('click', function () {
    saveNow();
    chPipeline.forceFailover();
  });
  const bannerReport = document.getElementById('watchBannerReport');
  if (bannerReport) {
    bannerReport.addEventListener('click', function () {
      if (typeof openReportModal === 'function') {
        openReportModal('Watch — AniList ' + anilistId + ' ep ' + currentEp + ' (' + currentAudio + ')');
      }
    });
  }
  refreshControls();
}

function switchAudio(next) {
  if (next === currentAudio) return;
  if (next === 'sub' && !audioAvail.sub) {
    if (typeof showToast === 'function') showToast('Sub is not available for this title');
    return;
  }
  if (next === 'dub' && !audioAvail.dub) {
    if (typeof showToast === 'function') showToast('Dub is not available for this title');
    return;
  }
  saveNow();
  currentAudio = next;
  appSettings.audio = next;
  saveSettings(appSettings);
  autoNextFired = false;
  updateUrlParams({ lang: next });
  chPlayer.setAudioPreference(next);
  refreshControls();

  if (epCache[next]) {
    episodeList = epCache[next].list.slice();
    renderEpisodes();
  }
  showPlayerSkeleton();
  renderServerRows();
  startPlayback();
}

function saveNow() {
  if (!playerApi || !playerApi.art || !playerApi.art.video) return;
  const v = playerApi.art.video;
  if (!v.currentTime || v.currentTime < 5) return;
  if (!isFinite(v.duration) || v.duration <= 0) return;
  chProgress.set(
    anilistId, titleOf(media),
    media && media.coverImage && (media.coverImage.extraLarge || media.coverImage.large),
    currentEp, currentAudio, v.currentTime, v.duration
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
    const op = tryNum(s0.intro && (s0.intro.start != null ? s0.intro.start : s0.intro.startTime), s0.intro && (s0.intro.end != null ? s0.intro.end : s0.intro.endTime));
    const ed = tryNum(s0.outro && (s0.outro.start != null ? s0.outro.start : s0.outro.startTime), s0.outro && (s0.outro.end != null ? s0.outro.end : s0.outro.endTime));
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

function showUnavailable(reason) {
  playbackUnavailable = true;
  hidePlayerSkeleton();
  const container = document.getElementById('watchPlayer');
  if (!container) return;
  container.querySelectorAll('.artplayer-app, iframe').forEach(function (el) { el.remove(); });
  const badge = document.getElementById('watchBadge');
  if (badge) { badge.textContent = 'Not available'; badge.className = 'watch-player-badge'; }

  const msg = document.createElement('div');
  msg.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;text-align:center;padding:24px;';
  msg.innerHTML = `
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:rgba(217,24,40,0.9)">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <circle cx="12" cy="16" r="0.6" fill="currentColor"/>
    </svg>
    <div style="font-size:15px;font-weight:800">${chEscapeHtml(reason || 'This anime isn\'t available right now.')}</div>
    <div style="font-size:12px;color:rgba(246,244,245,0.55)">Try again later, or view the details page.</div>
  `;
  container.appendChild(msg);
}

async function startPlayback() {
  if (playbackUnavailable) return;
  autoNextFired = false;
  const badge = document.getElementById('watchBadge');
  if (badge) { badge.textContent = 'Loading…'; badge.className = 'watch-player-badge'; }
  showPlayerSkeleton();
  await chPipeline.start({ anilistId: anilistId, ep: currentEp, audio: currentAudio });
}

async function getServersFor(provider, audio, epNum) {
  const key = provider + ':' + anilistId + ':' + epNum + ':' + audio;
  if (serverCache.has(key)) return serverCache.get(key);
  const promise = (async function () {
    try {
      const epRes = await fetch(API_BASE + '/episodes/' + provider + '/' + anilistId, { cache: 'no-store' });
      if (!epRes.ok) return [];
      const data = await epRes.json();
      const list = (data && data[provider] && data[provider].episodes && data[provider].episodes[audio]) || [];
      const ep = list.find(function (e) { return Number(e.number) === Number(epNum); });
      if (!ep) return [];
      const epId = String(ep.id).split('/').pop();
      const watchRes = await fetch(API_BASE + '/watch/' + provider + '/' + anilistId + '/' + audio + '/' + epId, { cache: 'no-store' });
      if (!watchRes.ok) return [];
      const wd = await watchRes.json();
      return (wd && wd.streams ? wd.streams : []).map(function (s, i) {
        return { server: s.server || ('Server ' + (i + 1)), url: s.url, index: i, audio: audio, provider: provider };
      });
    } catch (e) { return []; }
  })();
  serverCache.set(key, promise);
  return promise;
}

async function renderServerRows() {
  const wrap = document.getElementById('watchServers');
  if (!wrap) return;
  if (!currentProvider) {
    wrap.innerHTML = '<div class="watch-servers__loading"><span class="ch-skel ch-skel-line" style="width:220px;display:inline-block"></span></div>';
    return;
  }
  wrap.innerHTML = '<div class="watch-servers__loading"><span class="ch-skel ch-skel-line" style="width:220px;display:inline-block"></span></div>';

  const [subServers, dubServers] = await Promise.all([
    getServersFor(currentProvider, 'sub', currentEp),
    getServersFor(currentProvider, 'dub', currentEp)
  ]);

  const state = chPipeline.getState();
  const activeServer = state.currentEntry && state.currentEntry.stream && state.currentEntry.stream.server;

  function buildRow(audio, servers, label) {
    const row = document.createElement('div');
    row.className = 'watch-server-row watch-server-row--' + audio;
    const labelEl = document.createElement('div');
    labelEl.className = 'watch-server-row__label';
    labelEl.innerHTML = (audio === 'sub'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="14" x2="11" y2="14"/><line x1="7" y1="18" x2="17" y2="18"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>')
      + label;
    const listEl = document.createElement('div');
    listEl.className = 'watch-server-row__list';
    if (!servers.length) {
      const empty = document.createElement('span');
      empty.className = 'watch-server-row__empty';
      empty.textContent = 'No ' + audio + ' servers';
      listEl.appendChild(empty);
    } else {
      servers.forEach(function (s) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'watch-server-pill';
        if (audio === currentAudio && s.server === activeServer) btn.classList.add('is-active');
        btn.innerHTML = '<span class="watch-server-pill__play"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg></span><span>' + chEscapeHtml(s.server) + '</span>';
        btn.addEventListener('click', function () { handleServerClick(audio, s.server); });
        listEl.appendChild(btn);
      });
    }
    row.appendChild(labelEl);
    row.appendChild(listEl);
    return row;
  }

  wrap.innerHTML = '';
  wrap.appendChild(buildRow('sub', subServers, 'Sub'));
  wrap.appendChild(buildRow('dub', dubServers, 'Dub'));
}

function handleServerClick(audio, serverName) {
  if (audio === currentAudio) {
    const jumped = chPipeline.jumpTo(currentProvider, serverName);
    if (!jumped && typeof showToast === 'function') showToast('Server not loaded yet — try again in a moment');
  } else {
    if (audio === 'sub' && !audioAvail.sub) {
      if (typeof showToast === 'function') showToast('Sub is not available for this title');
      return;
    }
    if (audio === 'dub' && !audioAvail.dub) {
      if (typeof showToast === 'function') showToast('Dub is not available for this title');
      return;
    }
    pendingServerJump = { audio: audio, serverName: serverName };
    switchAudio(audio);
  }
}

chPipeline.on('stream', async function (data) {
  const entry = data.entry;
  currentProvider = entry.provider;

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
    container.querySelectorAll('.artplayer-app, iframe, .watch-unavailable').forEach(function (el) { el.remove(); });
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
        chProgress.set(anilistId, titleOf(media), media && media.coverImage && (media.coverImage.extraLarge || media.coverImage.large), currentEp, currentAudio, t, d);
      },
      onEnded: function () {
        if (!appSettings.autoNext || autoNextFired) return;
        autoNextFired = true;
        const state = chPipeline.getState();
        const next = currentEp + 1;
        const found = episodeList.find(function (e) { return Number(e.number) === next; });
        if (!found) return;
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

  renderServerRows();

  if (pendingServerJump && pendingServerJump.audio === currentAudio) {
    const target = pendingServerJump;
    pendingServerJump = null;
    setTimeout(function () { chPipeline.jumpTo(currentProvider, target.serverName); }, 300);
  }
});

chPipeline.on('audio', function () {});
chPipeline.on('status', function (payload) {
  const lvl = payload.level === 'error' ? '[error]' : payload.level === 'warn' ? '[warn]' : '[pipe]';
  console.log(lvl + ' ' + payload.message);
});

chPipeline.on('exhausted', function () {
  if (playbackUnavailable) return;
  showUnavailable('No stream could be loaded for this episode.');
});

// ============================================================
// Similar anime
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
  currentAudio = params.lang;
  appSettings.audio = currentAudio;
  saveSettings(appSettings);
  chPlayer.setAudioPreference(currentAudio);

  wireControls();

  const mediaPromise = anilistQuery(MEDIA_QUERY, { id: Number(anilistId) }).catch(function (e) { console.error(e); return null; });
  const epsPromise = fetchProvidersEpisodes(anilistId).catch(function (e) { console.error('eps fetch failed', e); return { results: [], hasSub: false, hasDub: false }; });

  const mediaData = await mediaPromise;
  media = mediaData && mediaData.Media;
  if (!media) {
    document.getElementById('watchTitle').textContent = 'Failed to load anime';
    return;
  }
  renderInfo();

  const fetched = await epsPromise;
  audioAvail = { sub: fetched.hasSub, dub: fetched.hasDub };

  // If neither sub nor dub available, hard-stop
  if (!audioAvail.sub && !audioAvail.dub) {
    showUnavailable('No streams are available for this title yet.');
    document.getElementById('watchEpList').innerHTML = '<div class="watch-ep-loading">Not available.</div>';
    document.getElementById('watchEpCount').textContent = '—';
    // Still fire similar
    renderSimilar(media).catch(function () {});
    return;
  }

  // Auto-switch if requested audio isn't available
  if (currentAudio === 'dub' && !audioAvail.dub && audioAvail.sub) {
    currentAudio = 'sub'; appSettings.audio = 'sub'; saveSettings(appSettings);
    updateUrlParams({ lang: 'sub' }); chPlayer.setAudioPreference('sub');
  } else if (currentAudio === 'sub' && !audioAvail.sub && audioAvail.dub) {
    currentAudio = 'dub'; appSettings.audio = 'dub'; saveSettings(appSettings);
    updateUrlParams({ lang: 'dub' }); chPlayer.setAudioPreference('dub');
  }
  refreshControls();

  epCache.sub = pickBestEpisodeList(fetched.results, 'sub', media);
  epCache.dub = pickBestEpisodeList(fetched.results, 'dub', media);
  const chosen = currentAudio === 'sub' ? epCache.sub : epCache.dub;
  episodeList = (chosen.list || []).slice().sort(function (a, b) { return Number(a.number) - Number(b.number); });

  // If the requested ep isn't in the list, snap to the last available ep.
  const epExists = episodeList.find(function (e) { return Number(e.number) === Number(currentEp); });
  if (!epExists && episodeList.length) {
    currentEp = Number(episodeList[episodeList.length - 1].number);
    updateUrlParams({ ep: currentEp });
    renderInfo();
  }

  renderEpisodes();

  window.addEventListener('beforeunload', saveNow);
  renderSimilar(media).catch(function (e) { console.warn('Similar render error:', e); });
  startPlayback();
}

document.addEventListener('DOMContentLoaded', initWatch);
