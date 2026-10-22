(async function() {
  if (window.chAuth) {
    try { await chAuth.refresh(); } catch(e) {}
    const pts = chAuth.profile?.points || 0;
    const el = document.getElementById('shopPoints');
    if (el) el.textContent = '✨ ' + pts + ' Points';
  }
  if (typeof chPageReady === 'function') chPageReady();
})();
