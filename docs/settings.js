// ============================================================
// Cloud Hub — settings.js
// ============================================================

const $ = (id) => document.getElementById(id);
const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

let currentProfile = null;
let currentUser = null;

// ---------- Preset avatar library ----------
const PRESET_AVATARS = [
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Sakura&backgroundColor=b6e3f4',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Kirito&backgroundColor=d1d4f9',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Asuna&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Naruto&backgroundColor=ffd5dc',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Gojo&backgroundColor=c0aede',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Tanjiro&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Nezuko&backgroundColor=ffd5dc',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Levi&backgroundColor=b6e3f4',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Mikasa&backgroundColor=d1d4f9',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Luffy&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Zoro&backgroundColor=c0aede',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Eren&backgroundColor=b6e3f4',
];

// ============================================================
// Render
// ============================================================
function renderAvatar(profile) {
  const el = $('avatarImg');
  const username = profile?.username || '';
  if (profile?.avatar_url) {
    el.style.backgroundImage = 'url(' + profile.avatar_url + ')';
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (username[0] || '?').toUpperCase();
  }
}

function renderAccount(profile, user) {
  $('accountUserId').textContent = profile?.user_id ? '#' + chAuth.formatUserId(profile.user_id) : '—';
  $('accountEmail').textContent = user?.email || '—';
  $('accountEmailStatus').textContent = user?.email_confirmed_at ? 'Verified' : 'Not verified';
  const prov = user?.app_metadata?.provider || 'email';
  $('accountMethod').textContent = prov === 'google' ? 'Google' : 'Email & password';
}

function renderProfileFields(profile) {
  currentProfile = profile;
  renderAvatar(profile);
  $('usernameInput').value = profile?.username || '';
  $('displayNameInput').value = profile?.display_name || '';
  $('bioInput').value = profile?.bio || '';
  $('hideStatsToggle').checked = profile?.hidden || false;
  updateBioCount();
  $('modalUsernameEcho').textContent = profile?.username || 'your account';
  $('modalUsernamePrompt').textContent = profile?.username || 'username';
}

function updateBioCount() {
  $('bioCount').textContent = String(($('bioInput').value || '').length);
}

// ============================================================
// Save / Reset
// ============================================================
$('bioInput').addEventListener('input', updateBioCount);

function showProfileMsg(msg, ok) {
  const el = $('profileError');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('is-ok', !!ok);
}
function clearProfileMsg() {
  const el = $('profileError');
  el.hidden = true;
  el.textContent = '';
  el.classList.remove('is-ok');
}

$('saveProfileBtn').addEventListener('click', async () => {
  clearProfileMsg();

  const username = $('usernameInput').value.trim();
  const displayName = $('displayNameInput').value.trim() || null;
  const bio = $('bioInput').value.trim() || null;
  const hidden = $('hideStatsToggle').checked;

  if (!USERNAME_RE.test(username)) {
    showProfileMsg('Username must be 3–20 characters: letters, numbers, dots, underscores.', false);
    return;
  }

  $('saveProfileBtn').disabled = true;
  $('saveProfileBtn').textContent = 'Saving…';

  const patch = { username, display_name: displayName, bio, hidden };
  const result = await chAuth.updateProfile(patch);

  $('saveProfileBtn').disabled = false;
  $('saveProfileBtn').textContent = 'Save changes';

  if (!result.ok) {
    showProfileMsg(result.error, false);
    return;
  }

  showProfileMsg('Saved.', true);
  renderProfileFields(result.profile);
  if (typeof mountHeader === 'function') await mountHeader();
  setTimeout(clearProfileMsg, 2400);
});

$('resetProfileBtn').addEventListener('click', () => {
  clearProfileMsg();
  renderProfileFields(currentProfile);
});

// ============================================================
// Username availability
// ============================================================
let usernameCheckTimer = null;
function setUsernameStatus(state, text) {
  const el = $('usernameStatus');
  el.className = 'settings-field__status';
  el.textContent = text || '';
  if (state === 'ok')  el.classList.add('is-ok');
  if (state === 'taken' || state === 'bad') el.classList.add('is-bad');
}
$('usernameInput').addEventListener('input', () => {
  const v = $('usernameInput').value.trim();
  if (!v) { setUsernameStatus('', ''); return; }
  if (v.toLowerCase() === (currentProfile?.username || '').toLowerCase()) {
    setUsernameStatus('ok', '✓');
    return;
  }
  if (!USERNAME_RE.test(v)) { setUsernameStatus('bad', '✗'); return; }
  setUsernameStatus('', '…');
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    const res = await chAuth.checkUsernameAvailable(v);
    if ($('usernameInput').value.trim() !== v) return;
    if (res.ok) setUsernameStatus('ok', '✓');
    else if (res.reason === 'taken') setUsernameStatus('taken', '✗');
    else setUsernameStatus('', '?');
  }, 350);
});

// ============================================================
// Avatar modal
// ============================================================
const avatarModal = $('avatarModal');
function openAvatarModal() {
  $('avatarError').hidden = true;
  $('avatarError').textContent = '';
  renderAvatarGrid();
  switchTab('upload');
  avatarModal.classList.add('is-open');
}
function closeAvatarModal() { avatarModal.classList.remove('is-open'); }

$('avatarBtn').addEventListener('click', openAvatarModal);
$('avatarCancel').addEventListener('click', closeAvatarModal);
avatarModal.addEventListener('click', (e) => { if (e.target === avatarModal) closeAvatarModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (avatarModal.classList.contains('is-open')) closeAvatarModal();
    if ($('deleteModal').classList.contains('is-open')) $('deleteModal').classList.remove('is-open');
  }
});

function switchTab(name) {
  document.querySelectorAll('.settings-tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  document.querySelectorAll('.settings-tab-panel').forEach((p) => {
    p.classList.toggle('is-active', p.dataset.panel === name);
  });
}
document.querySelectorAll('.settings-tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

const dropzone = $('dropzone');
const fileInput = $('avatarFileInput');

['dragenter', 'dragover'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-hover');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-hover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadAndApply(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadAndApply(fileInput.files[0]);
});

async function uploadAndApply(file) {
  const errEl = $('avatarError');
  errEl.hidden = true;
  errEl.textContent = '';

  const result = await chAuth.uploadAvatar(file);
  if (!result.ok) {
    errEl.textContent = result.error;
    errEl.hidden = false;
    return;
  }
  currentProfile.avatar_url = result.url;
  renderAvatar(currentProfile);
  if (typeof mountHeader === 'function') await mountHeader();
  closeAvatarModal();
  if (typeof showToast === 'function') showToast('Avatar updated');
}

function renderAvatarGrid() {
  const grid = $('avatarGrid');
  grid.innerHTML = '';
  if (!PRESET_AVATARS.length) {
    grid.innerHTML = '<div class="settings-avatar-empty">No presets yet — coming soon.</div>';
    return;
  }
  PRESET_AVATARS.forEach((url) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-avatar-item';
    btn.style.backgroundImage = 'url(' + url + ')';
    if (currentProfile?.avatar_url === url) btn.classList.add('is-selected');
    btn.addEventListener('click', async () => {
      const result = await chAuth.updateProfile({ avatar_url: url });
      if (!result.ok) {
        const errEl = $('avatarError');
        errEl.textContent = result.error;
        errEl.hidden = false;
        return;
      }
      currentProfile.avatar_url = url;
      renderAvatar(currentProfile);
      if (typeof mountHeader === 'function') await mountHeader();
      closeAvatarModal();
      if (typeof showToast === 'function') showToast('Avatar updated');
    });
    grid.appendChild(btn);
  });
}

// ============================================================
// Delete account modal
// ============================================================
const deleteModal = $('deleteModal');
const deleteInput = $('confirmUsername');
const deleteConfirmBtn = $('confirmDelete');

function openDeleteModal() {
  $('modalError').hidden = true;
  $('modalError').textContent = '';
  deleteInput.value = '';
  deleteInput.classList.remove('is-match');
  deleteConfirmBtn.disabled = true;
  deleteModal.classList.add('is-open');
  setTimeout(() => deleteInput.focus(), 180);
}
function closeDeleteModal() { deleteModal.classList.remove('is-open'); }

$('openDeleteModal').addEventListener('click', openDeleteModal);
$('cancelDelete').addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });

deleteInput.addEventListener('input', () => {
  const v = deleteInput.value.trim();
  const matches = v.length > 0 && v.toLowerCase() === (currentProfile?.username || '').toLowerCase();
  deleteInput.classList.toggle('is-match', matches);
  deleteConfirmBtn.disabled = !matches;
});

deleteConfirmBtn.addEventListener('click', async () => {
  if (deleteConfirmBtn.disabled) return;

  const ok = confirm(
    'FINAL WARNING\n\n' +
    'You are about to permanently delete the account "' + (currentProfile?.username || '') + '".\n\n' +
    'All of your data will be erased. This CANNOT be undone.\n\n' +
    'Click OK to permanently delete, Cancel to back out.'
  );
  if (!ok) return;

  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = 'Deleting…';
  $('modalError').hidden = true;

  const { error } = await chAuth.client.rpc('delete_own_account');
  if (error) {
    $('modalError').textContent = 'Delete failed: ' + error.message;
    $('modalError').hidden = false;
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Permanently delete';
    return;
  }

  try {
    localStorage.removeItem('cloudhub-auth');
    localStorage.removeItem(CH.STORAGE_PROGRESS);
    localStorage.removeItem(CH.STORAGE_SETTINGS);
    localStorage.removeItem(CH.STORAGE_WATCHLIST);
    localStorage.removeItem(CH.STORAGE_USER);
  } catch (e) {}
  try { await chAuth.client.auth.signOut(); } catch (e) {}

  deleteModal.innerHTML =
    '<div class="settings-modal__inner">' +
      '<div class="settings-modal__icon" style="color:#7cbf3f;background:rgba(124,191,63,0.12);border-color:rgba(124,191,63,0.55);box-shadow:0 0 30px rgba(124,191,63,0.35);animation:none;">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</div>' +
      '<h2 class="settings-modal__title">Account deleted</h2>' +
      '<p class="settings-modal__sub">Your account and all associated data have been permanently removed.</p>' +
    '</div>';

  setTimeout(() => { window.location.href = '/home'; }, 1400);
});

// ============================================================
// Report button
// ============================================================
$('openSettingsReport').addEventListener('click', () => {
  if (typeof openReportModal === 'function') {
    openReportModal('Account Settings');
  }
});

// ============================================================
// Boot
// ============================================================
(async function init() {
  const session = await chAuth.requireAuth('/user/settings');
  if (!session) return;

  currentUser = session.user;
  renderProfileFields(session.profile);
  renderAccount(session.profile, session.user);

  if (typeof chPageReady === 'function') chPageReady();
})();
