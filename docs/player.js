// ============================================================
// Cloud Hub — player.js
// Mounts Artplayer + hls.js for a given stream. Owns:
//   - video element + hls instance
//   - subtitle selector (CC menu)
//   - skip intro/outro button + progress bar markers
//   - preview tooltip on progress bar hover
//   - rewind/forward 5s controls
// Callbacks pass control back to watch.js for orchestration.
// ============================================================

const chPlayer = (() => {
  const FALLBACK_FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.woff2';
  const MAX_UNIQUE_FRAGMENT_ERRORS = chPipeline.MAX_UNIQUE_FRAGMENT_ERRORS;

  let art = null;
  let hls = null;
  let previewHls = null;
  let previewHideTimer = null;
  let previewLastSeek = 0;
  let skipBtn = null;
  let failedFragments = new Set();
  let skipIntervals = { op: null, ed: null };
  let skipFired = { op: false, ed: false };
  let currentAudioPref = 'dub';
  let currentSubtitlesOn = false;
  let settingsRef = null;

  const ICON_REW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;display:block;"><path d="M12 5V1L7 6l5 5V7"/><path d="M20 12a8 8 0 1 1-2.34-5.66"/><text x="12" y="16" text-anchor="middle" font-size="8" fill="currentColor" stroke="none" font-weight="700" font-family="system-ui">5</text></svg>';
  const ICON_FWD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;display:block;"><path d="M12 5V1l5 5-5 5V7"/><path d="M4 12a8 8 0 1 0 2.34-5.66"/><text x="12" y="16" text-anchor="middle" font-size="8" fill="currentColor" stroke="none" font-weight="700" font-family="system-ui">5</text></svg>';

  // ---------- preview tooltip ----------
  function ensurePreviewTooltip() {
    let el = document.querySelector('.watch-preview-tip');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'watch-preview-tip';
    el.innerHTML = `<video muted playsinline preload="auto"></video><div class="watch-preview-tip__time">0:00</div>`;
    document.body.appendChild(el);
    return el;
  }

  function destroyPreview() {
    if (previewHls) { try { previewHls.destroy(); } catch {} previewHls = null; }
    const el = document.querySelector('.watch-preview-tip');
    if (el) {
      const v = el.querySelector('video');
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
      el.style.display = 'none';
    }
  }

  function initPreview(streamUrl, isMp4) {
    destroyPreview();
    const el = ensurePreviewTooltip();
    const video = el.querySelector('video');
    if (isMp4) {
      video.src = streamUrl;
      return;
    }
    if (window.Hls && Hls.isSupported()) {
      const h = new Hls({ enableWorker: true, autoStartLoad: false, capLevelToPlayerSize: true });
      previewHls = h;
      h.loadSource(streamUrl);
      h.attachMedia(video);
      h.startLoad(-1);
    }
  }

  function onProgressMove(e) {
    const progressEl = art?.template?.$progress;
    if (!progressEl || !art?.duration || !isFinite(art.duration)) return;
    const rect = progressEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = ratio * art.duration;

    const tip = ensurePreviewTooltip();
    const timeEl = tip.querySelector('.watch-preview-tip__time');
    const video = tip.querySelector('video');
    timeEl.textContent = chFormatTime(t);

    const now = Date.now();
    if (now - previewLastSeek > 80) {
      previewLastSeek = now;
      try { video.currentTime = t; } catch {}
    }
    const tipW = 184;
    let left = rect.left + rect.width * ratio - tipW / 2;
    left = Math.max(8, Math.min(window.innerWidth - tipW - 8, left));
    const top = rect.top - 130;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    tip.style.display = 'block';
    if (previewHideTimer) { clearTimeout(previewHideTimer); previewHideTimer = null; }
  }
  function onProgressLeave() {
    if (previewHideTimer) clearTimeout(previewHideTimer);
    previewHideTimer = setTimeout(() => {
      const tip = document.querySelector('.watch-preview-tip');
      if (tip) tip.style.display = 'none';
    }, 140);
  }
  function attachPreview() {
    const progressEl = art?.template?.$progress;
    if (!progressEl) return;
    progressEl.addEventListener('mousemove', onProgressMove);
    progressEl.addEventListener('mouseleave', onProgressLeave);
  }

  // ---------- skip button ----------
  function mountSkipButton() {
    const playerEl = art?.template?.$player;
    if (!playerEl) return;
    const old = playerEl.querySelector('.watch-skip-btn');
    if (old) old.remove();
    skipBtn = document.createElement('button');
    skipBtn.className = 'watch-skip-btn';
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip Intro ➔';
    playerEl.appendChild(skipBtn);
  }

  function updateSkipButton() {
    if (!art?.video) return;
    const t = art.video.currentTime;
    const inOp = skipIntervals.op && t >= skipIntervals.op.startTime && t < skipIntervals.op.endTime;
    const inEd = skipIntervals.ed && t >= skipIntervals.ed.startTime && t < skipIntervals.ed.endTime;
    if (!inOp && !inEd) {
      if (skipBtn) skipBtn.style.display = 'none';
      skipFired.op = false; skipFired.ed = false;
      return;
    }
    const interval = inOp ? skipIntervals.op : skipIntervals.ed;
    const label = inOp ? 'Intro' : 'Outro';
    const key = inOp ? 'op' : 'ed';
    const autoSkip = !!settingsRef?.autoSkip;
    if (autoSkip) {
      if (!skipFired[key]) {
        skipFired[key] = true;
        art.currentTime = interval.endTime;
      }
      if (skipBtn) skipBtn.style.display = 'none';
      return;
    }
    if (skipBtn) {
      skipBtn.textContent = `Skip ${label} ➔`;
      skipBtn.style.display = 'block';
      skipBtn.onclick = (e) => {
        e.stopPropagation();
        art.currentTime = interval.endTime;
      };
    }
  }

  // ---------- progress markers ----------
  function mountMarkers() {
    if (!art?.template?.$progress) return;
    const inner = art.template.$progress.querySelector('.art-control-progress-inner');
    if (!inner) return;
    inner.querySelectorAll('.watch-marker').forEach(el => el.remove());
    if (!art.duration || !isFinite(art.duration)) return;

    const add = (interval, label) => {
      if (!interval) return;
      const start = Math.max(0, interval.startTime);
      const end = Math.min(art.duration, interval.endTime);
      if (end <= start) return;
      const left = (start / art.duration) * 100;
      const width = ((end - start) / art.duration) * 100;
      const m = document.createElement('div');
      m.className = 'watch-marker';
      m.title = label;
      Object.assign(m.style, {
        position: 'absolute',
        left: `${left}%`,
        width: `${width}%`,
        top: '0',
        height: '100%',
        background: 'linear-gradient(90deg, #e50914, #ff2b3a)',
        opacity: '0.85',
        borderRadius: '2px',
        pointerEvents: 'none',
        zIndex: '25'
      });
      inner.appendChild(m);
    };
    add(skipIntervals.op, 'Intro');
    add(skipIntervals.ed, 'Outro');
  }

  // ---------- libass worker + wasm ----------
  async function fetchAsBlobUrl(proxyUrl, { expectWasm = false, mimeType = 'application/javascript' } = {}) {
    const res = await fetch(proxyUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (expectWasm) {
      const head = new Uint8Array(buf.slice(0, 8));
      const isWasm = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
      if (!isWasm) throw new Error('Not WASM');
    }
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }

  async function prepareLibassAssets(isMp4) {
    if (isMp4) return { wasmBlobUrl: null, workerBlobUrl: null };
    let wasmBlobUrl = null, workerBlobUrl = null;
    try {
      wasmBlobUrl = await fetchAsBlobUrl(
        chSubs.proxyStatic('subtitles-octopus-worker.wasm'),
        { expectWasm: true, mimeType: 'application/wasm' }
      );
    } catch {}
    try {
      const wr = await fetch(chSubs.proxyStatic('subtitles-octopus-worker.js?v=1'), { cache: 'no-store' });
      if (wr.ok) {
        let wt = await wr.text();
        if (wasmBlobUrl) {
          wt = wt
            .replace(/"subtitles-octopus-worker\.wasm"/g, `"${wasmBlobUrl}"`)
            .replace(/'subtitles-octopus-worker\.wasm'/g, `'${wasmBlobUrl}'`)
            .replace(/subtitles-octopus-worker\.wasm/g, wasmBlobUrl);
        }
        workerBlobUrl = URL.createObjectURL(new Blob([wt], { type: 'application/javascript' }));
      }
    } catch {}
    return { wasmBlobUrl, workerBlobUrl };
  }

  // ---------- main mount ----------
  async function mount({
    container, streamUrl, isMp4, watchData, fonts,
    settings, // { autoSkip, autoPlay, subtitlesOn }
    subtitlesOn, onSelectSubtitle,
    resumeAt,
    callbacks = {}
  }) {
    unmount();
    settingsRef = settings || {};
    currentAudioPref = settings?.audio || 'dub';
    currentSubtitlesOn = !!subtitlesOn;

    const {
      onReady, onPlaying, onTimeUpdate, onEnded, onError, onHlsFatal, onDestroy, onManifest
    } = callbacks;

    // libass assets
    const { wasmBlobUrl, workerBlobUrl } = await prepareLibassAssets(isMp4);

    const libassOpts = {
      fallbackFont: FALLBACK_FONT_URL,
      workerUrl: workerBlobUrl,
      wasmUrl: wasmBlobUrl,
      legacyWorkerUrl: workerBlobUrl
    };
    if (fonts && Object.keys(fonts).length > 0) {
      libassOpts.availableFonts = fonts;
    }

    // subtitle menu
    const subInfo = chSubs.fromWatchData(watchData);
    const subMenu = chSubs.buildMenu(subInfo.subs, subInfo.referer, subInfo.userAgent, {
      subtitlesOn
    });

    const doAutoplay = !!settings?.autoPlay;

    const artConfig = {
      container,
      url: streamUrl,
      type: isMp4 ? 'mp4' : 'm3u8',
      autoplay: doAutoplay,
      muted: false,
      volume: 1,
      setting: false,
      settings: [],
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      hotkey: true,
      theme: '#e50914',
      lang: 'en',
      moreVideoAttr: { crossOrigin: 'anonymous' },
      controls: [
        {
          name: 'rewind',
          position: 'left',
          index: 11,
          html: ICON_REW,
          tooltip: 'Rewind 5s',
          click: () => {
            if (!art?.video) return;
            art.video.currentTime = Math.max(0, art.video.currentTime - 5);
          }
        },
        {
          name: 'forward',
          position: 'left',
          index: 12,
          html: ICON_FWD,
          tooltip: 'Forward 5s',
          click: () => {
            if (!art?.video) return;
            art.video.currentTime = Math.min(
              (art.duration || art.video.duration || Infinity),
              art.video.currentTime + 5
            );
          }
        },
        {
          name: 'subtitle',
          position: 'right',
          html: 'CC',
          selector: subMenu,
          onSelect: function (item) {
            if (typeof onSelectSubtitle === 'function') onSelectSubtitle(item);
            chSubs.applyToPlayer(art, item);
            return 'CC';
          }
        }
      ]
    };

    if (!isMp4) {
      artConfig.customType = {
        m3u8: function (video, url, artInstance) {
          if (!window.Hls || !Hls.isSupported()) {
            if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
            return;
          }
          if (hls) { try { hls.destroy(); } catch {} hls = null; }
          const myHls = new Hls({
            enableWorker: true,
            fragLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 3,
            levelLoadingMaxRetry: 3
          });
          hls = myHls;
          artInstance.hls = myHls;
          myHls.loadSource(url);
          myHls.attachMedia(video);

          const applyAudioPreference = () => {
            const tracks = myHls.audioTracks || [];
            if (tracks.length < 2) return;
            const sig = `${currentAudioPref}:${tracks.length}:${tracks.map(t => t.lang).join(',')}`;
            if (applyAudioPreference._sig === sig) return;
            applyAudioPreference._sig = sig;

            const wantDub = currentAudioPref === 'dub';
            const dubRe = /\b(dub|english|eng)\b/i;
            const subRe = /\b(japanese|jap|native|sub)\b/i;
            let bestIdx = 0, bestScore = -Infinity;
            for (let i = 0; i < tracks.length; i++) {
              const t = tracks[i];
              const label = `${t.name || ''} ${t.lang || ''}`;
              const l = (t.lang || '').toLowerCase();
              let score = 0;
              if (wantDub) {
                if (dubRe.test(label)) score += 10;
                if (l === 'en' || l === 'eng' || l.startsWith('en-')) score += 8;
                if (l === 'ja' || l === 'jpn' || l.startsWith('ja-')) score -= 30;
                if (subRe.test(label)) score -= 10;
                if (t.default) score += 1;
              } else {
                if (subRe.test(label)) score += 10;
                if (l === 'ja' || l === 'jpn' || l.startsWith('ja-')) score += 8;
                if (l === 'en' || l === 'eng' || l.startsWith('en-')) score -= 30;
                if (dubRe.test(label)) score -= 10;
                if (t.default) score += 1;
              }
              if (score > bestScore) { bestScore = score; bestIdx = i; }
            }
            try {
              myHls.audioTrack = bestIdx;
            } catch {}
          };

          myHls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
            if (typeof onManifest === 'function') {
              onManifest({
                levels: data.levels?.length || 0,
                audioTracks: myHls.audioTracks?.length || 0
              });
            }
            applyAudioPreference();
          });
          myHls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyAudioPreference);

          myHls.on(Hls.Events.ERROR, (e, data) => {
            if (myHls !== hls) return;
            if (data.fatal) {
              const errStr = `${data.type}/${data.details}`;
              try { myHls.destroy(); } catch {}
              if (hls === myHls) hls = null;
              if (typeof onHlsFatal === 'function') onHlsFatal(errStr);
              return;
            }
            if (data.frag && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              const u = data.frag.url || '';
              if (u && !failedFragments.has(u)) {
                failedFragments.add(u);
                if (failedFragments.size >= MAX_UNIQUE_FRAGMENT_ERRORS) {
                  try { myHls.destroy(); } catch {}
                  if (hls === myHls) hls = null;
                  if (typeof onHlsFatal === 'function') onHlsFatal(`${failedFragments.size} unique fragment failures`);
                }
              }
            }
          });
        }
      };
    }

    if (subtitlesOn && subInfo.subs.length) {
      const chosen = subInfo.subs.find(s => s.default) || subInfo.subs[0];
      if (chosen) {
        artConfig.subtitle = {
          url: chSubs.proxy(chSubs.url(chosen), subInfo.referer, subInfo.userAgent),
          type: chSubs.detect(chosen),
          name: chSubs.lang(chosen) || 'English',
          escape: false
        };
      }
    }

    artConfig.plugins = [artplayerPluginLibass(libassOpts)];

    return await new Promise((resolve) => {
      art = new Artplayer(artConfig);

      art.on('ready', () => {
        mountSkipButton();
        attachPreview();
        initPreview(streamUrl, isMp4);
        if (typeof onReady === 'function') onReady(art);
        setTimeout(() => resolve({ art, destroy: unmount }), 200);
      });

      art.on('video:loadedmetadata', () => {
        mountMarkers();
        if (resumeAt && resumeAt > 1) {
          try { art.currentTime = resumeAt; } catch {}
        }
      });

      art.on('video:timeupdate', () => {
        updateSkipButton();
        if (typeof onTimeUpdate === 'function' && art?.video) {
          onTimeUpdate(art.video.currentTime, art.video.duration);
        }
      });

      art.on('video:error', () => {
        if (typeof onError === 'function') onError('video element error');
      });

      art.on('video:playing', () => {
        failedFragments = new Set();
        if (typeof onPlaying === 'function') onPlaying(art);
      });

      art.on('video:ended', () => {
        if (typeof onEnded === 'function') onEnded();
      });

      art.on('destroy', () => {
        if (typeof onDestroy === 'function') onDestroy();
      });
    });
  }

  function setSkipIntervals(op, ed) {
    skipIntervals = { op: op || null, ed: ed || null };
    skipFired = { op: false, ed: false };
  }

  function setAudioPreference(audio) {
    currentAudioPref = audio || 'dub';
  }

  function setSettings(s) {
    settingsRef = s || {};
  }

  function unmount() {
    destroyPreview();
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (art) { try { art.destroy(true); } catch {} art = null; }
    skipBtn = null;
    failedFragments = new Set();
  }

  function getArt() { return art; }

  return {
    mount, unmount, getArt,
    setSkipIntervals, setAudioPreference, setSettings
  };
})();
