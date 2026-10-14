// ============================================================
// Cloud Hub — pipeline.js
// ============================================================

const chPipeline = (function () {
  const API_BASE = CH.API_BASE;
  const NOSTORE = { cache: 'no-store' };
  const MAX_UNIQUE_FRAGMENT_ERRORS = 3;
  const SUBTITLE_WAIT_MS = 5000;
  const DEFAULT_PROVIDER = 'reanime';
  const PROVIDER_CHAIN = [
    'mkissa', 'senshi', 'anikoto', 'animegg',
    'aniwaves', 'anibd', 'reanime', 'anizone', 'kaa'
  ];

  const events = new EventTarget();
  function on(type, handler) { events.addEventListener(type, function (e) { handler(e.detail); }); }
  function emit(type, detail) { events.dispatchEvent(new CustomEvent(type, { detail: detail })); }

  const S = {
    anilistId: '', ep: 1, audio: 'dub', chain: [],
    workList: [], workIndex: 0,
    pendingHls: [], pendingMp4: [],
    bgActive: false, gen: 0, maxEp: 1,
    availability: { sub: false, dub: false },
    currentEntry: null, aborted: false
  };

  function reset(newState) {
    S.gen++;
    S.chain = newState.chain;
    S.anilistId = newState.anilistId;
    S.ep = newState.ep;
    S.audio = newState.audio;
    S.workList = []; S.workIndex = 0;
    S.pendingHls = []; S.pendingMp4 = [];
    S.bgActive = false;
    S.maxEp = newState.ep;
    S.availability = { sub: false, dub: false };
    S.currentEntry = null;
    S.aborted = false;
  }

  function log(msg, level) {
    level = level || 'info';
    emit('status', { message: msg, level: level });
  }

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
        .filter(function (s) { return s.extractedUrl && s.extractedType; })
        .map(function (s) {
          return {
            server: s.name || 'unknown',
            audio: 'sub',
            url: s.extractedUrl,
            type: s.extractedType === 'mp4' ? 'mp4' : 'hls',
            referer: (s.headers && s.headers.Referer) || null,
            userAgent: (s.headers && s.headers['User-Agent']) || null
          };
        });
    }
    return streams;
  }

  function normalizeEmbeds(watchData) {
    if (Array.isArray(watchData.embeds) && watchData.embeds.length) return;
    if (Array.isArray(watchData.sources)) {
      const embeds = [];
      for (const s of watchData.sources) {
        if (!s.url) continue;
        if (s.url.indexOf('apivtwo') !== -1) continue;
        if (s.url.indexOf('allanime.day') !== -1) continue;
        embeds.push({ name: s.name || 'unknown', type: s.audio || 'sub', url: s.url });
      }
      if (embeds.length) watchData.embeds = embeds;
    }
  }

  async function fetchProvider(provider, anilistId, audio, ep) {
    log('Fetching episodes from ' + provider + ' (' + audio + ')…');
    const epRes = await fetch(API_BASE + '/episodes/' + provider + '/' + anilistId, NOSTORE);
    if (!epRes.ok) throw new Error('episodes HTTP ' + epRes.status);
    const epRaw = await epRes.text();
    if (epRaw.trim().charAt(0) === '<') throw new Error('episodes returned HTML');
    const epData = JSON.parse(epRaw);
    const providerData = epData[provider];
    if (!providerData || providerData.error) {
      throw new Error((providerData && providerData.error) || (provider + ': no data'));
    }

    const subList = (providerData.episodes && providerData.episodes.sub) || [];
    const dubList = (providerData.episodes && providerData.episodes.dub) || [];
    if (subList.length && !S.availability.sub) S.availability.sub = true;
    if (dubList.length && !S.availability.dub) S.availability.dub = true;
    emit('audio', { sub: S.availability.sub, dub: S.availability.dub });

    const list = (providerData.episodes && providerData.episodes[audio]) || [];
    if (!list.length) throw new Error(provider + ': no ' + audio + ' episodes');

    const localMax = Math.max.apply(null, [0].concat(list.map(function (e) { return Number(e.number) || 0; })));
    if (localMax > S.maxEp) S.maxEp = localMax;

    const wantNum = Number(ep);
    let entry = list.find(function (e) { return Number(e.number) === wantNum; });
    if (!entry) {
      log(provider + ': ep ' + wantNum + ' not found, using first available', 'warn');
      entry = list[0];
    }
    const epId = entry.id.split('/').pop();

    const watchRes = await fetch(API_BASE + '/watch/' + provider + '/' + anilistId + '/' + audio + '/' + epId, NOSTORE);
    if (!watchRes.ok) throw new Error('watch HTTP ' + watchRes.status);
    const watchRaw = await watchRes.text();
    if (watchRaw.trim().charAt(0) === '<') throw new Error('watch returned HTML');
    const watchData = JSON.parse(watchRaw);

    const streams = normalizeStreams(watchData);
    normalizeEmbeds(watchData);
    if (!streams.length) throw new Error(provider + ': no streams');

    log(provider + ': ' + list.length + ' eps, ' + streams.length + ' streams');
    return { watchData: watchData, streams: streams };
  }

  function streamsToBuckets(provider, streams, watchData) {
    const hls = [], mp4 = [];
    streams.forEach(function (s, i) {
      if (!s.url) return;
      const item = { provider: provider, stream: s, watchData: watchData, isMp4: isMp4(s), streamIndex: i };
      if (item.isMp4) mp4.push(item); else hls.push(item);
    });
    return { hls: hls, mp4: mp4 };
  }

  function drainPending() {
    const total = S.pendingHls.length + S.pendingMp4.length;
    if (!total) return;
    log('Draining ' + total + ' pending stream(s)');
    S.workList = S.workList.concat(S.pendingHls, S.pendingMp4);
    S.pendingHls = []; S.pendingMp4 = [];
  }

  async function backgroundFetch(providers, gen) {
    S.bgActive = true;
    try {
      for (const p of providers) {
        if (gen !== S.gen || S.aborted) return;
        try {
          const result = await fetchProvider(p, S.anilistId, S.audio, S.ep);
          if (gen !== S.gen || S.aborted) return;
          const buckets = streamsToBuckets(p, result.streams, result.watchData);
          S.pendingHls.push.apply(S.pendingHls, buckets.hls);
          S.pendingMp4.push.apply(S.pendingMp4, buckets.mp4);
          log(p + ': +' + buckets.hls.length + ' HLS, +' + buckets.mp4.length + ' MP4 (pending ' + (S.pendingHls.length + S.pendingMp4.length) + ')');
        } catch (err) {
          log(p + ' failed: ' + err.message, 'warn');
        }
      }
    } finally {
      if (gen === S.gen) {
        S.bgActive = false;
        log('Background fetch complete (' + (S.pendingHls.length + S.pendingMp4.length) + ' pending)');
      }
    }
  }

  function findNextSubsIndex(fromIndex) {
    for (let i = fromIndex; i < S.workList.length; i++) {
      const info = chSubs.fromWatchData(S.workList[i] && S.workList[i].watchData);
      if (info.subs.length) return i;
    }
    return -1;
  }

  async function waitForSubsOrTimeout(index, gen) {
    if (!S.bgActive) return;
    log('No subs on ' + S.workList[index].provider + ' — waiting up to ' + (SUBTITLE_WAIT_MS / 1000) + 's…');
    const deadline = Date.now() + SUBTITLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (gen !== S.gen || S.aborted) return;
      if (findNextSubsIndex(index) >= 0) return;
      if (!S.bgActive) return;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }

  async function tryWorkIndex(index, gen) {
    if (gen == null) gen = S.gen;
    if (gen !== S.gen) return;
    S.workIndex = index;

    if (index >= S.workList.length) {
      if (S.pendingHls.length || S.pendingMp4.length) {
        drainPending();
      } else if (S.bgActive) {
        log('Waiting for background provider fetch…');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && S.bgActive && (S.pendingHls.length + S.pendingMp4.length) === 0) {
          if (gen !== S.gen) return;
          await new Promise(function (r) { setTimeout(r, 300); });
        }
        if (S.pendingHls.length || S.pendingMp4.length) drainPending();
      }
    }

    if (gen !== S.gen) return;
    if (index >= S.workList.length) {
      log('All ' + S.workList.length + ' attempts exhausted', 'error');
      emit('exhausted', {});
      return;
    }

    const entry = S.workList[index];
    log('[' + (index + 1) + '/' + S.workList.length + '] ' + entry.provider + '/' + entry.stream.server + ' (' + (entry.isMp4 ? 'mp4' : 'hls') + ')');

    const subInfo = chSubs.fromWatchData(entry.watchData);
    if (!subInfo.subs.length) {
      await waitForSubsOrTimeout(index, gen);
      if (gen !== S.gen) return;
      const subsIndex = findNextSubsIndex(index);
      if (subsIndex >= 0 && subsIndex !== index) {
        log('Escalating ' + entry.provider + ' → ' + S.workList[subsIndex].provider + ' for subtitles');
        return tryWorkIndex(subsIndex, gen);
      }
      log('Playing ' + entry.provider + ' without subs');
    }

    if (gen !== S.gen) return;
    const ru = chSubs.getStreamRefererUA(entry.stream);
    S.currentEntry = entry;

    emit('stream', {
      entry: entry,
      workIndex: index,
      workTotal: S.workList.length,
      referer: ru.referer,
      userAgent: ru.userAgent,
      anilistId: S.anilistId,
      ep: S.ep,
      audio: S.audio
    });
  }

  async function start(opts) {
    const anilistId = opts.anilistId;
    const ep = Number(opts.ep) || 1;
    const audio = opts.audio || 'dub';
    if (!anilistId) return;

    const chain = [DEFAULT_PROVIDER].concat(
      PROVIDER_CHAIN.filter(function (p) { return p !== DEFAULT_PROVIDER; })
    );
    reset({ chain: chain, anilistId: anilistId, ep: ep, audio: audio });
    const myGen = S.gen;

    log('Starting: id=' + anilistId + ' ep=' + S.ep + ' audio=' + S.audio);

    let firstOk = false;
    try {
      const result = await fetchProvider(chain[0], anilistId, S.audio, S.ep);
      if (myGen !== S.gen) return;
      const buckets = streamsToBuckets(chain[0], result.streams, result.watchData);
      S.workList = buckets.hls.concat(buckets.mp4);
      if (S.workList.length) firstOk = true;
    } catch (err) {
      log(chain[0] + ' failed: ' + err.message, 'warn');
    }

    if (myGen !== S.gen) return;
    let resolvedAtIndex = 0;
    if (!firstOk) {
      for (let i = 1; i < chain.length; i++) {
        if (myGen !== S.gen) return;
        try {
          const result = await fetchProvider(chain[i], anilistId, S.audio, S.ep);
          if (myGen !== S.gen) return;
          const buckets = streamsToBuckets(chain[i], result.streams, result.watchData);
          S.workList = buckets.hls.concat(buckets.mp4);
          if (S.workList.length) {
            resolvedAtIndex = i;
            firstOk = true;
            log('Fallback: using ' + chain[i] + ' (' + S.workList.length + ' stream(s))');
            break;
          }
        } catch (err) {
          log(chain[i] + ' failed: ' + err.message, 'warn');
        }
      }
    }

    if (myGen !== S.gen) return;
    if (!firstOk) {
      log('No streams from any provider', 'error');
      emit('exhausted', {});
      return;
    }

    const remaining = chain.slice(resolvedAtIndex + 1);
    if (remaining.length) {
      log('Background fetch: ' + remaining.join(', '));
      backgroundFetch(remaining, myGen);
    }

    await tryWorkIndex(0, myGen);
  }

  function forceFailover() {
    if (!S.workList.length) return;
    const gen = S.gen;
    tryWorkIndex(S.workIndex + 1, gen);
  }

  // NEW: restart the pipeline from scratch (same id, ep, audio)
  function restart() {
    if (!S.anilistId) return;
    start({ anilistId: S.anilistId, ep: S.ep, audio: S.audio });
  }

  function jumpTo(provider, serverName) {
    if (!S.workList.length) return false;
    const idx = S.workList.findIndex(function (e) {
      return e.provider === provider && (e.stream.server || '') === serverName;
    });
    if (idx < 0) return false;
    const gen = S.gen;
    tryWorkIndex(idx, gen);
    return true;
  }

  function stop() { S.aborted = true; S.gen++; }

  function getState() {
    return {
      workList: S.workList,
      workIndex: S.workIndex,
      maxEp: S.maxEp,
      availability: { sub: S.availability.sub, dub: S.availability.dub },
      anilistId: S.anilistId,
      ep: S.ep,
      audio: S.audio,
      currentEntry: S.currentEntry
    };
  }

  return {
    on: on, emit: emit,
    start: start, stop: stop, restart: restart,
    forceFailover: forceFailover, jumpTo: jumpTo,
    getState: getState,
    MAX_UNIQUE_FRAGMENT_ERRORS: MAX_UNIQUE_FRAGMENT_ERRORS,
    isMp4: isMp4
  };
})();
