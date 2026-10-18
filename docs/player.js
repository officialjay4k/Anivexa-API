// ============================================================
// Cloud Hub — player.js
// ============================================================

const chPlayer = (function () {
  const FALLBACK_FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.woff2';
  const MAX_UNIQUE_FRAGMENT_ERRORS = 3;

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
  let settingsRef = null;
  
  let sleepTimerInterval = null;
  let sleepTimerEndTime = 0;

  let currentWorkerBlobUrl = null;
  let currentWasmBlobUrl = null;

  const ICON_REW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" style="width:32px;height:32px;display:block;"><path d="M14 8 L6 16 L14 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 16 H22 A10 10 0 1 1 12 26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/><text x="24" y="27" text-anchor="middle" font-size="15" font-weight="900" font-family="system-ui, sans-serif" fill="currentColor" stroke="none">5</text></svg>`;
  const ICON_FWD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" style="width:32px;height:32px;display:block;"><path d="M26 8 L34 16 L26 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 16 H18 A10 10 0 1 0 28 26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/><text x="16" y="27" text-anchor="middle" font-size="15" font-weight="900" font-family="system-ui, sans-serif" fill="currentColor" stroke="none">5</text></svg>`;
  const ICON_CAMERA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;

  function showScreenshotUI(base64) {
    let ui = document.getElementById('ch-screenshot-ui');
    if (ui) ui.remove();

    ui = document.createElement('div');
    ui.id = 'ch-screenshot-ui';
    ui.innerHTML = `
      <div class="ch-screenshot-card">
        <img src="${base64}" alt="Screenshot">
        <div class="ch-screenshot-actions">
          <a href="${base64}" download="cloudhub-${Date.now()}.png" class="ch-screenshot-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </a>
          <button type="button" class="ch-screenshot-btn" onclick="alert('Saving to CloudHub profile coming soon!');">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save
          </button>
          <button type="button" class="ch-screenshot-btn" disabled title="Coming soon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            Share
          </button>
        </div>
        <button class="ch-screenshot-close" id="ch-screenshot-close">&times;</button>
      </div>
    `;
    document.body.appendChild(ui);
    
    setTimeout(() => { if (ui.parentNode) ui.remove(); }, 10000);
    document.getElementById('ch-screenshot-close').onclick = () => ui.remove();
  }

  function ensurePreviewTooltip() { let el = document.querySelector('.watch-preview-tip'); if (el) return el; el = document.createElement('div'); el.className = 'watch-preview-tip'; el.innerHTML = '<video muted playsinline preload="auto"></video><div class="watch-preview-tip__time">0:00</div>'; document.body.appendChild(el); return el; }
  function destroyPreview() { if (previewHls) { try { previewHls.destroy(); } catch (e) {} previewHls = null; } const el = document.querySelector('.watch-preview-tip'); if (el) { const v = el.querySelector('video'); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} el.style.display = 'none'; } }
  function initPreview(streamUrl, isMp4) { destroyPreview(); const el = ensurePreviewTooltip(); const video = el.querySelector('video'); if (isMp4) { video.src = streamUrl; return; } if (window.Hls && Hls.isSupported()) { const h = new Hls({ enableWorker: true, autoStartLoad: false, capLevelToPlayerSize: true }); previewHls = h; h.loadSource(streamUrl); h.attachMedia(video); h.startLoad(-1); } }
  function onProgressMove(e) { const progressEl = art && art.template && art.template.$progress; if (!progressEl || !art.duration || !isFinite(art.duration)) return; const rect = progressEl.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)); const t = ratio * art.duration; const tip = ensurePreviewTooltip(); const timeEl = tip.querySelector('.watch-preview-tip__time'); const video = tip.querySelector('video'); timeEl.textContent = chFormatTime(t); const now = Date.now(); if (now - previewLastSeek > 80) { previewLastSeek = now; try { video.currentTime = t; } catch (e) {} } const tipW = 184; let left = rect.left + rect.width * ratio - tipW / 2; left = Math.max(8, Math.min(window.innerWidth - tipW - 8, left)); const top = rect.top - 130; tip.style.left = left + 'px'; tip.style.top = Math.max(8, top) + 'px'; tip.style.display = 'block'; if (previewHideTimer) { clearTimeout(previewHideTimer); previewHideTimer = null; } }
  function onProgressLeave() { if (previewHideTimer) clearTimeout(previewHideTimer); previewHideTimer = setTimeout(function () { const tip = document.querySelector('.watch-preview-tip'); if (tip) tip.style.display = 'none'; }, 140); }
  function attachPreview() { const progressEl = art && art.template && art.template.$progress; if (!progressEl) return; progressEl.addEventListener('mousemove', onProgressMove); progressEl.addEventListener('mouseleave', onProgressLeave); }
  function mountSkipButton() { const playerEl = art && art.template && art.template.$player; if (!playerEl) return; const old = playerEl.querySelector('.watch-skip-btn'); if (old) old.remove(); skipBtn = document.createElement('button'); skipBtn.className = 'watch-skip-btn'; skipBtn.type = 'button'; skipBtn.textContent = 'Skip Intro ➔'; playerEl.appendChild(skipBtn); }
  function updateSkipButton() { if (!art || !art.video) return; const t = art.video.currentTime; const inOp = skipIntervals.op && t >= skipIntervals.op.startTime && t < skipIntervals.op.endTime; const inEd = skipIntervals.ed && t >= skipIntervals.ed.startTime && t < skipIntervals.ed.endTime; if (!inOp && !inEd) { if (skipBtn) skipBtn.style.display = 'none'; skipFired.op = false; skipFired.ed = false; return; } const interval = inOp ? skipIntervals.op : skipIntervals.ed; const label = inOp ? 'Intro' : 'Outro'; const key = inOp ? 'op' : 'ed'; const autoSkip = !!(settingsRef && settingsRef.autoSkip); if (autoSkip) { if (!skipFired[key]) { skipFired[key] = true; art.currentTime = interval.endTime; } if (skipBtn) skipBtn.style.display = 'none'; return; } if (skipBtn) { skipBtn.textContent = 'Skip ' + label + ' ➔'; skipBtn.style.display = 'block'; skipBtn.onclick = function (e) { e.stopPropagation(); art.currentTime = interval.endTime; }; } }
  function mountMarkers() { if (!art || !art.template || !art.template.$progress) return; const inner = art.template.$progress.querySelector('.art-control-progress-inner'); if (!inner) return; inner.querySelectorAll('.watch-marker').forEach(function (el) { el.remove(); }); if (!art.duration || !isFinite(art.duration)) return; function add(interval, label) { if (!interval) return; const start = Math.max(0, interval.startTime); const end = Math.min(art.duration, interval.endTime); if (end <= start) return; const left = (start / art.duration) * 100; const width = ((end - start) / art.duration) * 100; const m = document.createElement('div'); m.className = 'watch-marker'; m.title = label; Object.assign(m.style, { position: 'absolute', left: left + '%', width: width + '%', top: '0', height: '100%', background: 'linear-gradient(90deg, #e50914, #ff2b3a)', opacity: '0.85', borderRadius: '2px', pointerEvents: 'none', zIndex: '25' }); inner.appendChild(m); } add(skipIntervals.op, 'Intro'); add(skipIntervals.ed, 'Outro'); }

  function setSleepTimer(minutes) {
    if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }
    sleepTimerEndTime = 0;
    if (minutes === 'off' || !minutes) return;
    
    if (minutes === 'end') {
      if (art) art.video.setAttribute('data-sleep-end', 'true');
      return;
    }

    if (art) art.video.removeAttribute('data-sleep-end');
    sleepTimerEndTime = Date.now() + (minutes * 60 * 1000);
    
    sleepTimerInterval = setInterval(() => {
      if (Date.now() >= sleepTimerEndTime) {
        if (art && !art.video.paused) {
          art.pause();
          if (typeof showToast === 'function') showToast('Sleep timer ended. Player paused.');
        }
        clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;
        sleepTimerEndTime = 0;
      }
    }, 1000);
  }

  function applySubtitleSize(size) {
    let el = document.getElementById('ch-sub-size-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'ch-sub-size-style';
      document.head.appendChild(el);
    }
    
    const scales = { small: 0.8, medium: 1.0, large: 1.4 };
    const scale = scales[size] || 1.0;
    
    el.innerHTML = `
      video::cue { font-size: ${scale * 100}% !important; }
      .art-libass canvas { 
        transform: scale(${scale}) !important; 
        transform-origin: bottom center !important; 
      }
    `;
  }

  async function fetchAsBlobUrl(proxyUrl, opts) { opts = opts || {}; const res = await fetch(proxyUrl, { cache: 'no-store' }); if (!res.ok) throw new Error('HTTP ' + res.status); const buf = await res.arrayBuffer(); if (opts.expectWasm) { const head = new Uint8Array(buf.slice(0, 8)); const isWasm = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d; if (!isWasm) throw new Error('Not WASM'); } return URL.createObjectURL(new Blob([buf], { type: opts.mimeType || 'application/javascript' })); }
  
  async function prepareLibassAssets(isMp4) {
    if (isMp4) return { wasmBlobUrl: null, workerBlobUrl: null };
    let wasmBlobUrl = null; let workerBlobUrl = null;
    try { wasmBlobUrl = await fetchAsBlobUrl(chSubs.proxyStatic('subtitles-octopus-worker.wasm'), { expectWasm: true, mimeType: 'application/wasm' }); } catch (e) {}
    try { const wr = await fetch(chSubs.proxyStatic('subtitles-octopus-worker.js?v=1'), { cache: 'no-store' }); if (wr.ok) { let wt = await wr.text(); if (wasmBlobUrl) { wt = wt.replace(/"subtitles-octopus-worker\.wasm"/g, '"' + wasmBlobUrl + '"').replace(/'subtitles-octopus-worker\.wasm'/g, "'" + wasmBlobUrl + "'").replace(/subtitles-octopus-worker\.wasm/g, wasmBlobUrl); } workerBlobUrl = URL.createObjectURL(new Blob([wt], { type: 'application/javascript' })); } } catch (e) {}
    return { wasmBlobUrl, workerBlobUrl };
  }

  async function mount(opts) {
    unmount();
    settingsRef = opts.settings || {};
    currentAudioPref = (opts.settings && opts.settings.audio) || 'dub';
    const isMp4 = !!opts.isMp4;
    const callbacks = opts.callbacks || {};
    
    const { wasmBlobUrl, workerBlobUrl } = await prepareLibassAssets(isMp4);
    currentWasmBlobUrl = wasmBlobUrl;
    currentWorkerBlobUrl = workerBlobUrl;

    const libassOpts = { fallbackFont: FALLBACK_FONT_URL, workerUrl: workerBlobUrl, wasmUrl: wasmBlobUrl, legacyWorkerUrl: workerBlobUrl };
    if (opts.fonts && Object.keys(opts.fonts).length) { libassOpts.availableFonts = opts.fonts; }

    const subInfo = chSubs.fromWatchData(opts.watchData);
    const subMenu = chSubs.buildMenu(subInfo.subs, subInfo.referer, subInfo.userAgent, { subtitlesOn: !!opts.subtitlesOn });

    const artConfig = {
      container: opts.container,
      url: opts.streamUrl,
      type: isMp4 ? 'mp4' : 'm3u8',
      autoplay: !!(opts.settings && opts.settings.autoPlay),
      muted: false,
      volume: 1,
      setting: true,
      settings: [],
      playbackRate: true,
      aspectRatio: true,
      // REMOVED: screenshot: true, 
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      hotkey: true,
      theme: '#e50914',
      lang: 'en',
      contextmenu: [],
      moreVideoAttr: { crossOrigin: 'anonymous' },
      controls: [
        { name: 'rewind', position: 'left', index: 11, html: ICON_REW, tooltip: 'Rewind 5s', click: function () { if (!art || !art.video) return; art.video.currentTime = Math.max(0, art.video.currentTime - 5); } },
        { name: 'forward', position: 'left', index: 12, html: ICON_FWD, tooltip: 'Forward 5s', click: function () { if (!art || !art.video) return; const dur = art.duration || art.video.duration || Infinity; art.video.currentTime = Math.min(dur, art.video.currentTime + 5); } },
        { 
          name: 'ch-screenshot', // Changed name to avoid collision
          position: 'right', 
          html: ICON_CAMERA, 
          tooltip: 'Screenshot', 
          click: function () { 
              if(!art) return;
              art.screenshot().then(base64 => {
                showScreenshotUI(base64);
              }).catch(err => {
                console.warn('Screenshot blocked:', err);
                if (typeof showToast === 'function') showToast('Screenshot failed. Stream security blocked the capture.');
              });
          }
        },
        { name: 'subtitle', position: 'right', html: 'CC', selector: subMenu, onSelect: function (item) { if (typeof opts.onSelectSubtitle === 'function') opts.onSelectSubtitle(item); chSubs.applyToPlayer(art, item); return 'CC'; } }
      ]
    };

    if (!isMp4) {
      artConfig.customType = {
        m3u8: function (video, url, artInstance) {
          if (!window.Hls || !Hls.isSupported()) {
            if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
            return;
          }
          if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
          const myHls = new Hls({ enableWorker: true, fragLoadingMaxRetry: 4, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 3 });
          hls = myHls;
          artInstance.hls = myHls;
          myHls.loadSource(url);
          myHls.attachMedia(video);

          myHls.on(Hls.Events.MANIFEST_PARSED, function (e, data) {
            const levels = myHls.levels || [];
            let qualityList = [{ html: 'Auto', value: -1 }];
            if (levels.length > 0) {
              const q = levels.map((l, i) => ({ html: l.height ? `${l.height}p` : `${l.bitrate / 1000}kbps`, value: i })).reverse();
              qualityList = qualityList.concat(q);
            }

            artInstance.setting.update({
              name: 'quality',
              html: 'Quality',
              icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
              selector: qualityList,
              onSelect: function(item) {
                myHls.currentLevel = item.value;
                return item.html;
              }
            });

            if (settingsRef.quality && settingsRef.quality !== 'auto') {
               const found = qualityList.find(q => q.html === settingsRef.quality);
               if (found) {
                 myHls.currentLevel = found.value;
                 artInstance.setting.update({ name: 'quality', selector: qualityList, onSelect: function(item) { myHls.currentLevel = item.value; return item.html; } });
               }
            }

            const applyAudioPreference = function () {
              const tracks = myHls.audioTracks || [];
              if (tracks.length < 2) return;
              const sig = currentAudioPref + ':' + tracks.length + ':' + tracks.map(function (t) { return t.lang; }).join(',');
              if (applyAudioPreference._sig === sig) return;
              applyAudioPreference._sig = sig;
              const wantDub = currentAudioPref === 'dub';
              const dubRe = /\b(dub|english|eng)\b/i;
              const subRe = /\b(japanese|jap|native|sub)\b/i;
              let bestIdx = 0, bestScore = -Infinity;
              for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i];
                const label = (t.name || '') + ' ' + (t.lang || '');
                const l = (t.lang || '').toLowerCase();
                let score = 0;
                if (wantDub) {
                  if (dubRe.test(label)) score += 10;
                  if (l === 'en' || l === 'eng' || l.indexOf('en-') === 0) score += 8;
                  if (l === 'ja' || l === 'jpn' || l.indexOf('ja-') === 0) score -= 30;
                  if (subRe.test(label)) score -= 10;
                  if (t.default) score += 1;
                } else {
                  if (subRe.test(label)) score += 10;
                  if (l === 'ja' || l === 'jpn' || l.indexOf('ja-') === 0) score += 8;
                  if (l === 'en' || l === 'eng' || l.indexOf('en-') === 0) score -= 30;
                  if (dubRe.test(label)) score -= 10;
                  if (t.default) score += 1;
                }
                if (score > bestScore) { bestScore = score; bestIdx = i; }
              }
              try { myHls.audioTrack = bestIdx; } catch (e) {}
            };
            myHls.on(Hls.Events.MANIFEST_PARSED, applyAudioPreference);
            myHls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyAudioPreference);
          });

          myHls.on(Hls.Events.ERROR, function (e, data) {
            if (myHls !== hls) return;
            if (data.fatal) {
              const errStr = data.type + '/' + data.details;
              try { myHls.destroy(); } catch (ex) {}
              if (hls === myHls) hls = null;
              if (typeof callbacks.onHlsFatal === 'function') callbacks.onHlsFatal(errStr);
              return;
            }
            if (data.frag && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              const u = data.frag.url || '';
              if (u && !failedFragments.has(u)) {
                failedFragments.add(u);
                if (failedFragments.size >= MAX_UNIQUE_FRAGMENT_ERRORS) {
                  try { myHls.destroy(); } catch (ex) {}
                  if (hls === myHls) hls = null;
                  if (typeof callbacks.onHlsFatal === 'function') callbacks.onHlsFatal(failedFragments.size + ' unique fragment failures');
                }
              }
            }
          });
        }
      };
    }

    if (opts.subtitlesOn && subInfo.subs.length) {
      const chosen = subInfo.subs.find(function (s) { return s.default; }) || subInfo.subs[0];
      if (chosen) {
        artConfig.subtitle = { url: chSubs.proxy(chSubs.url(chosen), subInfo.referer, subInfo.userAgent), type: chSubs.detect(chosen), name: chSubs.lang(chosen) || 'English', escape: false };
      }
    }

    artConfig.plugins = [artplayerPluginLibass(libassOpts)];

    artConfig.settings = [
      { name: 'sub-size', html: 'Subtitle Size', selector: [
        { html: 'Small', value: 'small' },
        { html: 'Medium', value: 'medium' },
        { html: 'Large', value: 'large' }
      ], onSelect: function(item) { applySubtitleSize(item.value); return item.html; } },
      { name: 'loop', html: 'Loop Episode', switch: !!settingsRef.loop, onSwitch: function(item) { if(art) art.video.loop = !item.switch; return !item.switch; } },
      { name: 'auto-next', html: 'Auto Next Episode', switch: !!settingsRef.autoNext, onSwitch: function(item) { if(typeof callbacks.onToggleAutoNext === 'function') callbacks.onToggleAutoNext(); return !item.switch; } },
      { name: 'sleep', html: 'Sleep Timer', selector: [
        { html: 'Off', value: 'off' }, { html: '10m', value: 10 }, { html: '15m', value: 15 }, { html: '20m', value: 20 }, { html: '25m', value: 25 }, { html: 'End of Video', value: 'end' }
      ], onSelect: function(item) { setSleepTimer(item.value); return item.html; } }
    ];

    return await new Promise(function (resolve) {
      art = new Artplayer(artConfig);
      if (art.template && art.template.$player) {
        art.template.$player.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); return false; });
      }
      art.on('ready', function () {
        mountSkipButton();
        attachPreview();
        initPreview(opts.streamUrl, isMp4);
        if (typeof callbacks.onReady === 'function') callbacks.onReady(art);
        setTimeout(function () { resolve({ art: art, destroy: unmount }); }, 200);
      });
      art.on('video:loadedmetadata', function () {
        mountMarkers();
        if (opts.resumeAt && opts.resumeAt > 1) { try { art.currentTime = opts.resumeAt; } catch (e) {} }
      });
      art.on('video:timeupdate', function () {
        updateSkipButton();
        if (typeof callbacks.onTimeUpdate === 'function' && art && art.video) callbacks.onTimeUpdate(art.video.currentTime, art.video.duration);
      });
      art.on('video:error', function () { if (typeof callbacks.onError === 'function') callbacks.onError('video element error'); });
      art.on('video:playing', function () { failedFragments = new Set(); if (typeof callbacks.onPlaying === 'function') callbacks.onPlaying(art); });
      art.on('video:ended', function () {
        if (art.video.getAttribute('data-sleep-end') === 'true') {
          art.video.removeAttribute('data-sleep-end');
          if (typeof showToast === 'function') showToast('Sleep timer ended. Player stopped.');
          return;
        }
        if (typeof callbacks.onEnded === 'function') callbacks.onEnded();
      });
      art.on('destroy', function () { if (typeof callbacks.onDestroy === 'function') callbacks.onDestroy(); });
    });
  }

  function setSkipIntervals(op, ed) { skipIntervals = { op: op || null, ed: ed || null }; skipFired = { op: false, ed: false }; }
  function setAudioPreference(audio) { currentAudioPref = audio || 'dub'; }
  function setSettings(s) { settingsRef = s || {}; }
  function getArt() { return art; }
  
  function unmount() {
    destroyPreview();
    if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (art) { try { art.destroy(true); } catch (e) {} art = null; }
    if (currentWorkerBlobUrl) { URL.revokeObjectURL(currentWorkerBlobUrl); currentWorkerBlobUrl = null; }
    if (currentWasmBlobUrl) { URL.revokeObjectURL(currentWasmBlobUrl); currentWasmBlobUrl = null; }
    skipBtn = null;
    failedFragments = new Set();
  }

  return { mount, unmount, getArt, setSkipIntervals, setAudioPreference, setSettings };
})();
