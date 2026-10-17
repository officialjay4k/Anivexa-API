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

const signupForm = $('signupForm');
const signupExtras = $('signupExtras');
const otpPanel = $('otpPanel');
const otpEmailEl = $('otpEmail');
const otpInput = $('otpInput');
const otpError = $('otpError');
const otpSuccess = $('otpSuccess');
const otpVerifyBtn = $('otpVerifyBtn');
const otpResendBtn = $('otpResendBtn');
const otpChangeEmailBtn = $('otpChangeEmail');

const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

let usernameOK = false;
let usernameCheckTimer = null;

let pendingEmail = '';
let pendingUsername = '';
let resendTimer = null;
let resendCooldown = 0;
let transitionBusy = false;

// ---------- Form-level messages ----------
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

// ---------- OTP-panel messages ----------
function showOtpError(msg) {
  otpError.textContent = msg;
  otpError.hidden = false;
  otpSuccess.hidden = true;
}
function showOtpSuccess(msg) {
  otpSuccess.textContent = msg;
  otpSuccess.hidden = false;
  otpError.hidden = true;
}
function clearOtpMessages() {
  otpError.hidden = true;
  otpSuccess.hidden = true;
  otpError.textContent = '';
  otpSuccess.textContent = '';
}

// ---------- Username availability ----------
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

// Chrome keeps trying to autofill the email into the username field.
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

// ---------- Signup submit ----------
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (transitionBusy) return;
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

  // Email confirmation is ON — swap the form for the OTP panel.
  if (result.needsEmailConfirm) {
    pendingEmail = email;
    pendingUsername = username;
    showOtpPanel();
    return;
  }

  // Email confirmation OFF — session already live.
  location.href = '/user/dashboard';
});

// ---------- OTP panel: animated swap ----------
function showOtpPanel() {
  if (transitionBusy) return;
  transitionBusy = true;

  // 1. Play exit animation on the form + extras.
  signupForm.classList.add('is-leaving');
  signupExtras.classList.add('is-leaving');

  // 2. After the exit animation finishes, hide them and reveal the OTP panel.
  setTimeout(() => {
    signupForm.hidden = true;
    signupExtras.hidden = true;
    signupForm.classList.remove('is-leaving');
    signupExtras.classList.remove('is-leaving');

    otpEmailEl.textContent = pendingEmail;
    otpInput.value = '';
    clearOtpMessages();

    otpVerifyBtn.disabled = false;
    otpVerifyBtn.textContent = 'Verify & continue';

    otpPanel.hidden = false;

    // 3. Force a reflow so the enter animation actually runs.
    void otpPanel.offsetWidth;
    otpPanel.classList.add('is-entering');

    setTimeout(() => {
      otpPanel.classList.remove('is-entering');
      transitionBusy = false;
      otpInput.focus();
    }, 440);

    startResendCooldown(60);
  }, 240);
}

function backToForm() {
  if (transitionBusy) return;
  transitionBusy = true;

  otpPanel.classList.add('is-leaving');
  // Use the same exit animation the form uses.
  otpPanel.style.animation = 'ch-form-out 240ms cubic-bezier(0.4, 0, 0.6, 1) forwards';
  otpPanel.style.pointerEvents = 'none';

  setTimeout(() => {
    otpPanel.hidden = true;
    otpPanel.style.animation = '';
    otpPanel.style.pointerEvents = '';

    signupForm.hidden = false;
    signupExtras.hidden = false;

    submitBtn.disabled = false;
    submitBtn.textContent = 'Create account';
    clearMessages();
    clearOtpMessages();
    stopResendCooldown();

    signupForm.classList.add('is-entering-form');
    signupExtras.classList.add('is-entering-form');
    setTimeout(() => {
      signupForm.classList.remove('is-entering-form');
      signupExtras.classList.remove('is-entering-form');
      transitionBusy = false;
    }, 300);
  }, 240);
}

// ---------- OTP input handling ----------
otpInput.addEventListener('input', () => {
  otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
  clearOtpMessages();
  if (otpInput.value.length === 6) verifyOtp();
});

otpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    verifyOtp();
  }
});

// ---------- Verify ----------
let verifying = false;
async function verifyOtp() {
  if (verifying) return;
  const token = otpInput.value.trim();
  if (token.length !== 6) {
    showOtpError('Enter the 6-digit code from your email.');
    return;
  }

  verifying = true;
  otpVerifyBtn.disabled = true;
  otpVerifyBtn.textContent = 'Verifying…';
  clearOtpMessages();

  const { data, error } = await chAuth.client.auth.verifyOtp({
    email: pendingEmail,
    token,
    type: 'signup'
  });

  if (error) {
    verifying = false;
    otpVerifyBtn.disabled = false;
    otpVerifyBtn.textContent = 'Verify & continue';
    showOtpError(error.message || 'That code didn\'t work. Try again.');
    otpInput.value = '';
    otpInput.focus();
    return;
  }

  // Session is live now. Make sure the username stuck.
  if (pendingUsername && data?.user?.id) {
    try {
      await chAuth.client
        .from('profiles')
        .update({ username: pendingUsername, display_name: pendingUsername })
        .eq('id', data.user.id);
    } catch (e) {
      // Non-fatal — profile can be fixed from settings later.
    }
  }

  showOtpSuccess('Verified! Taking you to your dashboard…');
  otpVerifyBtn.textContent = 'Verified';

  setTimeout(() => { location.href = '/user/dashboard'; }, 700);
}

otpVerifyBtn.addEventListener('click', verifyOtp);

// ---------- Resend ----------
async function resendOtp() {
  if (resendCooldown > 0) return;

  otpResendBtn.disabled = true;
  otpResendBtn.textContent = 'Sending…';
  clearOtpMessages();

  const { error } = await chAuth.client.auth.resend({
    type: 'signup',
    email: pendingEmail
  });

  if (error) {
    otpResendBtn.disabled = false;
    otpResendBtn.textContent = 'Resend code';
    showOtpError(error.message || 'Could not resend. Try again in a moment.');
    return;
  }

  showOtpSuccess('New code sent — check your inbox.');
  startResendCooldown(60);
}

otpResendBtn.addEventListener('click', resendOtp);

function startResendCooldown(seconds) {
  stopResendCooldown();
  resendCooldown = seconds;
  otpResendBtn.disabled = true;
  updateResendLabel();
  resendTimer = setInterval(() => {
    resendCooldown--;
    if (resendCooldown <= 0) {
      stopResendCooldown();
      otpResendBtn.disabled = false;
      otpResendBtn.textContent = 'Resend code';
      return;
    }
    updateResendLabel();
  }, 1000);
}

function stopResendCooldown() {
  if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
  resendCooldown = 0;
}

function updateResendLabel() {
  otpResendBtn.textContent = 'Resend code in ' + resendCooldown + 's';
}

// ---------- Change email ----------
otpChangeEmailBtn.addEventListener('click', backToForm);

// ---------- Google OAuth ----------
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

// ---------- Already signed in? Bounce. ----------
(async () => {
  const { data: { session } } = await chAuth.client.auth.getSession();
  if (session) location.href = '/user/dashboard';
})();
