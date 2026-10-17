// ============================================================
// Cloud Hub — preview.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const API_BASE = CH.API_BASE;

function getIdFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) return null;
  const n = parseInt(id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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

const MEDIA_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title { romaji english native }
      synonyms
      description(asHtml: false)
      coverImage { extraLarge large color }
      bannerImage
      format
      status
      episodes
      duration
      season
      seasonYear
      startDate { year month day }
      endDate { year month day }
      averageScore
      meanScore
      popularity
      favourites
      genres
      tags { id name rank isMediaSpoiler }
      studios(isMain: true) { nodes { id name } }
      countryOfOrigin
      source
      trailer { id site thumbnail }
      nextAiringEpisode { episode airingAt }
      staff(perPage: 16, sort: RELEVANCE) {
        edges {
          role
          node { id name { full } image { medium } }
        }
      }
      characters(perPage: 18, sort: [ROLE, RELEVANCE, ID]) {
        edges {
          role
          node { id name { full } image { medium large } }
          voiceActors(language: JAPANESE, sort: RELEVANCE) {
            id name { full } image { medium }
          }
        }
      }
    }
  }
`;

const RECS_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      recommendations(perPage: 12, sort: RATING_DESC) {
        nodes {
          mediaRecommendation {
            id
            title { romaji english }
            coverImage { extraLarge large }
            format
            averageScore
            seasonYear
          }
        }
      }
    }
  }
`;

const TAG_FALLBACK_QUERY = `
  query ($tag: String) {
    Page(page: 1, perPage: 12) {
      media(type: ANIME, tag: $tag, sort: POPULARITY_DESC, isAdult: false) {
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
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function fmtDate(d) {
  if (!d?.year) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!d.month) return `${d.year}`;
  const mon = months[Math.max(0, Math.min(11, d.month - 1))];
  return d.day ? `${mon} ${d.day}, ${d.year}` : `${mon} ${d.year}`;
}
function fmtNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

const PLAY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>`;

// ---------- Watchlist (localStorage fallback + Supabase sync) ----------
function getLocalWatchlist() {
  try { return JSON.parse(localStorage.getItem(CH.STORAGE_WATCHLIST)) || {}; } catch { return {}; }
}
function saveLocalWatchlist(w) {
  try { localStorage.setItem(CH.STORAGE_WATCHLIST, JSON.stringify(w)); } catch {}
}

// ---------- Hero ----------
async function renderHero(media, tmdb) {
  const bg = document.getElementById('previewHeroBg');
  const inner = document.getElementById('previewHeroInner');
  if (!bg || !inner) return;

  const bgUrl = tmdb?.backdropUrl
    || media.bannerImage
    || media.coverImage?.extraLarge
    || media.coverImage?.large;
  if (bgUrl) bg.style.backgroundImage = `url('${bgUrl}')`;

  const titleText = titleOf(media);
  const altTitle = media.title?.native || media.title?.romaji || '';
  const showAlt = altTitle && altTitle !== titleText;

  const chips = [];
  if (media.averageScore) {
    chips.push(`<span class="preview-chip preview-chip--score"><span class="star">★</span> ${media.averageScore}%</span>`);
  }
  if (media.format) chips.push(`<span class="preview-chip">${formatFormat(media.format)}</span>`);
  if (media.seasonYear) {
    chips.push(`<span class="preview-chip">${media.season ? media.season.charAt(0) + media.season.slice(1).toLowerCase() + ' ' : ''}${media.seasonYear}</span>`);
  }
  if (media.status) {
    const statusMap = {
      'RELEASING': 'Airing',
      'FINISHED': 'Finished',
      'NOT_YET_RELEASED': 'Upcoming',
      'CANCELLED': 'Cancelled',
      'HIATUS': 'Hiatus'
    };
    const label = statusMap[media.status] || media.status;
    const cls = media.status === 'RELEASING' ? 'preview-chip--red' : '';
    chips.push(`<span class="preview-chip ${cls}">${label}</span>`);
  }
  if (media.episodes) chips.push(`<span class="preview-chip">${media.episodes} Ep</span>`);

  const titleHtml = tmdb?.logoUrl
    ? `<img class="preview-hero__logo" src="${chEscapeHtml(tmdb.logoUrl)}" alt="${chEscapeHtml(titleText)}"
            onerror="this.outerHTML='<h1 class=&quot;preview-hero__title&quot;>${chEscapeHtml(titleText)}</h1>'">`
    : `<h1 class="preview-hero__title">${chEscapeHtml(titleText)}</h1>`;

  inner.innerHTML = `
    ${titleHtml}
    ${showAlt ? `<div class="preview-hero__alt">${chEscapeHtml(altTitle)}</div>` : ''}
    <div class="preview-hero__chips">${chips.join('')}</div>
  `;
}

// ---------- Meta row + CTAs & Watchlist ----------
function renderMetaAndCta(media) {
  const meta = document.getElementById('previewMeta');
  const cta = document.getElementById('previewCta');

  const bits = [];
  if (media.averageScore) bits.push(`<span class="text-cream">★ ${media.averageScore}%</span>`);
  if (media.format) bits.push(`<span>${formatFormat(media.format)}</span>`);
  if (media.episodes) bits.push(`<span>${media.episodes} episodes</span>`);
  if (media.duration) bits.push(`<span>${media.duration} min</span>`);
  if (media.seasonYear) bits.push(`<span>${media.seasonYear}</span>`);
  meta.innerHTML = bits.join('<span class="sep">·</span>');

  const firstEp = 1;
  const watchHref = `/watch?id=${media.id}&ep=${firstEp}&audio=dub`;

  const localWl = getLocalWatchlist()[String(media.id)] || { status: 'none', score: 0 };
  let currentStatus = localWl.status;
  let currentScore = localWl.score;

  cta.innerHTML = `
    <a href="${watchHref}" class="ch-btn ch-btn--primary ch-btn--lg">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>
      Watch Now
    </a>
    
    <div class="ch-dropdown" id="previewWatchlistDropdown" style="margin-left: 8px;">
      <button class="ch-btn ch-btn--cream ch-btn--lg" id="previewWatchlistBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
        </svg>
        <span id="previewWatchlistLabel">${currentStatus === 'none' ? 'Add to List' : 'Status: ' + currentStatus.toUpperCase()}</span>
      </button>
      <div class="ch-dropdown__menu" id="previewWatchlistMenu">
        <button class="ch-dropdown__item" data-status="watching">Watching</button>
        <button class="ch-dropdown__item" data-status="completed">Completed</button>
        <button class="ch-dropdown__item" data-status="plan">Plan to Watch</button>
        <button class="ch-dropdown__item" data-status="dropped">Dropped</button>
        <button class="ch-dropdown__item" data-status="remove">Remove from List</button>
      </div>
    </div>

    <div class="ch-rating" style="margin-left: 8px;">
      <span class="ch-rating__label">Rate:</span>
      <select class="ch-rating__select" id="previewRating">
        <option value="0">—</option>
        ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${currentScore == n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
  `;

  const dd = document.getElementById('previewWatchlistDropdown');
  const btn = document.getElementById('previewWatchlistBtn');
  const menu = document.getElementById('previewWatchlistMenu');
  const label = document.getElementById('previewWatchlistLabel');

  btn.onclick = (e) => { e.stopPropagation(); dd.classList.toggle('is-open'); };
  document.addEventListener('click', (e) => { if (!dd.contains(e.target)) dd.classList.remove('is-open'); });

  menu.querySelectorAll('.ch-dropdown__item').forEach(item => {
    item.onclick = async () => {
      const status = item.dataset.status;
      dd.classList.remove('is-open');
      
      if (status === 'remove') {
        await chAuth.removeWatchlistEntry(media.id);
        const w = getLocalWatchlist();
        delete w[String(media.id)];
        saveLocalWatchlist(w);
        label.textContent = 'Add to List';
        showToast('Removed from list');
        currentStatus = 'none';
      } else {
        await chAuth.upsertWatchlistEntry({
          anilistId: media.id,
          title: titleOf(media),
          image: media.coverImage?.extraLarge,
          status: status,
          score: document.getElementById('previewRating').value || null
        });
        const w = getLocalWatchlist();
        w[String(media.id)] = { status, title: titleOf(media), image: media.coverImage?.extraLarge, score: document.getElementById('previewRating').value };
        saveLocalWatchlist(w);
        label.textContent = 'Status: ' + status.toUpperCase();
        showToast('Updated to ' + status);
        currentStatus = status;
      }
    };
  });

  document.getElementById('previewRating').addEventListener('change', async (e) => {
    const score = Number(e.target.value) || null;
    if (currentStatus === 'none' && score) {
       currentStatus = 'watching';
       label.textContent = 'Status: WATCHING';
    }
    await chAuth.upsertWatchlistEntry({
      anilistId: media.id,
      title: titleOf(media),
      image: media.coverImage?.extraLarge,
      status: currentStatus === 'none' ? 'watching' : currentStatus,
      score: score
    });
    const w = getLocalWatchlist();
    w[String(media.id)] = { status: currentStatus === 'none' ? 'watching' : currentStatus, title: titleOf(media), image: media.coverImage?.extraLarge, score: score };
    saveLocalWatchlist(w);
    showToast('Rating saved');
  });
}

// ---------- Synopsis ----------
function renderDescription(media) {
  const el = document.getElementById('previewDesc');
  const raw = cleanDescription(media.description);
  el.textContent = raw || 'No description available.';
}

// ---------- Facts ----------
function renderFacts(media, languages) {
  const el = document.getElementById('previewFacts');
  const rows = [];

  if (media.format) rows.push(['Format', formatFormat(media.format)]);
  if (media.episodes) rows.push(['Episodes', media.episodes]);
  if (media.duration) rows.push(['Duration', `${media.duration} min`]);
  if (media.status) {
    const map = { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Not yet aired', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
    rows.push(['Status', map[media.status] || media.status]);
  }
  const start = fmtDate(media.startDate);
  const end = fmtDate(media.endDate);
  if (start && end) rows.push(['Aired', `${start} → ${end}`]);
  else if (start) rows.push(['Aired from', start]);
  else if (end) rows.push(['Aired until', end]);

  if (media.season && media.seasonYear) {
    rows.push(['Season', `${media.season.charAt(0)}${media.season.slice(1).toLowerCase()} ${media.seasonYear}`]);
  }
  if (media.source) rows.push(['Source', formatFormat(media.source)]);
  if (media.countryOfOrigin) rows.push(['Country', media.countryOfOrigin]);

  const studios = (media.studios?.nodes || []).map(s => s.name).filter(Boolean);
  if (studios.length) rows.push(['Studio' + (studios.length > 1 ? 's' : ''), studios.join(', ')]);

  if (languages && languages.length) {
    rows.push(['Audio', languages.join(' · ')]);
  }

  if (media.averageScore != null) rows.push(['Average Score', `${media.averageScore}%`]);
  if (media.meanScore != null) rows.push(['Mean Score', `${media.meanScore}%`]);
  if (media.popularity != null) rows.push(['Popularity', `#${fmtNumber(media.popularity)}`]);
  if (media.favourites != null) rows.push(['Favourites', fmtNumber(media.favourites)]);

  el.innerHTML = rows.map(([label, value]) => `
    <div class="preview-fact">
      <div class="preview-fact__label">${chEscapeHtml(label)}</div>
      <div class="preview-fact__value">${chEscapeHtml(String(value))}</div>
    </div>
  `).join('');
}

// ---------- Tags ----------
function renderTags(media) {
  const el = document.getElementById('previewTags');
  const tags = (media.tags || []).slice().sort((a, b) => b.rank - a.rank).slice(0, 14);
  if (!tags.length) {
    el.innerHTML = '<span class="text-muted">No tags available.</span>';
    return;
  }
  el.innerHTML = tags.map(t => {
    const cls = t.rank >= 75 ? 'preview-tag--top' : '';
    const spoiler = t.isMediaSpoiler ? 'preview-tag--spoiler' : '';
    const suffix = t.isMediaSpoiler ? ' (Spoiler)' : '';
    return `<span class="preview-tag ${cls} ${spoiler}">${chEscapeHtml(t.name)}${suffix}</span>`;
  }).join('');
}

// ---------- Staff ----------
function renderStaff(media) {
  const section = document.getElementById('staffBlock');
  const wrap = document.getElementById('previewStaff');
  const edges = media.staff?.edges || [];
  if (!edges.length) { section.hidden = true; return; }
  section.hidden = false;

  wrap.innerHTML = edges.map(e => {
    const name = e.node?.name?.full || 'Unknown';
    const img = e.node?.image?.medium || '';
    const role = e.role || '';
    return `
      <div class="staff-card">
        <div class="staff-card__avatar">
          ${img ? `<img src="${chEscapeHtml(img)}" alt="" loading="lazy">` : ''}
        </div>
        <div class="staff-card__body">
          <div class="staff-card__name">${chEscapeHtml(name)}</div>
          <div class="staff-card__role">${chEscapeHtml(role)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ---------- Characters ----------
function renderCharacters(media) {
  const section = document.getElementById('charactersSection');
  const row = document.getElementById('charactersRow');
  const edges = media.characters?.edges || [];
  if (!edges.length) { section.hidden = true; return; }
  section.hidden = false;

  row.innerHTML = edges.map(e => {
    const char = e.node;
    const va = e.voiceActors?.[0];
    const charImg = char?.image?.large || char?.image?.medium || '';
    const vaImg = va?.image?.medium || '';
    const charName = char?.name?.full || 'Unknown';
    const vaName = va?.name?.full || '';
    const role = e.role || '';

    return `
      <div class="character-card" title="${chEscapeHtml(charName)}">
        <div class="character-card__side">
          ${charImg ? `<img src="${chEscapeHtml(charImg)}" alt="${chEscapeHtml(charName)}" loading="lazy">` : ''}
        </div>
        <div class="character-card__side character-card__side--va ${vaImg ? '' : 'character-card__side--empty'}">
          ${vaImg ? `<img src="${chEscapeHtml(vaImg)}" alt="${chEscapeHtml(vaName)}" loading="lazy">` : 'No VA'}
        </div>
        <div class="character-card__info">
          <div class="character-card__name">${chEscapeHtml(charName)}</div>
          <div class="character-card__role">${chEscapeHtml(role)}</div>
          ${vaName ? `<div class="character-card__va">CV: ${chEscapeHtml(vaName)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ---------- Episodes sidebar ----------
function renderEpisodes(episodes, languages) {
  const list = document.getElementById('epList');
  const count = document.getElementById('epCount');

  if (!episodes || !episodes.length) {
    list.innerHTML = '<div class="preview-sidebar__loading">No episodes found.</div>';
    count.textContent = '—';
    return;
  }
  count.textContent = `${episodes.length} ep${episodes.length === 1 ? '' : 's'}`;

  const watchlistStore = (() => {
    try { return JSON.parse(localStorage.getItem(CH.STORAGE_PROGRESS)) || {}; } catch { return {}; }
  })();

  const currentAudio = (typeof appSettingsAudio === 'function') ? appSettingsAudio() : 'dub';

  list.innerHTML = episodes.map(ep => {
    const n = Number(ep.number);
    const key = `${anilistIdGlobal}:${currentAudio}:${n}`;
    const saved = watchlistStore[key];
    const watched = saved && saved.currentTime > 5;
    return `<button class="ep-pill${watched ? ' watched' : ''}" data-ep="${n}" title="Episode ${n}">${n}</button>`;
  }).join('');

  list.querySelectorAll('.ep-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = btn.dataset.ep;
      location.href = `/watch?id=${anilistIdGlobal}&ep=${n}&audio=${currentAudio}`;
    });
  });
}

let anilistIdGlobal = null;

// ---------- Recommendations ----------
async function renderRecommendations(media) {
  const section = document.getElementById('recsSection');
  const grid = document.getElementById('recsGrid');
  const mediaId = media.id;
  const topTag = (media.tags || [])
    .filter(t => !t.isMediaSpoiler)
    .sort((a, b) => b.rank - a.rank)[0]?.name;
  const topGenre = (media.genres || [])[0];

  let items = [];

  try {
    const data = await anilistQuery(RECS_QUERY, { id: mediaId });
    const nodes = data?.Media?.recommendations?.nodes || [];
    items = nodes
      .map(n => n.mediaRecommendation)
      .filter(m => m && m.id !== mediaId);
  } catch {}

  if (items.length < 8 && topTag) {
    try {
      const data = await anilistQuery(TAG_FALLBACK_QUERY, { tag: topTag });
      const extra = (data?.Page?.media || []).filter(m => m.id !== mediaId);
      const seen = new Set(items.map(m => m.id));
      for (const m of extra) {
        if (!seen.has(m.id)) { items.push(m); seen.add(m.id); }
        if (items.length >= 12) break;
      }
    } catch {}
  }

  items = items.slice(0, 12);

  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;

  const tmdbResults = await Promise.all(
    items.map(m => tmdbLookup(titleOf(m), m.seasonYear).catch(() => null))
  );

  grid.innerHTML = '';

  items.forEach((m, i) => {
    const tmdb = tmdbResults[i];
    const cover = m.coverImage?.extraLarge || m.coverImage?.large || '';
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/preview?id=${m.id}`;

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
        <div class="home-card__ribbon">${PLAY_ICON}<span>View</span></div>
        ${scoreBadge}
      </div>
      ${titleWrap}
      <div class="home-card__meta">${formatFormat(m.format)}${m.seasonYear ? ' · ' + m.seasonYear : ''}</div>
    `;
    grid.appendChild(card);
  });

  if (typeof detectTitleOverflow === 'function') {
    detectTitleOverflow(grid);
  }
}

// ---------- Fetch reanime episodes for sidebar + languages ----------
async function fetchProviderEpisodes(anilistId) {
  try {
    const res = await fetch(`${API_BASE}/episodes/reanime/${anilistId}`, { cache: 'no-store' });
    if (!res.ok) return { episodes: [], languages: [] };
    const data = await res.json();
    const block = data.reanime;
    if (!block || block.error) return { episodes: [], languages: [] };

    const sub = block.episodes?.sub || [];
    const dub = block.episodes?.dub || [];

    const languages = [];
    if (sub.length) languages.push('Sub (JP)');
    if (dub.length) languages.push('Dub (EN)');

    const chosen = (sub.length >= dub.length ? sub : dub).slice();
    chosen.sort((a, b) => Number(a.number) - Number(b.number));
    return { episodes: chosen, languages };
  } catch {
    return { episodes: [], languages: [] };
  }
}

// ---------- Boot ----------
async function initPreview() {
  const id = getIdFromUrl();
  if (!id) {
    document.getElementById('previewDesc').textContent = 'No anime specified. Go back to the home page.';
    document.getElementById('epList').innerHTML = '<div class="preview-sidebar__loading">—</div>';
    return;
  }
  anilistIdGlobal = id;

  let media = null;
  try {
    const data = await anilistQuery(MEDIA_QUERY, { id });
    media = data?.Media;
  } catch (err) {
    console.error('Media fetch failed:', err);
  }

  if (!media) {
    document.getElementById('previewDesc').textContent = 'Failed to load this anime.';
    return;
  }

  const tmdbPromise = tmdbLookup(titleOf(media), media.seasonYear).catch(() => null);
  const epsPromise = fetchProviderEpisodes(id);

  renderMetaAndCta(media);
  renderDescription(media);
  renderTags(media);
  renderStaff(media);
  renderCharacters(media);

  const [tmdb, epsResult] = await Promise.all([tmdbPromise, epsPromise]);

  await renderHero(media, tmdb);

  renderEpisodes(epsResult.episodes, epsResult.languages);
  renderFacts(media, epsResult.languages);

  renderRecommendations(media).catch(() => {});

  document.title = `${titleOf(media)} — Cloud Hub`;
}

document.addEventListener('DOMContentLoaded', initPreview);
