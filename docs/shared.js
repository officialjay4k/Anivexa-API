// ============================================================
// Cloud Hub — shared.js
// ============================================================

const CH = {
  API_BASE: 'https://cloudhub.4kun.top',
  ANILIST_GRAPHQL: 'https://graphql.anilist.co',
  STORAGE_PROGRESS:  '4kun_progress',
  STORAGE_SETTINGS:  '4kun_settings',
  STORAGE_WATCHLIST: '4kun_watchlist',
  STORAGE_USER:      '4kun_user',
  DEBUG: false
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
function chFormatTimeUntil(unixSec) {
  const diff = unixSec - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'now';
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  return `in ${Math.floor(diff / 86400)}d`;
}
function chIsSignedIn() {
  try {
    const u = JSON.parse(localStorage.getItem(CH.STORAGE_USER) || 'null');
    return !!(u && u.username);
  } catch { return false; }
}
function chGetUser() {
  try { return JSON.parse(localStorage.getItem(CH.STORAGE_USER) || 'null'); }
  catch { return null; }
}
function chResumeInfo(anilistId) {
  const fallback = { label: 'Watch Now', href: `/watch?id=${anilistId}&ep=1&lang=dub`, isResume: false, isRewatch: false };
  if (!anilistId) return fallback;
  let store = {};
  try { store = JSON.parse(localStorage.getItem(CH.STORAGE_PROGRESS)) || {}; } catch {}
  let latest = null;
  for (const v of Object.values(store)) {
    if (!v || String(v.anilistId) !== String(anilistId)) continue;
    if (!latest || (v.updatedAt || 0) > (latest.updatedAt || 0)) latest = v;
  }
  if (!latest || !latest.currentTime || latest.currentTime < 5) return fallback;
  const href = `/watch?id=${latest.anilistId}&ep=${latest.ep}&lang=${latest.audio || 'dub'}`;
  const finished = latest.duration > 0 && latest.currentTime / latest.duration >= 0.92;
  if (finished) {
    return { label: 'Watch Again', href: `/watch?id=${latest.anilistId}&ep=1&lang=${latest.audio || 'dub'}`, isResume: false, isRewatch: true };
  }
  return { label: 'Resume Watching', href, isResume: true, isRewatch: false };
}

let chPageLoaderEl = null;
let chPageReadyFired = false;
function chPageReady() {
  if (!chPageLoaderEl || chPageReadyFired) return;
  chPageReadyFired = true;
  chPageLoaderEl.classList.add('is-leaving');
  setTimeout(() => { if (chPageLoaderEl?.parentNode) chPageLoaderEl.remove(); }, 450);
}
(function initPageLoader() {
  if (document.getElementById('chPageLoader')) return;
  function create() {
    if (document.getElementById('chPageLoader')) return;
    chPageLoaderEl = document.createElement('div');
    chPageLoaderEl.id = 'chPageLoader';
    chPageLoaderEl.className = 'ch-page-loader';
    chPageLoaderEl.innerHTML = `
      <div class="ch-page-loader__inner">
        <div class="ch-page-loader__mark"></div>
        <div class="ch-page-loader__name">Cloud Hub</div>
        <div class="ch-page-loader__bar"><div class="ch-page-loader__bar-fill"></div></div>
      </div>
    `;
    document.body.appendChild(chPageLoaderEl);
    setTimeout(chPageReady, 5000);
    window.addEventListener('load', () => setTimeout(chPageReady, 500));
  }
  if (document.body) create();
  else document.addEventListener('DOMContentLoaded', create);
})();

function mountHeader() {
  const mount = document.getElementById('ch-header-mount');
  if (!mount) return;
  const path = window.location.pathname;
  const active = (p) => path === p ? ' is-active' : '';
  const signedIn = chIsSignedIn();
  const user = chGetUser();
  let navRight = '';
  if (signedIn) {
    const initial = (user?.username || 'U').charAt(0).toUpperCase();
    navRight = `
      <div class="ch-pfp-wrap" id="chPfpWrap">
        <button type="button" class="ch-header__avatar" id="chPfpBtn" aria-label="Profile menu">
          <img src="/user-placeholder.png" alt="" onerror="this.style.display='none'; this.parentNode.innerHTML='<span style=\\'font-weight:800;color:#fff\\'>${initial}</span>'">
        </button>
        <div class="ch-pfp-menu" id="chPfpMenu">
          <div class="ch-pfp-menu__head">
            <div class="ch-pfp-menu__name">${chEscapeHtml(user?.username || 'User')}</div>
            <div class="ch-pfp-menu__sub">${chEscapeHtml(user?.email || 'Signed in')}</div>
          </div>
          <a href="/settings" class="ch-pfp-menu__item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>
            Settings
          </a>
          <a href="/dashboard" class="ch-pfp-menu__item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            Dashboard
          </a>
          <button type="button" class="ch-pfp-menu__item ch-pfp-menu__item--danger" id="chLogout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Log Out
          </button>
        </div>
      </div>`;
  } else {
    navRight = `<a href="/settings" class="ch-btn ch-btn--primary ch-btn--sm">Sign In</a>`;
  }
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
            <button type="button" class="ch-search__filter" id="chSearchFilter" aria-label="Filters" title="Filters">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="6" x2="20" y2="6"></line>
                <line x1="7" y1="12" x2="17" y2="12"></line>
                <line x1="10" y1="18" x2="14" y2="18"></line>
              </svg>
            </button>
          </div>
        </form>
        <nav class="ch-header__nav">
          <a href="/home" class="ch-header__link${active('/home')}">Home</a>
          <a href="/dashboard" class="ch-header__link${active('/dashboard')}">Dashboard</a>
          ${navRight}
        </nav>
      </div>
    </header>
  `;
  const form = document.getElementById('chSearchForm');
  const input = document.getElementById('chSearchInput');
  if (form && input) {
    const q = new URLSearchParams(location.search).get('q');
    if (q) input.value = q;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      window.location.href = `/home?q=${encodeURIComponent(v)}`;
    });
  }
  const filterBtn = document.getElementById('chSearchFilter');
  if (filterBtn) {
    filterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      filterBtn.classList.toggle('is-active');
      showToast('Filters coming soon');
    });
  }
  const pfpBtn = document.getElementById('chPfpBtn');
  const pfpMenu = document.getElementById('chPfpMenu');
  if (pfpBtn && pfpMenu) {
    pfpBtn.addEventListener('click', (e) => { e.stopPropagation(); pfpMenu.classList.toggle('is-open'); });
    document.addEventListener('click', (e) => {
      if (!pfpMenu.contains(e.target) && e.target !== pfpBtn) pfpMenu.classList.remove('is-open');
    });
  }
  const logout = document.getElementById('chLogout');
  if (logout) logout.addEventListener('click', () => { localStorage.removeItem(CH.STORAGE_USER); window.location.reload(); });
}

function mountFooter() {
  const mount = document.getElementById('ch-footer-mount');
  if (!mount) return;
  mount.innerHTML = `
    <footer class="ch-footer">
      <div class="ch-motif-strip"></div>
      <div class="ch-container ch-footer__inner">
        <div class="ch-footer__brand">
          <img src="/logo.png" alt="Cloud Hub">
          <p>A quiet, high-performance anime portal. No clutter. No trackers. Just the shows.</p>
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
        <div class="ch-footer__madeby">
          <span class="ch-footer__madeby-label">Made by</span>
          <a class="ch-madeby-brand" href="https://4kun.top" target="_blank" rel="noopener noreferrer" aria-label="Visit 4Kun">
            <span class="g">4</span><span class="b">Kun</span>
          </a>
        </div>
        <div class="ch-footer__legal">© 2026 Cloud Hub · Not affiliated with any studio or distributor.</div>
      </div>
    </footer>
  `;
}

function mountInlineReport(mountSelector, context) {
  const mount = document.querySelector(mountSelector);
  if (!mount) return;
  if (mount.dataset.hasReport) return;
  mount.dataset.hasReport = '1';
  mount.innerHTML = `
    <div class="report-strip">
      <div class="report-strip__text">
        <strong>Something broken?</strong>
        <span>Help us fix it — report issues with any page or player.</span>
      </div>
      <button type="button" class="report-strip__btn" id="chInlineReportBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="8" x2="12" y2="13"/>
          <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        ! Report
      </button>
    </div>
  `;
  const btn = document.getElementById('chInlineReportBtn');
  if (btn) btn.addEventListener('click', () => openReportModal(context));
}

function openReportModal(context) {
  let modal = document.getElementById('chReportModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'chReportModal';
    modal.className = 'ch-report-modal';
    modal.innerHTML = `
      <div class="ch-report-modal__inner">
        <h3 class="ch-report-modal__title">Report an Issue</h3>
        <p class="ch-report-modal__sub" id="chReportSub">Tell us what's wrong. We read every report.</p>
        <textarea class="ch-report-modal__textarea" id="chReportText" placeholder="Describe the issue..."></textarea>
        <div class="ch-report-modal__actions">
          <button type="button" class="ch-btn ch-btn--quiet ch-btn--sm" id="chReportCancel">Cancel</button>
          <button type="button" class="ch-btn ch-btn--primary ch-btn--sm" id="chReportSubmit">Submit</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('is-open'); });
    document.getElementById('chReportCancel').addEventListener('click', () => modal.classList.remove('is-open'));
    document.getElementById('chReportSubmit').addEventListener('click', () => {
      const text = document.getElementById('chReportText').value.trim();
      if (!text) { showToast('Please describe the issue'); return; }
      modal.classList.remove('is-open');
      document.getElementById('chReportText').value = '';
      showToast('Thanks — report received');
    });
  }
  document.getElementById('chReportSub').textContent = context
    ? `Context: ${context}`
    : "Tell us what's wrong. We read every report.";
  modal.classList.add('is-open');
}

function showToast(message, ms = 2200) {
  const existing = document.querySelector('.ch-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'ch-toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

window.showToast = showToast;
window.chResumeInfo = chResumeInfo;
window.mountInlineReport = mountInlineReport;
window.openReportModal = openReportModal;
window.chPageReady = chPageReady;

document.addEventListener('DOMContentLoaded', () => {
  mountHeader();
  mountFooter();
});
