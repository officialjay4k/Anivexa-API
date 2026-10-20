// ============================================================
// Cloud Hub — auth.js
// ============================================================

const chAuth = (() => {
  const sb = window.sb;
  if (!sb) {
    console.warn('[auth] Supabase client missing — auth features disabled');
    const noop = () => Promise.resolve({ ok: false, error: 'Auth unavailable' });
    return {
      client: null,
      refresh: () => Promise.resolve({ user: null, profile: null }),
      onAuthChange: () => {},
      requireAuth: () => null,
      signUp: noop, signIn: noop, signOut: () => Promise.resolve(),
      signInWithGoogle: noop,
      checkUsernameAvailable: () => Promise.resolve({ ok: false, reason: 'error' }),
      updateProfile: noop, uploadAvatar: noop,
      fetchPublicProfile: () => Promise.resolve(null),
      fetchWatchlist: () => Promise.resolve([]),
      fetchNotifications: () => Promise.resolve([]),
      markNotificationRead: () => Promise.resolve(),
      markAllNotificationsRead: () => Promise.resolve(),
      createNotification: noop,
      upsertWatchlistEntry: noop, removeWatchlistEntry: noop,
      recomputeStats: () => Promise.resolve(null),
      tierFromScore: () => 'Chunin',
      formatUserId: (n) => String(n).padStart(3, '0'),
      get user() { return null; },
      get profile() { return null; }
    };
  }

  const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;

  let cachedUser = null;
  let cachedProfile = null;
  let listeners = [];
  let heartbeatInterval = null;

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

  function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (!cachedUser) return;

    // Send heartbeat immediately
    sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', cachedUser.id).then(() => {});

    // Ping every 60 seconds
    heartbeatInterval = setInterval(() => {
      if (cachedUser) {
        sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', cachedUser.id).then(() => {});
      }
    }, 60000);
  }

  async function refresh() {
    const { data: { session } } = await sb.auth.getSession();
    cachedUser = session?.user || null;
    cachedProfile = cachedUser ? await fetchProfile(cachedUser.id) : null;
    
    if (cachedUser) {
      startHeartbeat();
    } else {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }

    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  function onAuthChange(fn) {
    listeners.push(fn);
    fn(cachedUser, cachedProfile);
  }

  async function signUp(email, password, username) {
    const clean = String(username || '').trim();
    if (!USERNAME_RE.test(clean)) {
      return { ok: false, error: 'Username must be 3–20 chars: letters, numbers, dots, underscores.' };
    }
    const { data: taken, error: tErr } = await sb.rpc('username_taken', { name: clean });
    if (tErr) return { ok: false, error: 'Could not check username: ' + tErr.message };
    if (taken) return { ok: false, error: 'That username is already taken.' };

    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { username: clean, display_name: clean } }
    });
    if (error) return { ok: false, error: error.message };
    const user = data.user;
    if (!user) return { ok: false, error: 'Signup succeeded but no user returned.' };

    if (!data.session) {
      return { ok: true, needsEmailConfirm: true, user: user, profile: null, message: 'Check your email.' };
    }

    let upErr = null;
    for (let i = 0; i < 2; i++) {
      const r = await sb.from('profiles').update({ username: clean }).eq('id', user.id);
      upErr = r.error;
      if (!upErr) break;
      await new Promise(function (res) { setTimeout(res, 250); });
    }
    if (upErr) return { ok: false, error: 'Profile setup failed: ' + upErr.message };

    await refresh();
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/email not confirmed/i.test(error.message)) {
        return { ok: false, error: 'Please confirm your email first.', code: 'EMAIL_NOT_CONFIRMED' };
      }
      return { ok: false, error: error.message };
    }
    await refresh();
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  async function signInWithGoogle() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + '/auth/callback' }
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async function signOut() {
    if (cachedUser) {
      await sb.from('profiles').update({ last_seen: new Date(0).toISOString() }).eq('id', cachedUser.id);
    }
    await sb.auth.signOut();
    cachedUser = null;
    cachedProfile = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    emit();
  }

  async function checkUsernameAvailable(name) {
    const clean = String(name || '').trim();
    if (!USERNAME_RE.test(clean)) return { ok: false, reason: 'format' };
    const { data, error } = await sb.rpc('username_taken', { name: clean });
    if (error) return { ok: false, reason: 'error', error: error.message };
    return { ok: !data, reason: data ? 'taken' : 'ok' };
  }

  async function updateProfile(patch) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    const allowed = ['username', 'display_name', 'bio', 'avatar_url', 'hidden'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];

    if (clean.username) {
      const currentName = (cachedProfile?.username || '').toLowerCase();
      if (clean.username.toLowerCase() !== currentName) {
        const { ok, reason } = await checkUsernameAvailable(clean.username);
        if (!ok && reason === 'taken') return { ok: false, error: 'That username is already taken.' };
        if (!ok && reason === 'format') return { ok: false, error: 'Invalid username format.' };
      }
    }

    const { error } = await sb.from('profiles').update(clean).eq('id', cachedUser.id);
    if (error) return { ok: false, error: error.message };
    await refresh();
    return { ok: true, profile: cachedProfile };
  }

  async function uploadAvatar(file) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    if (!file) return { ok: false, error: 'No file' };
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return { ok: false, error: 'Must be an image (png/jpg/webp/gif)' };
    if (file.size > 4 * 1024 * 1024) return { ok: false, error: 'Image too large (max 4 MB)' };

    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const path = cachedUser.id + '/avatar-' + Date.now() + '.' + ext;
    const up = await sb.storage.from('avatars').upload(path, file, { upsert: true, cacheControl: '3600' });
    if (up.error) return { ok: false, error: up.error.message };
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    const url = pub.publicUrl;
    const { error: pErr } = await sb.from('profiles').update({ avatar_url: url }).eq('id', cachedUser.id);
    if (pErr) return { ok: false, error: pErr.message };
    await refresh();
    return { ok: true, url: url };
  }

  async function requireAuth(redirectBack) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user) {
      const back = redirectBack || (location.pathname + location.search);
      location.href = '/auth/login?next=' + encodeURIComponent(back);
      return null;
    }
    cachedUser = session.user;
    cachedProfile = await fetchProfile(cachedUser.id);
    if (cachedUser) startHeartbeat();
    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  async function fetchPublicProfile(username) {
    const { data, error } = await sb.from('public_profiles').select('*').ilike('username', username).maybeSingle();
    if (error || !data) return null;
    return data;
  }

  async function fetchWatchlist(userId) {
    const { data, error } = await sb.from('watchlist').select('*').eq('user_id', userId).order('updated_at', { ascending: false });
    if (error) return [];
    return data || [];
  }

  async function fetchNotifications() {
    if (!cachedUser) return [];
    const { data, error } = await sb.from('notifications').select('*').eq('user_id', cachedUser.id).order('created_at', { ascending: false }).limit(30);
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

  async function createNotification(title, message, link) {
    if (!cachedUser) return;
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: existing } = await sb.from('notifications')
      .select('id')
      .eq('user_id', cachedUser.id)
      .eq('title', title)
      .gte('created_at', oneDayAgo)
      .limit(1);
      
    if (existing && existing.length > 0) return;

    await sb.from('notifications').insert({
      user_id: cachedUser.id, title: title, message: message, link: link, read: false
    });
  }

  async function checkWatchlistAnnouncements() {
    if (!cachedUser) return;
    try {
      const list = await fetchWatchlist(cachedUser.id);
      const watching = list.filter(w => w.status === 'watching');
      if (!watching.length) return;

      const ids = watching.map(w => w.anilist_id);
      const query = `
        query ($ids: [Int]) {
          Page(page: 1, perPage: 50) {
            media(id_in: $ids, type: ANIME) {
              id title { english romaji }
              nextAiringEpisode { episode airingAt }
            }
          }
        }
      `;
      
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids } })
      });
      const json = await res.json();
      const media = json.data?.Page?.media || [];
      const now = Math.floor(Date.now() / 1000);

      for (const m of media) {
        if (m.nextAiringEpisode && m.nextAiringEpisode.airingAt < now && m.nextAiringEpisode.airingAt > now - 86400 * 3) {
           const title = m.title.english || m.title.romaji;
           const ep = m.nextAiringEpisode.episode - 1;
           await createNotification(`New Episode: ${title}`, `Episode ${ep} is now available to watch!`, `/watch?id=${m.id}&ep=${ep}&lang=dub`);
        }
      }
    } catch(e) {}
  }

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
      finished, watching, watch_later, dropped, rated,
      watch_hours: watchHours, score: score, tier: tier
    });
    if (error) console.warn('[stats] upsert failed:', error.message);
    return { finished, watching, watch_later, dropped, rated, watch_hours: watchHours, score, tier };
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
    refresh, onAuthChange, requireAuth,
    signUp, signIn, signInWithGoogle, signOut,
    checkUsernameAvailable, updateProfile, uploadAvatar,
    fetchPublicProfile, fetchWatchlist,
    fetchNotifications, markNotificationRead, markAllNotificationsRead, createNotification,
    checkWatchlistAnnouncements,
    upsertWatchlistEntry, removeWatchlistEntry,
    recomputeStats, tierFromScore, formatUserId,
    get user()    { return cachedUser; },
    get profile() { return cachedProfile; }
  };
})();

window.chAuth = chAuth;
