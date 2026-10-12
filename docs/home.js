// ============================================================
// Cloud Hub — home.js
// Hero carousel, continue watching, latest eps, trending sidebar.
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const HERO_ROTATE_MS = 8000;
const HERO_COUNT = 5;

let heroSlides = [];
let heroIndex = 0;
let heroTimer = null;

// ---------- AniList helper ----------
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

const TRENDING_QUERY = `
  query($page: Int) {
    Page(page: $page, perPage: 24) {
      media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        bannerImage
        description(asHtml: false)
        format
        episodes
        seasonYear
        averageScore
        genres
        nextAiringEpisode { episode }
      }
    }
  }
`;

const LATEST_QUERY = `
  query($from: Int, $to: Int) {
    Page(page: 1, perPage: 30) {
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME_DESC) {
        episode
        airingAt
        media {
          id
          title { romaji english }
          coverImage { extraLarge large }
          format
          averageScore
        }
      }
    }
  }
`;

// ---------- Helpers ----------
function titleOf(media) {
  return media?.title?.english || media?.title?.romaji || 'Untitled';
}

function formatFormat(format) {
  if (!format) return '';
  return format.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function cleanDescription(desc) {
  if (!desc) return '';
  return desc
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Hero carousel ----------
function renderHero(mediaList) {
  const slides = (mediaList || []).filter(m => m.bannerImage).slice(0, HERO_COUNT);
  if (!slides.length) return;
  heroSlides = slides;

  const viewport = document.getElementById('heroViewport');
  const dots = document.getElementById('heroDots');
  viewport.innerHTML = '';
  dots.innerHTML = '';

  slides.forEach((m, i) => {
    const slide = document.createElement('div');
    slide.className = 'home-hero__slide' + (i === 0 ? ' is-active' : '');
    slide.style.backgroundImage = `url('${m.bannerImage}')`;

    const desc = cleanDescription(m.description).slice(0, 220);
    const metaBits = [];
    if (m.averageScore) metaBits.push(`<span class="text-cream">★ ${m.averageScore}</span>`);
    if (m.format) metaBits.push(`<span>${formatFormat(m.format)}</span>`);
    if (m.seasonYear) metaBits.push(`<span>${m.seasonYear}</span>`);
    if (m.genres?.length) metaBits.push(`<span>${m.genres.slice(0, 2).join(' · ')}</span>`);

    slide.innerHTML = `
      <div class="home-hero__content">
        <h1 class="home-hero__title">${chEscapeHtml(titleOf(m))}</h1>
        <div class="home-hero__meta">${metaBits.join('')}</div>
        ${desc ? `<p class="home-hero__desc">${chEscapeHtml(desc)}</p>` : ''}
        <div class="home-hero__cta">
          <a href="/preview?id=${m.id}" class="ch-btn ch-btn--primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
            Watch Now
          </a>
          <a href="/preview?id=${m.id}" class="ch-btn ch-btn--ghost">Details</a>
        </div>
      </div>
    `;
    viewport.appendChild(slide);

    const dot = document.createElement('button');
    dot.className = 'home-hero__dot' + (i === 0 ? ' is-active' : '');
    dot.setAttribute('aria-label', `Slide ${i + 1}`);
    dot.addEventListener('click', () => goToSlide(i));
    dots.appendChild(dot);
  });

  heroIndex = 0;
  startHeroRotation();
}

function goToSlide(i) {
  const slides = document.querySelectorAll('.home-hero__slide');
  const dots = document.querySelectorAll('.home-hero__dot');
  if (!slides.length) return;
  slides[heroIndex]?.classList.remove('is-active');
  dots[heroIndex]?.classList.remove('is-active');
  heroIndex = (i + slides.length) % slides.length;
  slides[heroIndex].classList.add('is-active');
  dots[heroIndex].classList.add('is-active');
}

function startHeroRotation() {
  stopHeroRotation();
  if (!heroSlides.length) return;
  heroTimer = setInterval(() => goToSlide(heroIndex + 1), HERO_ROTATE_MS);
}

function stopHeroRotation() {
  if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
}

// ---------- Continue Watching ----------
function renderContinue() {
  const section = document.getElementById('continueSection');
  const row = document.getElementById('continueRow');

  let store = {};
  try { store = JSON.parse(localStorage.getItem(CH.STORAGE_PROGRESS)) || {}; } catch {}

  const items = Object.values(store)
    .filter(x => x && x.anilistId && x.currentTime > 5)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12);

  if (!items.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  row.innerHTML = '';

  for (const item of items) {
    const pct = item.duration > 0
      ? Math.min(100, (item.currentTime / item.duration) * 100)
      : 0;
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/watch?id=${item.anilistId}&ep=${item.ep}&audio=${item.audio || 'dub'}`;
    card.innerHTML = `
      <div class="home-card__thumb">
        <img src="${chEscapeHtml(item.image || '')}" alt="" loading="lazy"
             onerror="this.style.visibility='hidden'">
        <div class="home-card__badge">EP ${item.ep}</div>
        <div class="home-card__progress"><div class="home-card__progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>
      <div class="home-card__title">${chEscapeHtml(item.title || `AniList ${item.anilistId}`)}</div>
      <div class="home-card__meta">${chFormatTime(item.currentTime)} / ${chFormatTime(item.duration)}</div>
    `;
    row.appendChild(card);
  }
}

// ---------- Latest Episodes ----------
function renderLatest(schedules) {
  const grid = document.getElementById('latestGrid');
  grid.innerHTML = '';

  if (!schedules?.length) {
    grid.innerHTML = '<div class="home-empty">No recent episodes.</div>';
    return;
  }

  // Dedupe by media id, keeping the most recent airing.
  const seen = new Set();
  const items = [];
  for (const s of schedules) {
    const id = s.media?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(s);
    if (items.length >= 12) break;
  }

  for (const s of items) {
    const m = s.media;
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/preview?id=${m.id}`;
    card.innerHTML = `
      <div class="home-card__thumb">
        <img src="${chEscapeHtml(m.coverImage?.extraLarge || m.coverImage?.large || '')}"
             alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="home-card__badge">EP ${s.episode}</div>
        ${m.averageScore ? `<div class="home-card__score">★ ${m.averageScore}</div>` : ''}
      </div>
      <div class="home-card__title">${chEscapeHtml(titleOf(m))}</div>
      <div class="home-card__meta">${formatFormat(m.format)} · ${chFormatTimeAgo(s.airingAt)}</div>
    `;
    grid.appendChild(card);
  }
}

// ---------- Top Trending (sidebar) ----------
function renderTrending(mediaList) {
  const wrap = document.getElementById('trendingList');
  wrap.innerHTML = '';

  if (!mediaList?.length) {
    wrap.innerHTML = '<div class="home-empty">No trending data.</div>';
    return;
  }

  mediaList.slice(0, 10).forEach((m, i) => {
    const row = document.createElement('a');
    row.className = 'home-trend-item';
    row.href = `/preview?id=${m.id}`;

    const metaBits = [];
    if (m.averageScore) metaBits.push(`<span class="home-trend-item__score">★ ${m.averageScore}</span>`);
    if (m.format) metaBits.push(`<span>${formatFormat(m.format)}</span>`);
    if (m.nextAiringEpisode?.episode) metaBits.push(`<span>EP ${m.nextAiringEpisode.episode - 1}</span>`);

    row.innerHTML = `
      <div class="home-trend-item__rank">${i + 1}</div>
      <div style="min-width:0;">
        <div class="home-trend-item__title">${chEscapeHtml(titleOf(m))}</div>
        <div class="home-trend-item__meta">${metaBits.join('')}</div>
      </div>
    `;
    wrap.appendChild(row);
  });
}

// ---------- Boot ----------
async function initHome() {
  renderContinue();

  // Trending + hero (same data source)
  try {
    const trending = await anilistQuery(TRENDING_QUERY, { page: 1 });
    const media = trending?.Page?.media || [];
    renderHero(media);
    renderTrending(media);
  } catch (err) {
    console.error('Trending fetch failed:', err);
    const hero = document.getElementById('heroViewport');
    if (hero) hero.innerHTML = '<div class="home-empty" style="margin:var(--s-5)">Could not load trending.</div>';
    const trending = document.getElementById('trendingList');
    if (trending) trending.innerHTML = '<div class="home-empty">Could not load.</div>';
  }

  // Latest episodes
  try {
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 86400;
    const latest = await anilistQuery(LATEST_QUERY, { from: weekAgo, to: now });
    renderLatest(latest?.Page?.airingSchedules || []);
  } catch (err) {
    console.error('Latest fetch failed:', err);
    const grid = document.getElementById('latestGrid');
    if (grid) grid.innerHTML = '<div class="home-empty">Could not load latest episodes.</div>';
  }

  // Pause hero on hover
  const hero = document.getElementById('homeHero');
  if (hero) {
    hero.addEventListener('mouseenter', stopHeroRotation);
    hero.addEventListener('mouseleave', startHeroRotation);
  }
}

document.addEventListener('DOMContentLoaded', initHome);
