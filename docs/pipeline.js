// ============================================================
// Cloud Hub — pipeline.js
// Provider chain, flat work list, background fetch, subtitle
// fallback escalation. Emits events that watch.js consumes:
//   'stream'   → a stream is ready to mount ({ entry, ...})
//   'status'   → { message, level }
//   'audio'    → { sub: bool, dub: bool }
//   'exhausted'→ all sources failed → iframe fallback
// ============================================================

const chPipeline = (() => {
  const API_BASE = CH.API_BASE;
  const NOSTORE = { cache: 'no-store' };
  const MAX_UNIQUE_FRAGMENT_ERRORS = 3; // exposed for player.js
  const SUBTITLE_WAIT_MS = 5000;
  const DEFAULT_PROVIDER = 'reanime';
  const PROVIDER_CHAIN = [
    'mkissa', 'senshi', 'anikoto', 'animegg',
    'aniwaves', 'anibd', 'reanime', 'anizone', 'kaa'
  ];

  const events = new EventTarget();
  function on(type, handler) { events.addEventListener(type, e => handler(e.detail)); }
  function emit(type, detail) { events.dispatchEvent(new CustomEvent(type, { detail })); }

  const S = {
    anilistId: '',
    ep: 1,
    audio: 'dub',
    chain: [],
    workList: [],
    workIndex: 0,
    pendingHls: [],
    pendingMp4: [],
    bgActive: false,
    gen: 0,
    maxEp: 1,
    availability: { sub: false, dub: false },
    currentEntry: null,
    currentStreamReferer: null,
    currentStreamUa: null,
    aborted: false
  };

  function reset(newState) {
    S.gen++;
    S.chain = newState.chain;
    S.anilistId = newState.anilistId;
    S.ep = newState.ep;
    S.audio = newState.audio;
    S.workList = [];
    S.workIndex = 0;
    S.pendingHls = [];
    S.pendingMp4 = [];
    S.bgActive = false;
    S.maxEp = newState.ep;
    S.availability = { sub: false, dub: false };
    S.currentEntry = null;
    S.aborted = false;
  }

  function log(msg, level = 'info') {
    emit('status', { message: msg, level });
  }

  // ---------- stream classification ----------
  function isMp4(stream) {
    const url = stream.url || '';
    if (stream.type === 'mp4') return true;
    if (stream.type === 'hls') return false;
    return /\.mp4(\?|$)/i.test(url);
  }

  function normalizeStreams(watchData) {
    let streams = watchData.streams || [];
    if (streams.length) return streams;
    if (Array.isArray(watchData.sources)) {
      streams = watchData.sources
        .filter(s => s.extractedUrl && s.extractedType)
        .map(s => ({
          server: s.name || 'unknown',
          audio: 'sub',
          url: s.extractedUrl,
          type: s.extractedType === 'mp4' ? 'mp4' : 'hls',
          referer: (s.headers && s.headers.Referer) || null,
          userAgent: (s.headers && s.headers['User-Agent']) || null
        }));
    }
    return streams;
  }

  function normalizeEmbeds(watchData) {
    if (Array.isArray(watchData.embeds) && watchData.embeds.length) return;
    if (Array.isArray(watchData.sources)) {
      const embeds = [];
      for (const s of watchData.sources) {
        if (!s.url) continue;
        if (s.url.includes('apivtwo')) continue;
        if (s.url.includes('allanime.day')) continue;
        embeds.push({ name: s.name || 'unknown', type: s.audio || 'sub', url: s.url });
      }
      if (embeds.length) watchData.embeds = embeds;
    }
  }

  // ---------- fetch provider payload ----------
  async function fetchProvider(provider, anilistId, audio, ep) {
    log(`Fetching episodes from ${provider} (${audio})…`);

    const epRes = await fetch(`${API_BASE}/episodes/${provider}/${anilistId}`, NOSTORE);
    if (!epRes.ok) throw new Error(`episodes HTTP ${epRes.status}`);
    const epRaw = await epRes.text();
    if (epRaw.trim().startsWith('<')) throw new Error('episodes returned HTML');
    const epData = JSON.parse(epRaw);
    const providerData = epData[provider];
    if (!providerData || providerData.error) throw new Error(providerData?.error || `${provider}: no data`);

    const subList = providerData.episodes?.sub || [];
    const dubList = providerData.episodes?.dub || [];
    if (subList.length && !S.availability.sub) S.availability.sub = true;
    if (dubList.length && !S.availability.dub) S.availability.dub = true;
    emit('audio', { sub: S.availability.sub, dub: S.availability.dub });

    const list = providerData.episodes?.[audio] || [];
    if (!list.length) throw new Error(`${provider}: no ${audio} episodes`);

    const localMax = Math.max(0, ...list.map(e => Number(e.number) || 0));
    if (localMax > S.maxEp) S.maxEp = localMax;

    const wantNum = Number(ep);
    let entry = list.find(e => Number(e.number) === wantNum);
    if (!entry) {
      log(`${provider}: ep ${wantNum} not found, using first available`, 'warn');
      entry = list[0];
    }
    const epId = entry.id.split('/').pop();
    log(`${provider}: using ep ${entry.number} (id ${epId})`);

    const watchRes = await fetch(`${API_BASE}/watch/${provider}/${anilistId}/${audio}/${epId}`, NOSTORE);
    if (!watchRes.ok) throw new Error(`watch HTTP ${watchRes.status}`);
    const watchRaw = await watchRes.text();
    if (watchRaw.trim().startsWith('<')) throw new Error('watch returned HTML');
    const watchData = JSON.parse(watchRaw);

    const streams = normalizeStreams(watchData);
    normalizeEmbeds(watchData);
    if (!streams.length) throw new Error(`${provider}: no streams`);

    log(`${provider}: ${list.length} eps, ${streams.length} streams`);
    return { watchData, streams };
  }

  function streamsToBuckets(provider, streams, watchData) {
    const hls = [], mp4 = [];
    streams.forEach((s, i) => {
      if (!s.url) continue;
      const item = { provider, stream: s, watchData, isMp4: isMp4(s), streamIndex: i };
      (item.isMp4 ? mp4 : hls).push(item);
    });
    return { hls, mp4 };
  }

  function drainPending() {
    const total = S.pendingHls.length + S.pendingMp4.length;
    if (!total) return;
    log(`Draining ${total} pending stream(s)`);
    S.workList = S.workList.concat(S.pendingHls, S.pendingMp4);
    S.pendingHls = [];
    S.pendingMp4 = [];
  }

  async function backgroundFetch(providers, gen) {
    S.bgActive = true;
    try {
      for (const p of providers) {
        if (gen !== S.gen || S.aborted) return;
        try {
          const { watchData, streams } = await fetchProvider(p, S.anilistId, S.audio, S.ep);
          if (gen !== S.gen || S.aborted) return;
          const { hls, mp4 } = streamsToBuckets(p, streams, watchData);
          S.pendingHls.push(...hls);
          S.pendingMp4.push(...mp4);
          log(`${p}: +${hls.length} HLS, +${mp4.length} MP4 (pending ${S.pendingHls.length + S.pendingMp4.length})`);
        } catch (err) {
          log(`${p} failed: ${err.message}`, 'warn');
        }
      }
    } finally {
      if (gen === S.gen) {
        S.bgActive = false;
        log(`Background fetch complete (${S.pendingHls.length + S.pendingMp4.length} pending)`);
      }
    }
  }

  function findNextSubsIndex(fromIndex) {
    for (let i = fromIndex; i < S.workList.length; i++) {
      const { subs } = chSubs.fromWatchData(S.workList[i]?.watchData);
      if (subs.length) return i;
    }
    return -1;
  }

  async function waitForSubsOrTimeout(index, gen) {
    if (!S.bgActive) return;
    log(`No subs on ${S.workList[index].provider} — waiting up to ${SUBTITLE_WAIT_MS / 1000}s…`);
    const deadline = Date.now() + SUBTITLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (gen !== S.gen || S.aborted) return;
      if (findNextSubsIndex(index) >= 0) return;
      if (!S.bgActive) return;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  async function tryWorkIndex(index) {
    S.workIndex = index;

    if (index >= S.workList.length) {
      if (S.pendingHls.length || S.pendingMp4.length) {
        drainPending();
      } else if (S.bgActive) {
        log('Waiting for background provider fetch…');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && S.bgActive && (S.pendingHls.length + S.pendingMp4.length) === 0) {
          await new Promise(r => setTimeout(r, 300));
        }
        if (S.pendingHls.length || S.pendingMp4.length) drainPending();
      }
    }

    if (index >= S.workList.length) {
      log(`All ${S.workList.length} attempts exhausted`, 'error');
      emit('exhausted', {});
      return;
    }

    const entry = S.workList[index];
    log(`[${index + 1}/${S.workList.length}] ${entry.provider}/${entry.stream.server} (${entry.isMp4 ? 'mp4' : 'hls'})`);

    const { subs } = chSubs.fromWatchData(entry.watchData);
    if (!subs.length) {
      await waitForSubsOrTimeout(index, S.gen);
      const subsIndex = findNextSubsIndex(index);
      if (subsIndex >= 0 && subsIndex !== index) {
        log(`Escalating ${entry.provider} → ${S.workList[subsIndex].provider} for subtitles`);
        return tryWorkIndex(subsIndex);
      }
      log(`Playing ${entry.provider} without subs`);
    }

    const { referer, userAgent } = chSubs.getStreamRefererUA(entry.stream);
    S.currentEntry = entry;
    S.currentStreamReferer = referer;
    S.currentStreamUa = userAgent;

    emit('stream', {
      entry,
      workIndex: index,
      workTotal: S.workList.length,
      referer,
      userAgent,
      anilistId: S.anilistId,
      ep: S.ep,
      audio: S.audio
    });
  }

  async function start({ anilistId, ep, audio }) {
    if (!anilistId) return;
    const chain = [DEFAULT_PROVIDER, ...PROVIDER_CHAIN.filter(p => p !== DEFAULT_PROVIDER)];
    reset({ chain, anilistId, ep: Number(ep) || 1, audio: audio || 'dub' });
    const myGen = S.gen;
    S.aborted = false;

    log(`Starting: id=${anilistId} ep=${S.ep} audio=${S.audio}`);

    // First provider (foreground)
    let firstOk = false;
    try {
      const { watchData, streams } = await fetchProvider(chain[0], anilistId, S.audio, S.ep);
      const { hls, mp4 } = streamsToBuckets(chain[0], streams, watchData);
      S.workList = [...hls, ...mp4];
      if (S.workList.length) firstOk = true;
    } catch (err) {
      log(`${chain[0]} failed: ${err.message}`, 'warn');
    }

    // Fall through chain if first failed
    let resolvedAtIndex = 0;
    if (!firstOk) {
      for (let i = 1; i < chain.length; i++) {
        if (myGen !== S.gen) return;
        try {
          const { watchData, streams } = await fetchProvider(chain[i], anilistId, S.audio, S.ep);
          const { hls, mp4 } = streamsToBuckets(chain[i], streams, watchData);
          S.workList = [...hls, ...mp4];
          if (S.workList.length) {
            resolvedAtIndex = i;
            firstOk = true;
            log(`Fallback: using ${chain[i]} (${S.workList.length} stream(s))`);
            break;
          }
        } catch (err) {
          log(`${chain[i]} failed: ${err.message}`, 'warn');
        }
      }
    }

    if (!firstOk) {
      log('No streams from any provider', 'error');
      emit('exhausted', {});
      return;
    }

    // Background fetch the rest
    const remaining = chain.slice(resolvedAtIndex + 1);
    if (remaining.length) {
      log(`Background fetch: ${remaining.join(', ')}`);
      backgroundFetch(remaining, myGen);
    }

    await tryWorkIndex(0);
  }

  function forceFailover() {
    if (!S.workList.length) return;
    tryWorkIndex(S.workIndex + 1);
  }

  function stop() {
    S.aborted = true;
    S.gen++;
  }

  function getState() {
    return {
      workList: S.workList,
      workIndex: S.workIndex,
      maxEp: S.maxEp,
      availability: { ...S.availability },
      anilistId: S.anilistId,
      ep: S.ep,
      audio: S.audio
    };
  }

  return {
    on, emit,
    start, stop, forceFailover,
    getState,
    MAX_UNIQUE_FRAGMENT_ERRORS,
    isMp4
  };
})();
