// ============================================================
// Cloud Hub — home.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const API_BASE = CH.API_BASE;
const HERO_ROTATE_MS = 8000;
const HERO_COUNT = 5;
const AVAIL_CACHE_KEY = 'ch_avail_v1';
const AVAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let heroSlides = [];
let heroIndex = 0;
let heroTimer = null;
let heroTmdbCache = [];
let currentTrendRange = 'day';
let currentScheduleDay = 1;

const availCache = (() => {
  try { return JSON.parse(localStorage.getItem(AVAIL_CACHE_KEY)) || {}; } catch { return {}; }
})();
const availInflight = new Map();
function saveAvailCache() {
  try { localStorage.setItem(AVAIL_CACHE_KEY, JSON.stringify(availCache)); } catch {}
}
function availGet(id) {
  const e = availCache[String(id)];
  if (!e) return null;
  if (Date.now() - (e.ts || 0) > AVAIL_TTL_MS) return null;
  return e;
}
async function fetchAvailability(anilistId) {
  const id = String(anilistId);
  const cached = availGet(id);
  if (cached) return cached;
  if (availInflight.has(id)) return availInflight.get(id);
  const promise = (async () => {
    let result = { eps: 0, sub: 0, dub: 0, ts: Date.now() };
    try {
      const res = await fetch(`${API_BASE}/episodes/reanime/anikoto/${id}?map=false`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res
