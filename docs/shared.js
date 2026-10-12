// ============================================================
// Cloud Hub — shared.js
// Header + footer injection, shared storage keys, tiny helpers.
// Loaded by every page except landing.
// ============================================================

const CH = {
  API_BASE: 'https://anivexa-api-production-46c4.up.railway.app',
  ANILIST_GRAPHQL: 'https://graphql.anilist.co',
  STORAGE_PROGRESS:  '4kun_progress',
  STORAGE_SETTINGS:  '4kun_settings',
  STORAGE_WATCHLIST: '4kun_watchlist',
  STORAGE_USER:      '4kun_user'
};
window.CH = CH;

function chEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function chFormatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}:${s < 10 ? '0' : ''}${s}`;
  const h = Math.floor(m / 60);
  return `${h}:${(m % 60) < 10 ? '0' : ''}${m % 60}:${s < 10 ? '0' : ''}${s}`;
}

function chFormatTimeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function mountHeader() {
  const mount = document.getElementById('ch-header-mount');
  if (!mount) return;

  const path = window.location.pathname;
  const active = (p) => path === p ? ' is-active' : '';

  mount.innerHTML = `
    <header class="ch-header">
      <div class="ch-motif-strip"></div>
      <div class="ch-container ch-header__inner">
        <a href="/home" class="ch-header__logo" aria-label="Cloud Hub home">
          <img src="/logo.png" alt="Cloud Hub">
        </a>
        <form class="ch-header__search" id="chSearchForm" autocomplete="off">
          <div class="ch-search">
            <span class="ch-search__icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </span>
            <input type="text" id="chSearchInput" placeholder="Search anime..." aria-label="Search anime">
          </div>
        </form>
        <nav class="ch-header__nav">
          <a href="/home" class="ch-header__link${active('/home')}">Home</a>
          <a href="/dashboard" class="ch-header__link${active('/dashboard')}">Dashboard</a>
          <a href="/settings" class="ch-header__link${active('/settings')}">Settings</a>
          <a href="/settings" class="ch-header__avatar" aria-label="Profile">
            <img src="/user-placeholder.png" alt="" onerror="this.style.display='none'">
          </a>
        </nav>
      </div>
    </header>
  `;

  const form = document.getElementById('chSearchForm');
  const input = document.getElementById('chSearchInput');
  if (form && input) {
    // Prefill if q= is in URL
    const q = new URLSearchParams(location.search).get('q');
    if (q) input.value = q;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      window.location.href = `/home?q=${encodeURIComponent(v)}`;
    });
  }
}

function mountFooter() {
  const mount = document.getElementById('ch-footer-mount');
  if (!mount) return;
  mount.innerHTML = `
    <footer class="ch-footer">
      <div class="ch-motif-strip"></div>
      <div class="ch-container ch-footer__inner">
        <div class="ch-footer__col" style="flex:2; min-width:220px;">
          <img src="/logo.png" alt="Cloud Hub" style="height:48px; margin-bottom:12px;">
          <p class="text-muted" style="font-size:13px; max-width:280px; margin:0;">
            A quiet, high-performance anime portal. No clutter. No trackers. Just the shows.
          </p>
        </div>
        <div class="ch-footer__col">
          <h4>Browse</h4>
          <a href="/home">Home</a>
          <a href="/home#trending">Trending</a>
          <a href="/home#latest">Latest Episodes</a>
        </div>
        <div class="ch-footer__col">
          <h4>Account</h4>
          <a href="/settings">Settings</a>
          <a href="/dashboard">Dashboard</a>
        </div>
        <div class="ch-footer__col">
          <h4>Info</h4>
          <a href="#">About</a>
          <a href="#">Contact</a>
        </div>
      </div>
      <div class="ch-container ch-footer__bottom">
        <span>© 2026 Cloud Hub</span>
        <span>Not affiliated with any studio or distributor.</span>
      </div>
    </footer>
  `;
}

document.addEventListener('DOMContentLoaded', () => {
  mountHeader();
  mountFooter();
});
