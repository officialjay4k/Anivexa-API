// ============================================================
// Cloud Hub — progress.js
// localStorage-backed progress store. Key: `${anilistId}:${audio}:${ep}`
// ============================================================

const chProgress = (function () {
  const KEY = CH.STORAGE_PROGRESS;

  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function writeAll(store) {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }

  function key(anilistId, audio, ep) {
    return anilistId + ':' + audio + ':' + ep;
  }

  function get(anilistId, audio, ep) {
    const store = readAll();
    return store[key(anilistId, audio, ep)] || null;
  }

  function set(anilistId, title, image, ep, audio, currentTime, duration) {
    if (!anilistId) return;
    if (!isFinite(currentTime) || currentTime < 5) return;
    if (!isFinite(duration) || duration <= 0) return;
    const store = readAll();
    store[key(anilistId, audio, ep)] = {
      anilistId: String(anilistId),
      title: title || ('AniList ' + anilistId),
      image: image || null,
      ep: Number(ep),
      audio: audio,
      currentTime: Number(currentTime),
      duration: Number(duration),
      updatedAt: Date.now()
    };
    writeAll(store);
  }

  function remove(anilistId, audio, ep) {
    const store = readAll();
    delete store[key(anilistId, audio, ep)];
    writeAll(store);
  }

  function listAll() {
    return Object.values(readAll());
  }

  function listRecentShows(limit) {
    limit = limit || 20;
    const byShow = new Map();
    for (const e of listAll()) {
      const k = String(e.anilistId);
      const existing = byShow.get(k);
      if (!existing || (e.updatedAt || 0) > (existing.updatedAt || 0)) byShow.set(k, e);
    }
    return Array.from(byShow.values())
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .slice(0, limit);
  }

  function watchedForShow(anilistId, audio) {
    const store = readAll();
    const prefix = anilistId + ':' + audio + ':';
    const out = new Set();
    for (const k in store) {
      if (!Object.prototype.hasOwnProperty.call(store, k)) continue;
      if (k.indexOf(prefix) !== 0) continue;
      const v = store[k];
      if (v && v.currentTime > 5) out.add(Number(v.ep));
    }
    return out;
  }

  return {
    get: get,
    set: set,
    remove: remove,
    listAll: listAll,
    listRecentShows: listRecentShows,
    watchedForShow: watchedForShow,
    key: key
  };
})();
