// ============================================================
// Cloud Hub — subtitles.js
// Subtitle helpers: URL proxy, format detection, libass loader,
// font extraction from embed page.
// ============================================================

const chSubs = (() => {
  const API_BASE = CH.API_BASE;

  function getStreamRefererUA(stream) {
    if (!stream) return { referer: null, userAgent: null };
    let referer = null;
    if (stream.headers && stream.headers.Referer) referer = stream.headers.Referer;
    else if (typeof stream.referer === 'string' && stream.referer) referer = stream.referer;
    let userAgent = null;
    if (stream.headers && stream.headers['User-Agent']) userAgent = stream.headers['User-Agent'];
    else if (typeof stream.userAgent === 'string' && stream.userAgent) userAgent = stream.userAgent;
    return { referer, userAgent };
  }

  function proxy(url, referer, ua) {
    const m = (url || '').match(/\.([a-z0-9]+)(?:\?|$)/i);
    const ext = (m && ['ass','ssa','srt','vtt'].includes(m[1].toLowerCase()))
      ? m[1].toLowerCase()
      : 'ass';
    let u = `${API_BASE}/proxy/subtitle.${ext}?url=${encodeURIComponent(url)}`;
    if (referer) u += `&referer=${encodeURIComponent(referer)}`;
    if (ua)      u += `&ua=${encodeURIComponent(ua)}`;
    return u;
  }

  function proxyStatic(path) {
    return `${API_BASE}/proxy/reanime-static?path=${encodeURIComponent(path)}`;
  }

  function url(sub) {
    return sub?.url || sub?.file || sub?.src || sub?.source || '';
  }
  function lang(sub) {
    return sub?.language || sub?.label || sub?.name || sub?.title || sub?.srclang || sub?.lang || '';
  }

  function detect(sub) {
    const fmt = (sub.format || '').toLowerCase();
    if (fmt === 'ass' || fmt === 'ssa') return 'ass';
    if (fmt === 'srt') return 'srt';
    if (fmt === 'vtt' || fmt === 'webvtt') return 'vtt';
    const m = (sub.url || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
    if (m && (m[1] === 'ass' || m[1] === 'ssa')) return 'ass';
    if (m && m[1] === 'srt') return 'srt';
    if (m && m[1] === 'vtt') return 'vtt';
    return 'unknown';
  }

  function fromWatchData(watchData) {
    if (!watchData) return { subs: [], referer: null, userAgent: null };
    const s0 = (watchData.streams && watchData.streams[0]) || {};
    const subs = s0.subtitles || watchData.subtitles || [];
    const { referer, userAgent } = getStreamRefererUA(s0);
    return { subs, referer, userAgent };
  }

  function buildMenu(subs, referer, ua, opts = {}) {
    const subtitlesOn = !!opts.subtitlesOn;
    const items = [{ html: 'Off', url: null, default: !subtitlesOn }];
    (subs || []).forEach((sub, i) => {
      const kind = detect(sub);
      const label = lang(sub) || `Track ${i + 1}`;
      items.push({
        html: label,
        url: proxy(url(sub), referer, ua),
        type: kind,
        name: label,
        format: kind,
        default: subtitlesOn && !!sub.default
      });
    });
    return items;
  }

  async function applyToPlayer(art, item) {
    if (!art) return;
    if (!item || !item.url) {
      art.subtitle.show = false;
      if (art.plugins?.artplayerPluginLibass) {
        try { art.plugins.artplayerPluginLibass.hide(); } catch {}
      }
      return;
    }
    if (item.format === 'ass') {
      const libass = art.plugins?.artplayerPluginLibass;
      if (!libass) { console.warn('[Subs] libass plugin missing'); return; }
      try {
        await libass.switch(item.url);
        libass.show();
        art.subtitle.show = true;
      } catch (e) {
        console.warn('[Subs] libass error:', e.message);
      }
      return;
    }
    if (item.format === 'srt' || item.format === 'vtt') {
      try {
        const res = await fetch(item.url, { cache: 'no-store' });
        if (!res.ok) return;
        const text = await res.text();
        if (!text || text.length < 10) return;
        let vtt = text;
        if (item.format === 'srt') {
          vtt = 'WEBVTT\n\n' + text
            .replace(/\r+/g, '')
            .replace(/^\d+\s*$/gm, '')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
            .replace(/\n{3,}/g, '\n\n');
        }
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        if (art.plugins?.artplayerPluginLibass) {
          try { art.plugins.artplayerPluginLibass.hide(); } catch {}
        }
        art.subtitle.switch(blobUrl, { type: 'vtt', encoding: 'utf-8', escape: false, name: item.name });
        art.subtitle.show = true;
      } catch (e) {
        console.warn('[Subs] native error:', e.message);
      }
    }
  }

  async function fetchFonts(watchData) {
    const embedUrl = watchData?.embeds?.[0]?.url;
    if (!embedUrl) return null;
    try {
      const res = await fetch(`${API_BASE}/proxy/raw?url=${encodeURIComponent(embedUrl)}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/available_fonts\s*:\s*\{([^}]{4,40000})\}/);
      if (!m) return null;
      const re = /(?:(?:"([^"]+)")|(?:'([^']+)')|([A-Za-z_$][\w$]*))\s*:\s*"([^"]+)"/g;
      const out = {};
      let count = 0, mm;
      while ((mm = re.exec(m[1])) !== null) {
        const key = mm[1] || mm[2] || mm[3];
        const rawUrl = mm[4];
        const absolute = rawUrl.startsWith('//') ? `https:${rawUrl}`
                        : rawUrl.startsWith('http') ? rawUrl : null;
        if (!absolute) continue;
        out[key] = `${API_BASE}/proxy/raw?url=${encodeURIComponent(absolute)}`;
        count++;
      }
      return count ? out : null;
    } catch { return null; }
  }

  return {
    getStreamRefererUA, proxy, proxyStatic,
    url, lang, detect,
    fromWatchData, buildMenu, applyToPlayer,
    fetchFonts
  };
})();
