// ============================================================
// Cloud Hub — settings.js
// ============================================================

const $ = (id) => document.getElementById(id);

let currentUsername = '';

function setAccountInfo(profile, user) {
  const avatarEl = $('accountAvatar');
  const usernameEl = $('accountUsername');
  const userIdEl = $('accountUserId');
  const emailEl = $('accountEmail');

  const username = profile?.username || '—';
  currentUsername = profile?.username || '';
  const userId = profile?.user_id ? chAuth.formatUserId(profile.user_id) : '—';

  usernameEl.textContent = username;
  userIdEl.textContent = userId;
  emailEl.textContent = user?.email || '—';

  if (profile?.avatar_url) {
    avatarEl.style.backgroundImage = 'url(' + profile.avatar_url + ')';
    avatarEl.textContent = '';
  } else {
    const initial = (username[0] || '?').toUpperCase();
    avatarEl.textContent = initial;
  }

  // Also reflect in the modal
  $('modalUsernameEcho').textContent = username;
  $('modalUsernamePrompt').textContent = username;
}

// ---------- Modal wiring ----------
const modal = $('deleteModal');
const openBtn = $('openDeleteModal');
const cancelBtn = $('cancelDelete');
const confirmBtn = $('confirmDelete');
const inputEl = $('confirmUsername');
const errorEl = $('modalError');

function openModal() {
  errorEl.hidden = true;
  errorEl.textContent = '';
  inputEl.value = '';
  inputEl.classList.remove('is-match');
  confirmBtn.disabled = true;
  modal.classList.add('is-open');
  setTimeout(() => inputEl.focus(), 180);
}

function closeModal() {
  modal.classList.remove('is-open');
}

function checkMatch() {
  const v = inputEl.value.trim();
  const matches = v.length > 0 && v.toLowerCase() === currentUsername.toLowerCase();
  inputEl.classList.toggle('is-match', matches);
  confirmBtn.disabled = !matches;
}

openBtn.addEventListener('click', openModal);
cancelBtn.addEventListener('click', closeModal);
inputEl.addEventListener('input', checkMatch);

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
});

confirmBtn.addEventListener('click', async () => {
  if (confirmBtn.disabled) return;

  // Final native confirmation — last line of defense
  const ok = confirm(
    'FINAL WARNING\n\n' +
    'You are about to permanently delete the account "' + currentUsername + '".\n\n' +
    'All of your data will be erased. This CANNOT be undone.\n\n' +
    'Click OK to permanently delete, Cancel to back out.'
  );
  if (!ok) return;

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Deleting…';
  errorEl.hidden = true;

  try {
    const { error } = await chAuth.client.rpc('delete_own_account');
    if (error) {
      // Surface the error but keep the modal open
      errorEl.textContent = 'Delete failed: ' + error.message;
      errorEl.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Permanently delete';
      return;
    }
  } catch (e) {
    errorEl.textContent = 'Delete failed: ' + (e.message || String(e));
    errorEl.hidden = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Permanently delete';
    return;
  }

  // Success — clear all local cache and bounce to home
  try {
    localStorage.removeItem('cloudhub-auth');
    localStorage.removeItem(CH.STORAGE_PROGRESS);
    localStorage.removeItem(CH.STORAGE_SETTINGS);
    localStorage.removeItem(CH.STORAGE_WATCHLIST);
    localStorage.removeItem(CH.STORAGE_USER);
  } catch (e) {}
  try {
    await chAuth.client.auth.signOut();
  } catch (e) {}

  // Show a brief goodbye, then leave
  modal.innerHTML =
    '<div class="settings-modal__inner">' +
      '<div class="settings-modal__icon" style="color:#7cbf3f;background:rgba(124,191,63,0.12);border-color:rgba(124,191,63,0.55);box-shadow:0 0 30px rgba(124,191,63,0.35);animation:none;">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</div>' +
      '<h2 class="settings-modal__title">Account deleted</h2>' +
      '<p class="settings-modal__sub">Your account and all associated data have been permanently removed.</p>' +
    '</div>';

  setTimeout(() => { window.location.href = '/home'; }, 1400);
});

// ---------- Boot ----------
(async function init() {
  const session = await chAuth.requireAuth('/user/settings');
  if (!session) return;

  setAccountInfo(session.profile, session.user);

  if (typeof chPageReady === 'function') chPageReady();
})();
