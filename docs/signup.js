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
const successEl = $('authSuccess');
const submitBtn = $('signupBtn');

const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

let usernameOK = false;
let usernameCheckTimer = null;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  successEl.hidden = true;
}
function showSuccess(msg) {
  successEl.textContent = msg;
  successEl.hidden = false;
  errorEl.hidden = true;
}
function clearMessages() {
  errorEl.hidden = true;
  successEl.hidden = true;
  errorEl.textContent = '';
  successEl.textContent = '';
}

function setUsernameStatus(state, text) {
  usernameStatus.className = 'auth-field__status';
  usernameStatus.textContent = text || '';
  if (state === 'ok')  usernameStatus.classList.add('is-ok');
  if (state === 'taken' || state === 'bad') usernameStatus.classList.add('is-bad');
}

function validateUsernameUI() {
  usernameOK = false;
  const v = usernameEl.value.trim();
  if (v.length === 0) { setUsernameStatus('', ''); return; }
  if (!USERNAME_RE.test(v)) { setUsernameStatus('bad', '✗'); return; }
  setUsernameStatus('', '…');
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    const res = await chAuth.checkUsernameAvailable(v);
    if (usernameEl.value.trim() !== v) return;
    if (res.ok) { usernameOK = true; setUsernameStatus('ok', '✓'); }
    else if (res.reason === 'taken') { usernameOK = false; setUsernameStatus('taken', '✗'); }
    else { usernameOK = false; setUsernameStatus('', '?'); }
  }, 350);
}
usernameEl.addEventListener('input', validateUsernameUI);

function scrubAutofillIfEmail() {
  const v = usernameEl.value;
  if (!v) return;
  if (v.indexOf('@') !== -1 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    usernameEl.value = '';
    setUsernameStatus('', '');
  }
}
usernameEl.addEventListener('focus', function () { setTimeout(scrubAutofillIfEmail, 40); });
usernameEl.addEventListener('change', scrubAutofillIfEmail);
let scrubTries = 0;
const scrubInterval = setInterval(function () {
  scrubAutofillIfEmail();
  if (++scrubTries > 20) clearInterval(scrubInterval);
}, 100);

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessages();
  scrubAutofillIfEmail();

  const email = emailEl.value.trim();
  const username = usernameEl.value.trim();
  const pw = passwordEl.value;
  const pw2 = passwordConfirmEl.value;

  if (!USERNAME_RE.test(username)) {
    showError('Username must be 3–20 chars: letters, numbers, dots, underscores.');
    return;
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

  // If email confirmation is on, Supabase returns a user but no session.
  if (result.needsEmailConfirm) {
    showSuccess('Account created. Check your email — click the confirmation link, then sign in.');
    submitBtn.textContent = 'Created';
    setTimeout(() => {
      location.href = '/auth/login';
    }, 2600);
    return;
  }

  location.href = '/user/dashboard';
});

$('googleBtn').addEventListener('click', async () => {
  clearMessages();
  const btn = $('googleBtn');
  btn.disabled = true;
  const result = await chAuth.signInWithGoogle();
  if (!result.ok) {
    btn.disabled = false;
    showError(result.error);
  }
});

(async () => {
  const { data: { session } } = await chAuth.client.auth.getSession();
  if (session) location.href = '/user/dashboard';
})();
