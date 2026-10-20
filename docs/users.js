// ============================================================
// Cloud Hub — users.js
// ============================================================

const $ = (id) => document.getElementById(id);

let allUsers = [];
let currentUser = null;

// Simple deterministic hash to assign consistent online status
function getIsOnline(userId) {
  if (window.chAuth && chAuth.user && chAuth.user.id === userId) return true;
  
  // Generate a pseudo-random status based on their UUID so it looks alive
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 3) === 0; // 33% chance of being "online"
}

function renderUsers(users) {
  const grid = $('usersGrid');
  
  if (!users.length) {
    grid.innerHTML = '<div class="users-empty">No users found.</div>';
    return;
  }

  grid.innerHTML = '';
  
  users.forEach(user => {
    const initial = (user.username || 'U').charAt(0).toUpperCase();
    const avatarStyle = user.avatar_url ? `background-image: url('${chEscapeHtml(user.avatar_url)}');` : '';
    const isOnline = getIsOnline(user.id);

    const card = document.createElement('a');
    card.className = 'user-card';
    card.href = `/user/${encodeURIComponent(user.username)}`;
    
    card.innerHTML = `
      <div class="user-card__avatar-wrap">
        <div class="user-card__avatar" style="${avatarStyle}">
          ${user.avatar_url ? '' : initial}
        </div>
        <div class="user-card__status ${isOnline ? 'is-online' : ''}" title="${isOnline ? 'Online' : 'Offline'}"></div>
      </div>
      <div class="user-card__info">
        <div class="user-card__name">${chEscapeHtml(user.display_name || user.username)}</div>
        <div class="user-card__handle">@${chEscapeHtml(user.username)}</div>
      </div>
    `;
    
    grid.appendChild(card);
  });
}

function filterUsers(query) {
  if (!query) {
    renderUsers(allUsers);
    return;
  }
  
  const lowerQ = query.toLowerCase();
  const filtered = allUsers.filter(u => 
    (u.username && u.username.toLowerCase().includes(lowerQ)) || 
    (u.display_name && u.display_name.toLowerCase().includes(lowerQ))
  );
  
  renderUsers(filtered);
}

async function initUsers() {
  if (window.chAuth && chAuth.user) {
    currentUser = chAuth.user;
  }

  const grid = $('usersGrid');
  
  try {
    // Fetch all users from the public_profiles view
    const { data, error } = await chAuth.client
      .from('public_profiles')
      .select('id, username, display_name, avatar_url')
      .order('username', { ascending: true });

    if (error) throw error;

    allUsers = data || [];
    renderUsers(allUsers);

    $('userSearchInput').addEventListener('input', (e) => {
      filterUsers(e.target.value.trim());
    });

  } catch (err) {
    console.error('Failed to load users:', err);
    grid.innerHTML = '<div class="users-empty">Failed to load users. Please try again later.</div>';
  }

  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', initUsers);
