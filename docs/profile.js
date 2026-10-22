const $ = (id) => document.getElementById(id);
let allWatchlist = [];

function getUsernameFromUrl() {
  const parts = location.pathname.split('/');
  const last = parts[parts.length - 1] || parts[parts.length - 2];
  return last ? decodeURIComponent(last) : null;
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown';
  const d = new Date(isoString);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Joined ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function getLastSeenText(lastSeenStr) {
  if (!lastSeenStr) return 'Last online: never';
  const diff = Math.floor((Date.now() - new Date(lastSeenStr).getTime()) / 1000);
  if (diff < 120) return '🟢 Online now';
  if (diff < 3600) return `Last online: ${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `Last online: ${Math.floor(diff/3600)}h ago`;
  if (diff < 86400*30) return `Last online: ${Math.floor(diff/86400)}d ago`;
  return `Last online: ${new Date(lastSeenStr).toLocaleDateString()}`;
}

function updateRankProgress(score) {
  const tiers = [
    { name: 'Chunin', min: 0 }, { name: 'Jonin', min: 75 }, { name: 'Elite', min: 250 },
    { name: 'Anbu Black Ops', min: 750 }, { name: 'Hokage', min: 2000 }, { name: 'Akatsuki', min: 5000 }
  ];
  let currentTier = tiers[0], nextTier = tiers[1];
  for (let i = 0; i < tiers.length; i++) {
    if (score >= tiers[i].min) { currentTier = tiers[i]; nextTier = tiers[i+1] || null; }
  }
  const fill = $('rankFill'), text = $('rankText');
  if (!nextTier) { fill.style.width = '100%'; text.textContent = 'MAX RANK'; return; }
  const range = nextTier.min - currentTier.min;
  const progress = score - currentTier.min;
  fill.style.width = `${Math.min(100, Math.max(0, (progress / range) * 100))}%`;
  text.textContent = `${score} / ${nextTier.min}`;
}

function renderCharts(stats) {
  const w = stats?.watching || 0, c = stats?.finished || 0, p = stats?.watch_later || 0, d = stats?.dropped || 0;
  const total = w + c + p + d;
  const pie = $('profilePie');
  if (total === 0) { pie.style.background = 'var(--ch-bg-3)'; }
  else {
    const wp = (w/total)*100, cp = (c/total)*100, pp = (p/total)*100;
    pie.style.background = `conic-gradient(var(--ch-red-bright) 0% ${wp}%, var(--ch-green) ${wp}% ${wp+cp}%, var(--ch-blue) ${wp+cp}% ${wp+cp+pp}%, var(--ch-fg-muted) ${wp+cp+pp}% 100%)`;
  }
  const podium = $('profilePodium');
  const items = [{label:'Watching',val:w,color:'var(--ch-red)'},{label:'Completed',val:c,color:'var(--ch-green)'},{label:'Planned',val:p,color:'var(--ch-blue)'}].sort((a,b)=>b.val-a.val);
  const maxVal = Math.max(1, items[0].val);
  podium.innerHTML = items.map(item => {
    const height = (item.val/maxVal)*80 + 10;
    return `<div class="podium-bar" style="height:${height}px;background:linear-gradient(180deg,${item.color},var(--ch-bg-2));"><div class="podium-bar__val">${item.val}</div><div class="podium-bar__label">${item.label}</div></div>`;
  }).join('');
  const rate = total > 0 ? Math.round((c/total)*100) : 0;
  const circumference = 2 * Math.PI * 40;
  $('profileRingFill').style.strokeDashoffset = circumference - (rate/100)*circumference;
  $('profileRingText').textContent = `${rate}%`;
}

function renderWatchlist() {
  const wlContainer = $('profileWatchlist');
  if (!allWatchlist.length) { wlContainer.innerHTML = `<div class="profile-wl-empty">Empty.</div>`; return; }
  const groups = { watching: [], completed: [], plan: [], dropped: [] };
  allWatchlist.forEach(i => { if (groups[i.status]) groups[i.status].push(i); });
  let html = '';
  const order = [ {key:'watching',label:'Currently Watching'},{key:'completed',label:'Completed'},{key:'plan',label:'Plan to Watch'},{key:'dropped',label:'Dropped'} ];
  order.forEach(g => {
    const items = groups[g.key];
    html += `<h3 class="profile-section__title" style="font-size:14px;margin:var(--s-4) 0 var(--s-3);">${g.label} <span style="color:var(--ch-fg-muted);font-size:12px;margin-left:8px;">(${items.length})</span></h3>`;
    if (!items.length) { html += `<div class="profile-wl-empty" style="margin-bottom:var(--s-4);">Empty.</div>`; return; }
    html += `<div class="profile-wl-grid" data-status="${g.key}">`;
    items.forEach((item, idx) => {
      const hidden = idx >= 6 ? 'style="display:none;"' : '';
      html += `<a href="/preview?id=${item.anilist_id}" class="profile-wl-card" ${hidden}><div class="profile-wl-card__thumb">${item.image ? `<img src="${chEscapeHtml(item.image)}" loading="lazy">` : ''}</div><div class="profile-wl-card__title">${chEscapeHtml(item.title)}</div></a>`;
    });
    html += `</div>`;
    if (items.length > 6) {
      html += `<div style="text-align:center;margin:12px 0 24px;"><button class="ch-btn ch-btn--quiet ch-btn--sm" data-showall="${g.key}">Show All ${items.length} Anime</button></div>`;
    }
  });
  wlContainer.innerHTML = html;
  wlContainer.querySelectorAll('[data-showall]').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.showall;
      wlContainer.querySelectorAll(`[data-status="${status}"] .profile-wl-card`).forEach(card => card.style.display = '');
      btn.parentElement.remove();
    });
  });
}

async function initProfile() {
  const username = getUsernameFromUrl();
  if (!username || username === 'dashboard' || username === 'settings') { showNotFound(); return; }
  const profile = await chAuth.fetchPublicProfile(username);
  if (!profile) { showNotFound(); return; }
  document.title = `${profile.display_name || profile.username} — Cloud Hub`;
  const name = profile.display_name || profile.username || 'User';
  const initial = name.charAt(0).toUpperCase();
  $('profileDisplayName').textContent = name;
  $('profileUsername').textContent = '@' + profile.username;
  $('profileId').textContent = profile.user_id ? '#' + chAuth.formatUserId(profile.user_id) : '';
  $('profileBio').textContent = profile.bio || "This user hasn't written a bio yet.";
  if (!profile.bio) { $('profileBio').style.fontStyle = 'italic'; $('profileBio').style.color = 'var(--ch-fg-subtle)'; }
  $('profileJoinDate').textContent = formatDate(profile.created_at);
  $('profileLastSeen').textContent = getLastSeenText(profile.last_seen);
  $('profilePoints').textContent = '✨ ' + (profile.points || 0) + ' Points';
  const avatarEl = $('profileAvatar');
  if (profile.avatar_url) avatarEl.style.backgroundImage = `url('${profile.avatar_url}')`;
  else avatarEl.textContent = initial;
  if (profile.banner_url) $('profileBg').style.backgroundImage = `url('${profile.banner_url}')`;
  else if (profile.avatar_url) $('profileBg').style.backgroundImage = `url('${profile.avatar_url}')`;

  // Friend Button
  const actionsWrap = $('profileActions');
  const me = window.chAuth?.user;
  const myProfile = window.chAuth?.profile;
  if (me && me.id === profile.id) {
    actionsWrap.innerHTML = `<a href="/user/settings" class="ch-btn ch-btn--ghost" style="width:100%">Edit Profile</a>`;
  } else if (me) {
    // Check friendship status
    const { data: friendRow } = await chAuth.client.from('friendships').select('*').or(`and(user_id.eq.${me.id},friend_id.eq.${profile.id}),and(user_id.eq.${profile.id},friend_id.eq.${me.id})`).maybeSingle();
    if (friendRow && friendRow.status === 'accepted') {
      actionsWrap.innerHTML = `<a href="/friends" class="ch-btn ch-btn--primary" style="width:100%">Message</a>`;
    } else if (friendRow && friendRow.status === 'pending') {
      if (friendRow.user_id === me.id) {
        actionsWrap.innerHTML = `<button class="ch-btn ch-btn--ghost" style="width:100%" disabled>Request Pending</button>`;
      } else {
        actionsWrap.innerHTML = `<div style="display:flex;gap:8px;width:100%;"><button class="ch-btn ch-btn--primary" id="accFriend" style="flex:1;">Accept</button><button class="ch-btn ch-btn--quiet" id="decFriend" style="flex:1;">Decline</button></div>`;
        $('accFriend').onclick = async () => { await chAuth.acceptFriendRequest(friendRow.id); location.reload(); };
        $('decFriend').onclick = async () => { await chAuth.declineFriendRequest(friendRow.id); location.reload(); };
      }
    } else {
      actionsWrap.innerHTML = `<button class="ch-btn ch-btn--primary" id="addFriendBtn" style="width:100%">+ Add Friend</button>`;
      $('addFriendBtn').onclick = async () => {
        const r = await chAuth.sendFriendRequest(profile.id);
        if (r.ok) { showToast(r.autoAccepted ? 'You are now friends!' : 'Friend request sent!'); location.reload(); }
        else showToast(r.error || 'Failed');
      };
    }
  } else {
    actionsWrap.innerHTML = `<a href="/auth/login" class="ch-btn ch-btn--ghost" style="width:100%">Sign in to add friend</a>`;
  }

  // Fetch Stats
  const { data: statsData } = await chAuth.client.from('stats').select('*').eq('user_id', profile.id).maybeSingle();
  const stats = statsData;
  const score = stats ? stats.score : 0;
  const tier = chAuth.tierFromScore(score);
  $('profileTier').innerHTML = `<span class="profile-tier__badge">${chEscapeHtml(tier)}</span>`;
  updateRankProgress(score);

  if (profile.hidden && stats) {
    $('profileStatsSection').innerHTML = `<header class="profile-section__head"><h2 class="profile-section__title">Statistics</h2></header><div class="profile-wl-empty">This user has chosen to hide their stats.</div>`;
  } else if (stats) {
    renderCharts(stats);
  } else {
    $('profileStatsSection').innerHTML = `<header class="profile-section__head"><h2 class="profile-section__title">Statistics</h2></header><div class="profile-wl-empty">No stats yet.</div>`;
  }

  // Fetch Watchlist
  allWatchlist = await chAuth.fetchWatchlist(profile.id);
  const continueSection = $('profileContinueSection'), continueRow = $('profileContinueRow');
  const recent = allWatchlist.filter(w => w.status === 'watching' && Number(w.progress_time) > 0 && Number(w.progress_ep) > 0).sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 10);
  if (recent.length) {
    continueSection.hidden = false;
    continueRow.innerHTML = recent.map(item => {
      const pct = Number(item.duration) > 0 ? Math.min(100, (Number(item.progress_time)/Number(item.duration))*100) : 0;
      return `<a href="/watch?id=${item.anilist_id}&ep=${item.progress_ep}&lang=dub" class="profile-continue-card"><div class="profile-continue-card__thumb">${item.image ? `<img src="${chEscapeHtml(item.image)}">` : ''}<div class="profile-continue-card__progress"><div class="profile-continue-card__progress-fill" style="width:${pct.toFixed(1)}%"></div></div></div><div class="profile-continue-card__title">${chEscapeHtml(item.title)}</div><div class="profile-continue-card__meta">EP ${item.progress_ep} · ${chFormatTime(item.progress_time)} / ${chFormatTime(item.duration)}</div></a>`;
    }).join('');
  } else { continueSection.hidden = true; }

  renderWatchlist();
  $('profileLoading').hidden = true;
  $('profileMain').hidden = false;
  if (typeof chPageReady === 'function') chPageReady();
}

function showNotFound() { $('profileLoading').hidden = true; $('profileNotFound').hidden = false; if (typeof chPageReady === 'function') chPageReady(); }
document.addEventListener('DOMContentLoaded', initProfile);
