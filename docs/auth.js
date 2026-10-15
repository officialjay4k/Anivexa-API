// ============================================================
// Cloud Hub — auth.js
// Auth + profile + watchlist + notification helpers.
// ============================================================

const chAuth = (() => {
  const sb = window.sb;
  if (!sb) throw new Error('Supabase client missing');

  let cachedUser = null;
  let cachedProfile = null;
  let listeners = [];

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(cachedUser, cachedProfile); } catch (e) {}
    });
  }

  async function fetchProfile(userId) {
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) return null;
    return data;
  }

  async function refresh() {
    const { data: { session } } = await sb.auth.getSession();
    cachedUser = session?.user || null;
    cachedProfile = cachedUser ? await fetchProfile(cachedUser.id) : null;
    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  function onAuthChange(fn) {
    listeners.push(fn);
    fn(cachedUser, cachedProfile);
  }

  // ---------- Signup ----------
  async function signUp(email, password, username) {
    const clean = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(clean)) {
      return { ok: false, error: 'Username must be 3–20 chars: letters, numbers, underscores.' };
    }
    const { data: taken, error: tErr } = await sb.rpc('username_taken', { name: clean });
    if (tErr) return { ok: false, error: 'Could not check username: ' + tErr.message };
    if (taken) return { ok: false, error: 'That username is already taken.' };

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    const user = data.user;
    if (!user) return { ok: false, error: 'Signup succeeded but no user returned.' };

    // Make sure session is set before the profile update.
    if (!data.session) {
      await sb.auth.getSession().catch(function () {});
    }

    // Update the placeholder username created by the trigger.
    // One retry in case RLS isn't ready instantly.
    let upErr = null;
    for (let i = 0; i < 2; i++) {
      const r = await sb.from('profiles').update({ username: clean }).eq('id', user.id);
      upErr = r.error;
      if (!upErr) break;
      await new Promise(function (res) { setTimeout(res, 250); });
    }
    if (upErr) {
      return { ok: false, error: 'Profile setup failed: ' + upErr.message + ' — try logging in with the account you just made.' };
    }

    await refresh();
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  // ---------- Login ----------
  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    await refresh();
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  async function signOut() {
    await sb.auth.signOut();
    cachedUser = null;
    cachedProfile = null;
    emit();
  }

  // ---------- Username availability ----------
  async function checkUsernameAvailable(name) {
    const clean = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(clean)) {
      return { ok: false, reason: 'format' };
    }
    const { data, error } = await sb.rpc('username_taken', { name: clean });
    if (error) return { ok: false, reason: 'error', error: error.message };
    return { ok: !data, reason: data ? 'taken' : 'ok' };
  }

  // ---------- Profile edits ----------
  async function updateProfile(patch) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    const allowed = ['username', 'display_name', 'bio', 'avatar_url', 'hidden'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];

    if (clean.username) {
      const { ok, reason } = await checkUsernameAvailable(clean.username);
      if (!ok && reason === 'taken') return { ok: false, error: 'That username is already taken.' };
      if (!ok && reason === 'format') return { ok: false, error: 'Invalid username format.' };
    }

    const { error } = await sb.from('profiles').update(clean).eq('id', cachedUser.id);
    if (error) return { ok: false, error: error.message };
    await refresh();
    return { ok: true, profile: cachedProfile };
  }

  // ---------- Avatar upload ----------
  async function uploadAvatar(file) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    if (!file) return { ok: false, error: 'No file' };
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      return { ok: false, error: 'Must be an image (png/jpg/webp/gif)' };
    }
    if (file.size > 4 * 1024 * 1024) return { ok: false, error: 'Image too large (max 4 MB)' };

    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const path = cachedUser.id + '/avatar-' + Date.now() + '.' + ext;
    const up = await sb.storage.from('avatars').upload(path, file, {
      upsert: true,
      cacheControl: '3600'
    });
    if (up.error) return { ok: false, error: up.error.message };
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    const url = pub.publicUrl;
    const { error: pErr } = await sb.from('profiles').update({ avatar_url: url }).eq('id', cachedUser.id);
    if (pErr) return { ok: false, error: pErr.message };
    await refresh();
    return { ok: true, url: url };
  }

  // ---------- Page guard ----------
  async function requireAuth(redirectBack) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user) {
      const back = redirectBack || (location.pathname + location.search);
      location.href = '/auth/login?next=' + encodeURIComponent(back);
      return null;
    }
    cachedUser = session.user;
    cachedProfile = await fetchProfile(cachedUser.id);
    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  // ---------- Public data ----------
  async function fetchPublicProfile(username) {
    const { data, error } = await sb
      .from('public_profiles')
      .select('*')
      .ilike('username', username)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  }

  async function fetchWatchlist(userId) {
    const { data, error } = await sb
      .from('watchlist')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) return [];
    return data || [];
  }

  // ---------- Notifications ----------
  async function fetchNotifications() {
    if (!cachedUser) return [];
    const { data, error } = await sb
      .from('notifications')
      .select('*')
      .eq('user_id', cachedUser.id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return [];
    return data || [];
  }

  async function markNotificationRead(id) {
    if (!cachedUser) return;
    await sb.from('notifications').update({ read: true }).eq('id', id).eq('user_id', cachedUser.id);
  }

  async function markAllNotificationsRead() {
    if (!cachedUser) return;
    await sb.from('notifications').update({ read: true }).eq('user_id', cachedUser.id).eq('read', false);
  }

  // ---------- Watchlist + stats ----------
  function tierFromScore(score) {
    if (score >= 5000) return 'Akatsuki';
    if (score >= 2000) return 'Hokage';
    if (score >= 750)  return 'Anbu Black Ops';
    if (score >= 250)  return 'Elite';
    if (score >= 75)   return 'Jonin';
    return 'Chunin';
  }

  async function recomputeStats() {
    if (!cachedUser) return null;
    const list = await fetchWatchlist(cachedUser.id);
    let finished = 0, watching = 0, watch_later = 0, dropped = 0, rated = 0;
    for (const e of list) {
      if (e.status === 'completed') finished++;
      else if (e.status === 'watching') watching++;
      else if (e.status === 'plan')     watch_later++;
      else if (e.status === 'dropped')  dropped++;
      if (e.score && e.score > 0) rated++;
    }

    let watchHours = 0;
    try {
      const store = JSON.parse(localStorage.getItem(CH.STORAGE_PROGRESS)) || {};
      let seconds = 0;
      for (const v of Object.values(store)) if (v && v.currentTime) seconds += v.currentTime;
      watchHours = Math.round((seconds / 3600) * 10) / 10;
    } catch (e) {}

    const score = Math.round(finished * 10 + rated * 3 + watchHours * 2);
    const tier = tierFromScore(score);

    const { error } = await sb.from('stats').upsert({
      user_id: cachedUser.id,
      finished: finished,
      watching: watching,
      watch_later: watch_later,
      dropped: dropped,
      rated: rated,
      watch_hours: watchHours,
      score: score,
      tier: tier
    });
    if (error) console.warn('[stats] upsert failed:', error.message);

    return {
      finished: finished,
      watching: watching,
      watch_later: watch_later,
      dropped: dropped,
      rated: rated,
      watch_hours: watchHours,
      score: score,
      tier: tier
    };
  }

  async function upsertWatchlistEntry(entry) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    const row = {
      user_id: cachedUser.id,
      anilist_id: entry.anilistId,
      title: entry.title || ('AniList ' + entry.anilistId),
      image: entry.image || null,
      status: entry.status || 'watching',
      progress_ep: entry.progressEp || 0,
      score: entry.score || null
    };
    const { error } = await sb.from('watchlist').upsert(row, { onConflict: 'user_id,anilist_id' });
    if (error) return { ok: false, error: error.message };
    await recomputeStats();
    return { ok: true };
  }

  async function removeWatchlistEntry(anilistId) {
    if (!cachedUser) return { ok: false };
    await sb.from('watchlist').delete().eq('user_id', cachedUser.id).eq('anilist_id', anilistId);
    await recomputeStats();
    return { ok: true };
  }

  function formatUserId(n) {
    return String(n).padStart(3, '0');
  }

  return {
    client: sb,
    refresh: refresh,
    onAuthChange: onAuthChange,
    requireAuth: requireAuth,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    checkUsernameAvailable: checkUsernameAvailable,
    updateProfile: updateProfile,
    uploadAvatar: uploadAvatar,
    fetchPublicProfile: fetchPublicProfile,
    fetchWatchlist: fetchWatchlist,
    fetchNotifications: fetchNotifications,
    markNotificationRead: markNotificationRead,
    markAllNotificationsRead: markAllNotificationsRead,
    upsertWatchlistEntry: upsertWatchlistEntry,
    removeWatchlistEntry: removeWatchlistEntry,
    recomputeStats: recomputeStats,
    tierFromScore: tierFromScore,
    formatUserId: formatUserId,
    get user()    { return cachedUser; },
    get profile() { return cachedProfile; }
  };
})();

window.chAuth = chAuth;
