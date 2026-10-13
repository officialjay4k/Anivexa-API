// ============================================================
// Cloud Hub — home.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const HERO_ROTATE_MS = 8000;
const HERO_COUNT = 5;

let heroSlides = [];
let heroIndex = 0;
let heroTimer = null;
let heroTmdbCache = [];

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

const SPOTLIGHT_QUERY = `
  query {
    Page(page: 1, perPage: 12) {
      media(type: ANIME, status: RELEASING, sort: TRENDING_DESC, isAdult: false) {
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
      }
    }
  }
`;

const LATEST_QUERY = `
  query {
    Page(page: 1, perPage: 30) {
      media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        format
        averageScore
        seasonYear
        episodes
        nextAiringEpisode { episode airingAt }
      }
    }
  }
`;

const POPULAR_QUERY = `
  query {
    Page(page: 1, perPage: 18) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        format
        averageScore
        seasonYear
      }
    }
  }
`;

const SCHEDULE_QUERY = `
  query {
    Page(page: 1, perPage: 40) {
      media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        bannerImage
        format
        averageScore
        nextAiringEpisode { episode airingAt timeUntilAiring }
      }
    }
  }
`;

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

const PLAY_ICON_SVG = `
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="6 4 20 12 6 20"></polygon>
  </svg>`;

// ---------- Hero ----------
async function renderHero(mediaList) {
  const slides = (mediaList || []).slice(0, HERO_COUNT);
  if (!slides.length) return;
  heroSlides = slides;

  const slidesWrap = document.getElementById('heroSlides');
  const featuredRow = document.getElementById('heroFeaturedRow');
  const dots = document.getElementById('heroDots');
  slidesWrap.innerHTML = '';
  featuredRow.innerHTML = '';
  dots.innerHTML = '';

  heroTmdbCache = await Promise.all(
    slides.map(m => tmdbLookup(titleOf(m), m.seasonYear).catch(() => null))
  );

  slides.forEach((m, i) => {
    const tmdb = heroTmdbCache[i];
    const bgUrl = tmdb?.backdropUrl || m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large;
    const slide = document.createElement('div');
    slide.className = 'home-hero__slide' + (i === 0 ? ' is-active' : '');
    if (bgUrl) slide.style.backgroundImage = `url('${bgUrl}')`;
    slidesWrap.appendChild(slide);
  });

  slides.forEach((m, i) => {
    const cover = m.coverImage?.extraLarge || m.coverImage?.large || '';
    const card = document.createElement('div');
    card.className = 'home-hero__featured-card' + (i === 0 ? ' is-current' : '');
    card.dataset.index = i;
    card.innerHTML = `<img src="${chEscapeHtml(cover)}" alt="${chEscapeHtml(titleOf(m))}" loading="lazy">`;
    card.addEventListener('click', () => goToSlide(i));
    featuredRow.appendChild(card);
  });

  slides.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'home-hero__dot' + (i === 0 ? ' is-active' : '');
    dot.setAttribute('aria-label', `Slide ${i + 1}`);
    dot.addEventListener('click', () => goToSlide(i));
    dots.appendChild(dot);
  });

  heroIndex = 0;
  renderSpotlight(0);
  startHeroRotation();
}

function renderSpotlight(i) {
  const m = heroSlides[i];
  if (!m) return;
  const tmdb = heroTmdbCache?.[i] || null;
  const spot = document.getElementById('heroSpotlight');

  const desc = cleanDescription(m.description).slice(0, 280);
  const meta = [];
  if (m.averageScore) meta.push(`<span class="text-cream">★ ${m.averageScore}</span>`);
  if (m.format) meta.push(`<span>${formatFormat(m.format)}</span>`);
  if (m.seasonYear) meta.push(`<span>${m.seasonYear}</span>`);
  if (m.genres?.length) meta.push(`<span>${m.genres.slice(0, 3).join(' · ')}</span>`);

  const titleHtml = tmdb?.logoUrl
    ? `<img class="home-hero__title-logo" src="${chEscapeHtml(tmdb.logoUrl)}"
            alt="${chEscapeHtml(titleOf(m))}"
            onerror="this.outerHTML='<h1 class=&quot;home-hero__title&quot;>${chEscapeHtml(titleOf(m))}</h1>'">`
    : `<h1 class="home-hero__title">${chEscapeHtml(titleOf(m))}</h1>`;

  spot.innerHTML = `
    <div class="home-hero__eyebrow">
      <span class="home-hero__eyebrow-rank">#${i + 1}</span>
      <span class="home-hero__eyebrow-label">Spotlight</span>
    </div>
    ${titleHtml}
    <div class="home-hero__meta">${meta.join('<span class="sep">·</span>')}</div>
    ${desc ? `<p class="home-hero__desc">${chEscapeHtml(desc)}</p>` : ''}
    <div class="home-hero__cta">
      <a href="/preview?id=${m.id}" class="ch-btn ch-btn--primary ch-btn--lg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
        Stream Now
      </a>
      <a href="/preview?id=${m.id}" class="ch-btn ch-btn--ghost ch-btn--lg">More Info</a>
    </div>
  `;
}

function goToSlide(i) {
  const slidesEls = document.querySelectorAll('.home-hero__slide');
  const dots = document.querySelectorAll('.home-hero__dot');
  const cards = document.querySelectorAll('.home-hero__featured-card');
  if (!slidesEls.length) return;
  slidesEls[heroIndex]?.classList.remove('is-active');
  dots[heroIndex]?.classList.remove('is-active');
  cards[heroIndex]?.classList.remove('is-current');
  heroIndex = (i + slidesEls.length) % slidesEls.length;
  slidesEls[heroIndex].classList.add('is-active');
  dots[heroIndex]?.classList.add('is-active');
  cards[heroIndex]?.classList.add('is-current');
  renderSpotlight(heroIndex);
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

  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  row.innerHTML = '';

  for (const item of items) {
    const pct = item.duration > 0 ? Math.min(100, (item.currentTime / item.duration) * 100) : 0;
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/watch?id=${item.anilistId}&ep=${item.ep}&audio=${item.audio || 'dub'}`;
    card.innerHTML = `
      <div class="home-card__thumb">
        <img src="${chEscapeHtml(item.image || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="home-card__ribbon">${PLAY_ICON_SVG}<span>Resume</span></div>
        <div class="home-card__badge">EP ${item.ep}</div>
        <div class="home-card__progress"><div class="home-card__progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>
      <div class="home-card__title-wrap">
        <div class="home-card__title-text" style="opacity:1;">${chEscapeHtml(item.title || `AniList ${item.anilistId}`)}</div>
      </div>
      <div class="home-card__meta">${chFormatTime(item.currentTime)} / ${chFormatTime(item.duration)}</div>
    `;
    row.appendChild(card);
  }
  detectTitleOverflow(row);
}

// ---------- Title overflow detection ----------
// Measures text width by temporarily forcing single-line, then restores.
function detectTitleOverflow(root) {
  if (!root) return;
  requestAnimationFrame(() => {
    root.querySelectorAll('.home-card__title-text').forEach(el => {
      el.classList.remove('is-overflowing');
      el.style.removeProperty('--overflow-px');
      el.style.removeProperty('--overflow-duration');

      const saved = {
        ws: el.style.whiteSpace,
        disp: el.style.display,
        lc: el.style.webkitLineClamp,
        bo: el.style.webkitBoxOrient,
        pos: el.style.position,
        w: el.style.width,
        right: el.style.right,
      };
      el.style.whiteSpace = 'nowrap';
      el.style.display = 'block';
      el.style.webkitLineClamp = 'unset';
      el.style.webkitBoxOrient = 'unset';
      el.style.position = 'static';
      el.style.width = '100%';
      el.style.right = 'auto';

      const fullWidth = el.scrollWidth;
      const visibleWidth = el.parentElement?.clientWidth || el.clientWidth;

      el.style.whiteSpace = saved.ws;
      el.style.display = saved.disp;
      el.style.webkitLineClamp = saved.lc;
      el.style.webkitBoxOrient = saved.bo;
      el.style.position = saved.pos;
      el.style.width = saved.w;
      el.style.right = saved.right;

      if (fullWidth > visibleWidth + 4) {
        const overflow = fullWidth - visibleWidth + 12;
        const duration = Math.max(4, overflow / 30);
        el.classList.add('is-overflowing');
        el.style.setProperty('--overflow-px', `-${overflow}px`);
        el.style.setProperty('--overflow-duration', `${duration}s`);
      }
    });
  });
}

// ---------- Grid renderer ----------
async function renderMediaGrid(gridEl, items, opts = {}) {
  gridEl.innerHTML = '';
  if (!items?.length) {
    gridEl.innerHTML = '<div class="home-empty">No data.</div>';
    return;
  }

  const tmdbResults = await Promise.all(
    items.map(m => tmdbLookup(titleOf(m), m.seasonYear).catch(() => null))
  );

  items.forEach((m, i) => {
    const tmdb = tmdbResults[i];
    const cover = m.coverImage?.extraLarge || m.coverImage?.large || '';
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/preview?id=${m.id}`;

    let badge = '';
    if (opts.latestEp && m.nextAiringEpisode?.episode) {
      badge = `<div class="home-card__badge">EP ${m.nextAiringEpisode.episode - 1}</div>`;
    } else if (opts.latestEp && m.episodes) {
      badge = `<div class="home-card__badge">${m.episodes} EPS</div>`;
    }

    const scoreBadge = m.averageScore ? `<div class="home-card__score">★ ${m.averageScore}</div>` : '';

    const titleWrap = tmdb?.logoUrl
      ? `<div class="home-card__title-wrap">
           <img class="home-card__title-logo" src="${chEscapeHtml(tmdb.logoUrl)}" alt="${chEscapeHtml(titleOf(m))}" loading="lazy">
           <div class="home-card__title-text">${chEscapeHtml(titleOf(m))}</div>
         </div>`
      : `<div class="home-card__title-wrap">
           <div class="home-card__title-text" style="opacity:1;">${chEscapeHtml(titleOf(m))}</div>
         </div>`;

    card.innerHTML = `
      <div class="home-card__thumb">
        <img src="${chEscapeHtml(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="home-card__ribbon">${PLAY_ICON_SVG}<span>Watch</span></div>
        ${badge}
        ${scoreBadge}
      </div>
      ${titleWrap}
      <div class="home-card__meta">${formatFormat(m.format)}${m.seasonYear ? ' · ' + m.seasonYear : ''}</div>
    `;
    gridEl.appendChild(card);
  });

  detectTitleOverflow(gridEl);
}

// ---------- Schedule ----------
function renderSchedule(mediaList) {
  const wrap = document.getElementById('scheduleList');
  wrap.innerHTML = '';

  if (!mediaList?.length) {
    wrap.innerHTML = '<div class="home-empty">No upcoming episodes.</div>';
    return;
  }

  const upcoming = mediaList
    .filter(m => m.nextAiringEpisode?.airingAt)
    .map(m => ({
      media: m,
      episode: m.nextAiringEpisode.episode,
      airingAt: m.nextAiringEpisode.airingAt
    }))
    .sort((a, b) => a.airingAt - b.airingAt)
    .slice(0, 8);

  if (!upcoming.length) {
    wrap.innerHTML = '<div class="home-empty">No upcoming episodes.</div>';
    return;
  }

  for (const s of upcoming) {
    const m = s.media;
    const bg = m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || '';
    const card = document.createElement('a');
    card.className = 'schedule-card';
    card.href = `/preview?id=${m.id}`;
    card.innerHTML = `
      <div class="schedule-card__bg" style="background-image:url('${chEscapeHtml(bg)}')"></div>
      <div class="schedule-card__scrim"></div>
      <div class="schedule-card__content">
        <div class="schedule-card__when">
          <span class="schedule-card__when-dot"></span>
          ${chFormatTimeUntil(s.airingAt)} · EP ${s.episode}
        </div>
        <div class="schedule-card__title">${chEscapeHtml(titleOf(m))}</div>
        <div class="schedule-card__meta">${formatFormat(m.format)}${m.averageScore ? ' · ★ ' + m.averageScore : ''}</div>
      </div>
      <div class="schedule-card__play" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
      </div>
    `;
    wrap.appendChild(card);
  }
}

// ---------- Boot ----------
async function initHome() {
  renderContinue();

  try {
    const spot = await anilistQuery(SPOTLIGHT_QUERY);
    const media = spot?.Page?.media || [];
    await renderHero(media);
  } catch (err) { console.error('Spotlight fetch failed:', err); }

  try {
    const latest = await anilistQuery(LATEST_QUERY);
    const items = (latest?.Page?.media || [])
      .filter(m => m.nextAiringEpisode)
      .sort((a, b) => (b.nextAiringEpisode?.airingAt || 0) - (a.nextAiringEpisode?.airingAt || 0))
      .slice(0, 12);
    renderMediaGrid(document.getElementById('latestGrid'), items, { latestEp: true });
  } catch (err) {
    console.error('Latest fetch failed:', err);
    document.getElementById('latestGrid').innerHTML = '<div class="home-empty">Could not load.</div>';
  }

  try {
    const popular = await anilistQuery(POPULAR_QUERY);
    const items = popular?.Page?.media || [];
    renderMediaGrid(document.getElementById('popularGrid'), items.slice(0, 12));
  } catch (err) {
    console.error('Popular fetch failed:', err);
    document.getElementById('popularGrid').innerHTML = '<div class="home-empty">Could not load.</div>';
  }

  try {
    const sched = await anilistQuery(SCHEDULE_QUERY);
    renderSchedule(sched?.Page?.media || []);
  } catch (err) {
    console.error('Schedule fetch failed:', err);
    document.getElementById('scheduleList').innerHTML = '<div class="home-empty">Could not load.</div>';
  }

  const hero = document.getElementById('homeHero');
  const prev = document.getElementById('heroPrev');
  const next = document.getElementById('heroNext');
  if (prev) prev.addEventListener('click', () => goToSlide(heroIndex - 1));
  if (next) next.addEventListener('click', () => goToSlide(heroIndex + 1));
  if (hero) {
    hero.addEventListener('mouseenter', stopHeroRotation);
    hero.addEventListener('mouseleave', startHeroRotation);
  }

  window.addEventListener('resize', () => {
    detectTitleOverflow(document.getElementById('continueRow'));
    detectTitleOverflow(document.getElementById('latestGrid'));
    detectTitleOverflow(document.getElementById('popularGrid'));
  });
}

document.addEventListener('DOMContentLoaded', initHome);
