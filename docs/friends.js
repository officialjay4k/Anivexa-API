const $ = (id) => document.getElementById(id);
let currentFriend = null;
let pollTimer = null;

function renderFriendsList(friends) {
  const el = $('friendsList');
  if (!friends.length) { el.innerHTML = '<div class="friends-empty">No friends yet.</div>'; return; }
  el.innerHTML = '';
  friends.forEach(f => {
    const p = f.friend;
    if (!p) return;
    const isOnline = p.last_seen ? (Date.now() - new Date(p.last_seen).getTime()) < 120000 : false;
    const initial = (p.username || 'U').charAt(0).toUpperCase();
    const avatarStyle = p.avatar_url ? `background-image:url('${chEscapeHtml(p.avatar_url)}');` : '';
    const item = document.createElement('div');
    item.className = 'friend-item';
    item.dataset.id = p.id;
    item.dataset.friendshipId = f.id;
    item.dataset.username = p.username;
    item.innerHTML = `<div class="friend-item__avatar" style="${avatarStyle}">${p.avatar_url ? '' : initial}</div><div style="min-width:0;flex:1;"><div class="friend-item__name">${chEscapeHtml(p.display_name || p.username)}</div><div class="friend-item__status">${isOnline ? '🟢 Online' : 'Offline'}</div></div>`;
    item.addEventListener('click', () => openChat(p, f.id));
    el.appendChild(item);
  });
}

async function renderRequests() {
  const requests = await chAuth.getFriendRequests();
  const section = $('friendRequestsSection');
  const list = $('friendRequestsList');
  if (!requests.length) { section.hidden = true; return; }
  section.hidden = false;
  list.innerHTML = requests.map(r => {
    const s = r.sender || {};
    return `<div class="friend-request"><div class="friend-request__name">${chEscapeHtml(s.display_name || s.username || 'Unknown')}</div><div class="friend-request__actions"><button class="friend-request__accept" data-accept="${r.id}">Accept</button><button class="friend-request__decline" data-decline="${r.id}">Decline</button></div></div>`;
  }).join('');
  list.querySelectorAll('[data-accept]').forEach(btn => btn.onclick = async () => { await chAuth.acceptFriendRequest(btn.dataset.accept); init(); });
  list.querySelectorAll('[data-decline]').forEach(btn => btn.onclick = async () => { await chAuth.declineFriendRequest(btn.dataset.decline); init(); });
}

async function openChat(profile, friendshipId) {
  currentFriend = profile;
  document.querySelectorAll('.friend-item').forEach(el => el.classList.toggle('is-active', el.dataset.id === profile.id));
  $('chatHeader').innerHTML = `<div class="friends-chat__name">${chEscapeHtml(profile.display_name || profile.username)}</div>`;
  $('chatInputWrap').style.display = 'flex';
  await loadMessages();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMessages, 3000);
  setTimeout(() => $('chatInput').focus(), 100);
}

async function loadMessages() {
  if (!currentFriend) return;
  const msgs = await chAuth.getMessages(currentFriend.id);
  const box = $('chatMessages');
  box.innerHTML = msgs.map(m => {
    const isMe = m.sender_id === chAuth.user.id;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="msg msg--${isMe ? 'me' : 'them'}">${chEscapeHtml(m.content)}<span class="msg__time">${time}</span></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function sendMsg() {
  if (!currentFriend) return;
  const input = $('chatInput');
  const txt = input.value.trim();
  if (!txt) return;
  input.value = '';
  await chAuth.sendMessage(currentFriend.id, txt);
  await loadMessages();
}

async function init() {
  const session = await chAuth.requireAuth('/friends');
  if (!session) return;
  await renderRequests();
  const friends = await chAuth.getFriends();
  renderFriendsList(friends);
  $('chatSendBtn').addEventListener('click', sendMsg);
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMsg(); } });
  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', init);
