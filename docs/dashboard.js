// ============================================================
// Cloud Hub — dashboard.js
// ============================================================

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let watchlistData = [];
let currentTab = 'watching';

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
  
  const pointsEl = $('dashPoints');
  if (pointsEl) pointsEl.textContent = '✨ ' + (profile?.points || 0) + ' Points';
}

function renderCharts(stats) {
  const w = stats?.watching || 0;
  const c = stats?.finished || 0;
  const p = stats?.watch_later || 0;
  const d = stats?.dropped || 0;
  const total = w + c + p + d;

  // 1. Pie Chart
  const pie = $('dashPieChart');
  if (total === 0) {
    pie.style.background = 'var(--ch-bg-3)';
  } else {
    const wp = (w / total) * 100;
    const cp = (c / total) * 100;
    const pp = (p / total) * 100;
    pie.style.background = `conic-gradient(
      var(--ch-red-bright) 0% ${wp}%, 
      var(--ch-green) ${wp}% ${wp+cp}%, 
      var(--ch-blue) ${wp+cp}% ${wp+cp+pp}%, 
      var(--ch-fg-muted) ${wp+cp+pp}% 100%
    )`;
  }

  // 2. Podium Graph (Top 3 stats)
  const podium = $('dashPodium');
  const items = [
    { label: 'Watching', val: w, color: 'var(--ch-red)' },
    { label: 'Completed', val: c, color: 'var(--ch-green)' },
    { label: 'Planned', val: p, color: 'var(--ch-blue)' }
  ].sort((a,b) => b.val - a.val);

  const maxVal = Math.max(1, items[0].val);
  podium.innerHTML = items.map((item, i) => {
    const height = (item.val / maxVal) * 80 + 10;
    return `
      <div class="podium-bar" style="height: ${height}px; background: linear-gradient(180deg, ${item.color}, var(--ch-bg-2));">
        <div class="podium-bar__val">${item.val}</div>
        <div class="podium-bar__label">${item.label}</div>
      </div>
    `;
  }).join('');

  // 3. Completion Ring
  const completionRate = total > 0 ? Math.round((c / total) * 100) : 0;
  const ring = $('dashRingFill');
  const ringText = $('dashRingText');
  const circumference = 2 * Math.PI * 40; // 251.2
  const offset = circumference - (completionRate / 100) * circumference;
  
  ring.style.strokeDashoffset = offset;
  ringText.textContent = `${completionRate}%`;
}

// ---------- Continue Watching ----------
function renderContinueWatching() {
  const section = $('dashContinueSection');
  const row = $('dashContinueRow');
  
  let store = {};
  try { store = JSON.parse(localStorage.getItem(CH.STORAGE_PROGRESS)) || {}; } catch {}
  
  const byShow = new Map();
  for (const entry of Object.values(store)) {
    if (!entry || !entry.anilistId) continue;
    if (!entry.currentTime || entry.currentTime < 5) continue;
    const k = String(entry.anilistId);
    const existing = byShow.get(k);
    if (!existing || (entry.updatedAt || 0) > (existing.updatedAt || 0)) byShow.set(k, entry);
  }
  
  const items = [...byShow.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
  
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  row.innerHTML = '';
  
  for (const item of items) {
    const pct = item.duration > 0 ? Math.min(100, (item.currentTime / item.duration) * 100) : 0;
    const card = document.createElement('a');
    card.className = 'home-card';
    card.href = `/watch?id=${item.anilistId}&ep=${item.ep}&lang=${item.audio || 'dub'}`;
    card.innerHTML = `
      <div class="home-card__thumb">
        <img src="${chEscapeHtml(item.image || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="home-card__badge">EP ${item.ep}</div>
        <div class="home-card__progress"><div class="home-card__progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>
      <div class="home-card__title-wrap">
        <div class="home-card__title-text" style="opacity:1;">${chEscapeHtml(item.title || `AniList ${item.anilistId}`)}</div>
      </div>
      <div class="home-card__meta">${item.audio?.toUpperCase() || 'DUB'} · ${chFormatTime(item.currentTime)} / ${chFormatTime(item.duration)}</div>
    `;
    row.appendChild(card);
  }
}

// ---------- Watchlist ----------
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
    const href = `/watch?id=${item.anilist_id}&ep=1&lang=dub`;

    // Generate status options
    const statuses = ['watching', 'completed', 'plan', 'dropped'];
    const optionsHtml = statuses.map(s => `<option value="${s}" ${item.status === s ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('');

    grid.innerHTML += `
      <div class="dashboard-card">
        <a href="${href}" class="dashboard-card__thumb">
          ${img ? `<img src="${chEscapeHtml(img)}" alt="" loading="lazy">` : ''}
          ${score}
        </a>
        <div class="dashboard-card__title">${chEscapeHtml(title)}</div>
        
        <div class="dashboard-card__actions">
          <a href="${href}" class="dashboard-action-btn dashboard-action-btn--primary">Watch Now</a>
          <select class="dashboard-action-select" data-id="${item.anilist_id}">
            ${optionsHtml}
          </select>
          <button class="dashboard-action-btn dashboard-action-btn--danger" data-remove="${item.anilist_id}">Remove</button>
        </div>
      </div>
    `;
  });

  content.innerHTML = '';
  content.appendChild(grid);

  // Add event listeners for status changes
  grid.querySelectorAll('.dashboard-action-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const newStatus = e.target.value;
      const item = watchlistData.find(w => String(w.anilist_id) === String(id));
      if (!item) return;

      // Update local state
      item.status = newStatus;
      await chAuth.upsertWatchlistEntry({
        anilistId: id,
        title: item.title,
        image: item.image,
        status: newStatus
      });
      if (typeof showToast === 'function') showToast(`Moved to ${newStatus}`);
      
      // Re-render to remove it from the current tab if changed
      renderWatchlist();
    });
  });

  // Add event listeners for remove buttons
  grid.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = e.target.dataset.remove;
      await chAuth.removeWatchlistEntry(id);
      watchlistData = watchlistData.filter(w => String(w.anilist_id) !== String(id));
      if (typeof showToast === 'function') showToast('Removed from list');
      renderWatchlist();
    });
  });
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

  // Fetch Stats (Using the recompute function to ensure fresh data and points)
  const statsData = await chAuth.recomputeStats();
  renderCharts(statsData);

  // Refresh profile to get updated points
  const updatedSession = await chAuth.refresh();
  if (updatedSession.profile) {
    currentProfile = updatedSession.profile;
    renderProfile(currentProfile, currentUser);
  }

  // Fetch Watchlist
  watchlistData = await chAuth.fetchWatchlist(currentUser.id);
  watchlistData = watchlistData.filter(item => ['watching', 'completed', 'plan', 'dropped'].includes(item.status));

  renderContinueWatching();
  initTabs();
  renderWatchlist();

  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', initDashboard);
