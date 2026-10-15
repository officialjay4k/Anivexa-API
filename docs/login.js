// ============================================================
// Cloud Hub — login.js
// ============================================================

const $ = (id) => document.getElementById(id);
const emailEl = $('emailInput');
const passwordEl = $('passwordInput');
const errorEl = $('authError');
const successEl = $('authSuccess');
const submitBtn = $('loginBtn');

function getNext() {
  const p = new URLSearchParams(location.search);
  const n = p.get('next');
  if (n && n.startsWith('/')) return n;
  return '/user/dashboard';
}

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

// Show error from OAuth failure or /auth/callback redirect
(function showRedirectError() {
  const p = new URLSearchParams(location.search);
  if (p.get('error') === 'oauth_failed') {
    showError('Google sign-in failed. Please try again.');
  }
})();

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessages();

  const email = emailEl.value.trim();
  const pw = passwordEl.value;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  const result = await chAuth.signIn(email, pw);
  if (!result.ok) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
    showError(result.error);
    return;
  }
  location.href = getNext();
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
  // On success the browser navigates away
});

// If already signed in, bounce
(async () => {
  const { data: { session } } = await chAuth.client.auth.getSession();
  if (session) location.href = getNext();
})();
