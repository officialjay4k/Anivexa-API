// ============================================================
// Cloud Hub — login.js
// ============================================================

const $ = (id) => document.getElementById(id);
const emailEl = $('emailInput');
const passwordEl = $('passwordInput');
const errorEl = $('authError');
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
}
function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

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

(async () => {
  const { data: { session } } = await chAuth.client.auth.getSession();
  if (session) location.href = getNext();
})();
