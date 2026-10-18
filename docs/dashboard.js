// ============================================================
// Cloud Hub — dashboard.js
// ============================================================

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let watchlistData = [];
let currentTab = 'watching';

// ---------- Render Profile ----------
function renderProfile(profile, user) {
  const initial = ((profile?.username || user.email || 'U').charAt(0) || 'U').toUpperCase();
  const avatarEl = $('dashAvatar');
  if (profile?.avatar_url) {
    avatarEl.style.backgroundImage = `url('${profile.avatar_url}')`;
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = initial;
  }

  $('dashUsername').textContent = profile?.username || 'User';
  $('dashDisplayName').textContent = profile?.display_name ? `Welcome back, ${profile.display_name}` : 'Welcome back';
  $('dashPublicProfileLink').href = `/user/${profile?.username || ''}`;
}

// ---------- Render Stats ----------
function renderStats(stats) {
  $('statFinished').textContent = stats?.finished || 0;
  $('statWatching').textContent = stats?.watching || 0;
  $('statPlanned').textContent = stats?.watch_later || 0;
  $('statDropped').textContent = stats?.dropped || 0;
  $('statHours').textContent = stats?.watch_hours || 0;
}

// ---------- Render Watchlist ----------
function renderWatchlist() {
  const content = $('dashContent');
  const filtered = watchlistData.filter(item => item.status === currentTab);

  if (!filtered.length) {
    content.innerHTML = `<div class="dashboard-empty">You don't have any anime in your <strong>${currentTab.toUpperCase()}</strong> list.</div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'dashboard-grid';

  filtered.forEach(item => {
    const img = item.image || '';
    const title = item.title || `AniList ${item.anilist_id}`;
    const score = item.score ? `<div class="dashboard-card__score">★ ${item.score}</div>` : '';
    
    // Link goes to watch page, user can click details from there if they want
    const href = `/watch?id=${item.anilist_id}&ep=1&lang=dub`;

    grid.innerHTML += `
      <a href="${href}" class="dashboard-card">
        <div class="dashboard-card__thumb">
          ${img ? `<img src="${chEscapeHtml(img)}" alt="" loading="lazy">` : ''}
          ${score}
        </div>
        <div class="dashboard-card__title">${chEscapeHtml(title)}</div>
      </a>
    `;
  });

  content.innerHTML = '';
  content.appendChild(grid);
}

// ---------- Tabs Logic ----------
function initTabs() {
  const tabs = $('dashTabs');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.dashboard-tab');
    if (!btn) return;
    
    const tab = btn.dataset.tab;
    if (!tab || tab === currentTab) return;

    currentTab = tab;
    
    tabs.querySelectorAll('.dashboard-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tab === currentTab);
    });

    renderWatchlist();
  });
}

// ---------- Boot ----------
async function initDashboard() {
  const session = await chAuth.requireAuth('/user/dashboard');
  if (!session) return;

  currentUser = session.user;
  currentProfile = session.profile;

  renderProfile(currentProfile, currentUser);

  // Fetch Stats
  const { data: statsData } = await chAuth.client
    .from('stats')
    .select('*')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  
  renderStats(statsData);

  // Fetch Watchlist
  watchlistData = await chAuth.fetchWatchlist(currentUser.id);
  
  // Filter out any weird statuses just in case
  watchlistData = watchlistData.filter(item => ['watching', 'completed', 'plan', 'dropped'].includes(item.status));

  initTabs();
  renderWatchlist();

  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', initDashboard);
