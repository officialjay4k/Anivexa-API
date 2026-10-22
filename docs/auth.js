// ============================================================
// Cloud Hub — auth.js
// ============================================================

const chAuth = (() => {
  const sb = window.sb;
  if (!sb) {
    console.warn('[auth] Supabase client missing');
    const noop = () => Promise.resolve({ ok: false, error: 'Auth unavailable' });
    return { client: null, refresh: () => Promise.resolve({ user: null, profile: null }), onAuthChange: () => {}, requireAuth: () => null, signUp: noop, signIn: noop, signOut: () => Promise.resolve(), signInWithGoogle: noop, checkUsernameAvailable: () => Promise.resolve({ ok: false }), updateProfile: noop, uploadAvatar: noop, uploadBanner: noop, fetchPublicProfile: () => Promise.resolve(null), fetchWatchlist: () => Promise.resolve([]), fetchNotifications: () => Promise.resolve([]), markNotificationRead: () => Promise.resolve(), markAllNotificationsRead: () => Promise.resolve(), createNotification: noop, upsertWatchlistEntry: noop, removeWatchlistEntry: noop, recomputeStats: () => Promise.resolve(null), getFriends: () => Promise.resolve([]), getFriendRequests: () => Promise.resolve([]), sendFriendRequest: noop, acceptFriendRequest: noop, declineFriendRequest: noop, removeFriend: noop, sendMessage: noop, getMessages: () => Promise.resolve([]), tierFromScore: () => 'Chunin', formatUserId: (n) => String(n).padStart(3, '0'), get user() { return null; }, get profile() { return null; } };
  }

  const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
  let cachedUser = null, cachedProfile = null, listeners = [], heartbeatInterval = null;

  function emit() { listeners.forEach(fn => { try { fn(cachedUser, cachedProfile); } catch(e){} }); }

  async function fetchProfile(userId) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    return error ? null : data;
  }

  function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (!cachedUser) return;
    const ping = () => sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', cachedUser.id).then(() => {});
    ping();
    heartbeatInterval = setInterval(ping, 60000);
  }

  async function refresh() {
    const { data: { session } } = await sb.auth.getSession();
    cachedUser = session?.user || null;
    cachedProfile = cachedUser ? await fetchProfile(cachedUser.id) : null;
    if (cachedUser) startHeartbeat();
    else if (heartbeatInterval) clearInterval(heartbeatInterval);
    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  function onAuthChange(fn) { listeners.push(fn); fn(cachedUser, cachedProfile); }

  async function signUp(email, password, username) {
    const clean = String(username || '').trim();
    if (!USERNAME_RE.test(clean)) return { ok: false, error: 'Username must be 3-20 chars.' };
    const { data: taken, error: tErr } = await sb.rpc('username_taken', { name: clean });
    if (tErr) return { ok: false, error: tErr.message };
    if (taken) return { ok: false, error: 'Username taken.' };
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username: clean, display_name: clean } } });
    if (error) return { ok: false, error: error.message };
    if (!data.user) return { ok: false, error: 'No user returned.' };
    if (!data.session) return { ok: true, needsEmailConfirm: true, user: data.user, profile: null, message: 'Check email.' };
    for (let i = 0; i < 2; i++) {
      const r = await sb.from('profiles').update({ username: clean }).eq('id', data.user.id);
      if (!r.error) break;
      await new Promise(res => setTimeout(res, 250));
    }
    await refresh();
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/email not confirmed/i.test(error.message)) return { ok: false, error: 'Confirm your email first.', code: 'EMAIL_NOT_CONFIRMED' };
      return { ok: false, error: error.message };
    }
    await refresh();
    if (cachedProfile?.status === 'banned') { await sb.auth.signOut(); return { ok: false, error: 'Your account has been banned.' }; }
    if (cachedProfile?.status === 'suspended') { await sb.auth.signOut(); return { ok: false, error: 'Your account is suspended.' }; }
    return { ok: true, user: cachedUser, profile: cachedProfile };
  }

  async function signInWithGoogle() {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/auth/callback' } });
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async function signOut() {
    if (cachedUser) await sb.from('profiles').update({ last_seen: new Date(0).toISOString() }).eq('id', cachedUser.id);
    await sb.auth.signOut();
    cachedUser = null; cachedProfile = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    emit();
  }

  async function checkUsernameAvailable(name) {
    const clean = String(name || '').trim();
    if (!USERNAME_RE.test(clean)) return { ok: false, reason: 'format' };
    const { data, error } = await sb.rpc('username_taken', { name: clean });
    if (error) return { ok: false, reason: 'error' };
    return { ok: !data, reason: data ? 'taken' : 'ok' };
  }

  async function updateProfile(patch) {
    if (!cachedUser) return { ok: false, error: 'Not signed in' };
    const allowed = ['username', 'display_name', 'bio', 'avatar_url', 'banner_url', 'hidden'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if (clean.username) {
      const currentName = (cachedProfile?.username || '').toLowerCase();
      if (clean.username.toLowerCase() !== currentName) {
        const { ok, reason } = await checkUsernameAvailable(clean.username);
        if (!ok && reason === 'taken') return { ok: false, error: 'Username taken.' };
        if (!ok && reason === 'format') return { ok: false, error: 'Invalid format.' };
      }
    }
    const { error } = await sb.from('profiles').update(clean).eq('id', cachedUser.id);
    if (error) return { ok: false, error: error.message };
    await refresh();
    return { ok: true, profile: cachedProfile };
  }

  async function uploadAvatar(file) {
    if (!cachedUser) return { ok: false };
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return { ok: false, error: 'Must be image.' };
    if (file.size > 4*1024*1024) return { ok: false, error: 'Max 4MB' };
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const path = cachedUser.id + '/avatar-' + Date.now() + '.' + ext;
    const up = await sb.storage.from('avatars').upload(path, file, { upsert: true });
    if (up.error) return { ok: false, error: up.error.message };
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    await sb.from('profiles').update({ avatar_url: pub.publicUrl }).eq('id', cachedUser.id);
    await refresh();
    return { ok: true, url: pub.publicUrl };
  }

  async function uploadBanner(file) {
    if (!cachedUser) return { ok: false };
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return { ok: false, error: 'Must be image.' };
    if (file.size > 8*1024*1024) return { ok: false, error: 'Max 8MB' };
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const path = cachedUser.id + '/banner-' + Date.now() + '.' + ext;
    const up = await sb.storage.from('avatars').upload(path, file, { upsert: true });
    if (up.error) return { ok: false, error: up.error.message };
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    await sb.from('profiles').update({ banner_url: pub.publicUrl }).eq('id', cachedUser.id);
    await refresh();
    return { ok: true, url: pub.publicUrl };
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
    if (cachedProfile?.status === 'banned') { location.href = '/banned'; return null; }
    if (cachedProfile?.status === 'suspended') { location.href = '/suspended'; return null; }
    startHeartbeat();
    emit();
    return { user: cachedUser, profile: cachedProfile };
  }

  async function fetchPublicProfile(username) {
    const { data, error } = await sb.from('public_profiles').select('*').ilike('username', username).maybeSingle();
    return error ? null : data;
  }

  async function fetchWatchlist(userId) {
    const { data, error } = await sb.from('watchlist').select('*').eq('user_id', userId).order('updated_at', { ascending: false });
    return error ? [] : (data || []);
  }

  async function fetchNotifications() {
    if (!cachedUser) return [];
    const { data, error } = await sb.from('notifications').select('*').eq('user_id', cachedUser.id).order('created_at', { ascending: false }).limit(30);
    return error ? [] : (data || []);
  }

  async function markNotificationRead(id) {
    if (!cachedUser) return;
    await sb.from('notifications').update({ read: true }).eq('id', id).eq('user_id', cachedUser.id);
  }

  async function markAllNotificationsRead() {
    if (!cachedUser) return;
    await sb.from('notifications').update({ read: true }).eq('user_id', cachedUser.id).eq('read', false);
  }

  async function createNotification(title, message, link, type = 'info') {
    if (!cachedUser) return;
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: existing } = await sb.from('notifications').select('id').eq('user_id', cachedUser.id).eq('title', title).gte('created_at', oneDayAgo).limit(1);
    if (existing && existing.length > 0) return;
    await sb.from('notifications').insert({ user_id: cachedUser.id, title, message, link, type, read: false });
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
      else if (e.status === 'plan') watch_later++;
      else if (e.status === 'dropped') dropped++;
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
    await sb.from('stats').upsert({ user_id: cachedUser.id, finished, watching, watch_later, dropped, rated, watch_hours: watchHours, score, tier });
    const points = Math.floor(watchHours * 60);
    await sb.from('profiles').update({ points }).eq('id', cachedUser.id);
    return { finished, watching, watch_later, dropped, rated, watch_hours: watchHours, score, tier, points };
  }

  async function upsertWatchlistEntry(entry) {
    if (!cachedUser) return { ok: false };
    const row = {
      user_id: cachedUser.id, anilist_id: entry.anilistId,
      title: entry.title || ('AniList ' + entry.anilistId), image: entry.image || null,
      status: entry.status || 'watching', progress_ep: entry.progressEp || 0,
      score: entry.score || null, progress_time: entry.progressTime || 0, duration: entry.duration || 0
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

  // -------- FRIENDS --------
  async function getFriends() {
    if (!cachedUser) return [];
    const { data, error } = await sb.from('friendships')
      .select('*')
      .eq('status', 'accepted')
      .or('user_id.eq.' + cachedUser.id + ',friend_id.eq.' + cachedUser.id);
    if (error || !data) return [];
    const otherIds = data.map(f => f.user_id === cachedUser.id ? f.friend_id : f.user_id);
    const { data: profiles } = await sb.from('public_profiles').select('*').in('id', otherIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });
    return data.map(f => {
      const otherId = f.user_id === cachedUser.id ? f.friend_id : f.user_id;
      return { ...f, friend: profileMap[otherId] };
    });
  }

  async function getFriendRequests() {
    if (!cachedUser) return [];
    const { data, error } = await sb.from('friendships')
      .select('*')
      .eq('friend_id', cachedUser.id)
      .eq('status', 'pending');
    if (error || !data) return [];
    const senderIds = data.map(f => f.user_id);
    const { data: profiles } = await sb.from('public_profiles').select('*').in('id', senderIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });
    return data.map(f => ({ ...f, sender: profileMap[f.user_id] }));
  }

  async function sendFriendRequest(friendId) {
    if (!cachedUser) return { ok: false };
    if (friendId === cachedUser.id) return { ok: false, error: "Can't friend yourself" };
    // Check if reverse request exists
    const { data: existing } = await sb.from('friendships')
      .select('*')
      .eq('user_id', friendId)
      .eq('friend_id', cachedUser.id)
      .maybeSingle();
    if (existing) {
      if (existing.status === 'pending') {
        // Accept the reverse request
        await sb.from('friendships').update({ status: 'accepted' }).eq('id', existing.id);
        return { ok: true, autoAccepted: true };
      }
      return { ok: false, error: 'Already friends' };
    }
    const { error } = await sb.from('friendships').insert({ user_id: cachedUser.id, friend_id: friendId, status: 'pending' });
    if (error) return { ok: false, error: error.message };
    // Notify recipient
    await sb.from('notifications').insert({
      user_id: friendId,
      title: 'New Friend Request',
      message: (cachedProfile?.username || 'Someone') + ' sent you a friend request!',
      link: '/friends',
      type: 'friend_request',
      read: false
    });
    return { ok: true };
  }

  async function acceptFriendRequest(friendshipId) {
    const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId).eq('friend_id', cachedUser.id);
    return { ok: !error };
  }

  async function declineFriendRequest(friendshipId) {
    const { error } = await sb.from('friendships').delete().eq('id', friendshipId).eq('friend_id', cachedUser.id);
    return { ok: !error };
  }

  async function removeFriend(friendshipId) {
    const { error } = await sb.from('friendships').delete().eq('id', friendshipId);
    return { ok: !error };
  }

  // -------- MESSAGES --------
  async function sendMessage(receiverId, content) {
    if (!cachedUser) return { ok: false };
    const { error } = await sb.from('messages').insert({ sender_id: cachedUser.id, receiver_id: receiverId, content });
    return { ok: !error, error: error?.message };
  }

  async function getMessages(otherId, limit = 100) {
    if (!cachedUser) return [];
    const { data, error } = await sb.from('messages')
      .select('*')
      .or('and(sender_id.eq.' + cachedUser.id + ',receiver_id.eq.' + otherId + '),and(sender_id.eq.' + otherId + ',receiver_id.eq.' + cachedUser.id + ')')
      .order('created_at', { ascending: true })
      .limit(limit);
    return error ? [] : (data || []);
  }

  function formatUserId(n) { return String(n).padStart(3, '0'); }

  return {
    client: sb, refresh, onAuthChange, requireAuth, signUp, signIn, signInWithGoogle, signOut,
    checkUsernameAvailable, updateProfile, uploadAvatar, uploadBanner,
    fetchPublicProfile, fetchWatchlist, fetchNotifications, markNotificationRead, markAllNotificationsRead, createNotification,
    upsertWatchlistEntry, removeWatchlistEntry, recomputeStats,
    getFriends, getFriendRequests, sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend,
    sendMessage, getMessages,
    tierFromScore, formatUserId,
    get user() { return cachedUser; },
    get profile() { return cachedProfile; }
  };
})();

window.chAuth = chAuth;
