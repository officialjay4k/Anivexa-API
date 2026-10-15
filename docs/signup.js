// ============================================================
// Cloud Hub — signup.js
// ============================================================

const $ = (id) => document.getElementById(id);

const emailEl = $('emailInput');
const usernameEl = $('usernameInput');
const usernameStatus = $('usernameStatus');
const passwordEl = $('passwordInput');
const passwordConfirmEl = $('passwordConfirmInput');
const errorEl = $('authError');
const submitBtn = $('signupBtn');

let usernameOK = false;
let usernameCheckTimer = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function setUsernameStatus(state, text) {
  usernameStatus.className = 'auth-field__status';
  usernameStatus.textContent = text || '';
  if (state === 'ok')  usernameStatus.classList.add('is-ok');
  if (state === 'taken' || state === 'bad') usernameStatus.classList.add('is-bad');
}

usernameEl.addEventListener('input', () => {
  usernameOK = false;
  const v = usernameEl.value.trim();
  if (v.length === 0) { setUsernameStatus('', ''); return; }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) {
    setUsernameStatus('bad', '✗');
    return;
  }
  setUsernameStatus('', '…');
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    const res = await chAuth.checkUsernameAvailable(v);
    if (usernameEl.value.trim() !== v) return;
    if (res.ok) { usernameOK = true; setUsernameStatus('ok', '✓'); }
    else if (res.reason === 'taken') { usernameOK = false; setUsernameStatus('taken', '✗'); }
    else { usernameOK = false; setUsernameStatus('', '?'); }
  }, 350);
});

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const email = emailEl.value.trim();
  const username = usernameEl.value.trim();
  const pw = passwordEl.value;
  const pw2 = passwordConfirmEl.value;

  if (!usernameOK) {
    const res = await chAuth.checkUsernameAvailable(username);
    if (!res.ok) {
      showError(res.reason === 'taken' ? 'Username is taken.' : 'Invalid username.');
      return;
    }
  }
  if (pw.length < 6) { showError('Password must be at least 6 characters.'); return; }
  if (pw !== pw2)    { showError('Passwords don\'t match.'); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';

  const result = await chAuth.signUp(email, pw, username);
  if (!result.ok) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create account';
    showError(result.error);
    return;
  }

  location.href = '/user/dashboard';
});

(async () => {
  const { data: { session } } = await chAuth.client.auth.getSession();
  if (session) location.href = '/user/dashboard';
})();
