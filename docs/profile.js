// ============================================================
// Cloud Hub — profile.js
// ============================================================

const $ = (id) => document.getElementById(id);

function getUsernameFromUrl() {
  const parts = location.pathname.split('/');
  const last = parts[parts.length - 1] || parts[parts.length - 2];
  return last ? decodeURIComponent(last) : null;
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown';
  const d = new Date(isoString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Joined ${months[d.getMonth()]} ${d.getFullYear()}`;
}

async function initProfile() {
  const username = getUsernameFromUrl();

  if (!username || username === 'dashboard' || username === 'settings') {
    showNotFound();
    return;
  }

  const profile = await chAuth.fetchPublicProfile(username);
  if (!profile) {
    showNotFound();
    return;
  }

  document.title = `${profile.display_name || profile.username} — Cloud Hub`;
  const name = profile.display_name || profile.username || 'User';
  const initial = name.charAt(0).toUpperCase();
  
  $('profileDisplayName').textContent = name;
  $('profileUsername').textContent = '@' + profile.username;
  $('profileId').textContent = profile.user_id ? '#' + chAuth.formatUserId(profile.user_id) : '';
  
  const bioEl = $('profileBio');
  if (profile.bio) {
    bioEl.textContent = profile.bio;
  } else {
    bioEl.textContent = 'This user hasn\'t written a bio yet.';
    bioEl.style.fontStyle = 'italic';
    bioEl.style.color = 'var(--ch-fg-subtle)';
  }

  $('profileJoinDate').textContent = formatDate(profile.created_at);

  const avatarEl = $('profileAvatar');
  if (profile.avatar_url) {
    avatarEl.style.backgroundImage = `url('${profile.avatar_url}')`;
  } else {
    avatarEl.textContent = initial;
  }

  if (profile.avatar_url) {
    $('profileBg').style.backgroundImage = `url('${profile.avatar_url}')`;
  }

  // --- ADD FRIEND BUTTON LOGIC ---
  const actionsWrap = document.querySelector('.profile-actions');
  if (actionsWrap) {
    if (window.chAuth && chAuth.user && chAuth.user.id === profile.id) {
      actionsWrap.innerHTML = `<a href="/user/settings" class="ch-btn ch-btn--ghost" style="width:100%">Edit Profile</a>`;
    } else {
      actionsWrap.innerHTML = `<button type="button" class="ch-btn ch-btn--primary" style="width:100%" disabled>Add Friend (Coming Soon)</button>`;
    }
  }

  // 3. Fetch Stats
  let stats = null;
  const { data: statsData } = await chAuth.client
    .from('stats')
    .select('*')
    .eq('user_id', profile.id)
    .maybeSingle();
  
  stats = statsData;

  // Tier
  const score = stats ? stats.score : 0;
  const tier = chAuth.tierFromScore(score);
  $('profileTier').innerHTML = `<span class="profile-tier__badge">${chEscapeHtml(tier)}</span>`;

  // Render Stats Grid
  const statsGrid = $('profileStatsGrid');
  if (profile.hidden && stats) {
    statsGrid.innerHTML = `<div class="profile-wl-empty">This user has chosen to hide their stats.</div>`;
  } else if (stats) {
    const statBoxes = [
      { label: 'Completed', val: stats.finished || 0 },
      { label: 'Watching', val: stats.watching || 0 },
      { label: 'Planned', val: stats.watch_later || 0 },
      { label: 'Dropped', val: stats.dropped || 0 },
      { label: 'Rated', val: stats.rated || 0 },
      { label: 'Hours', val: stats.watch_hours || 0 }
    ];
    statsGrid.innerHTML = statBoxes.map(b => {
      if (b.val === 0) {
        return `<div class="profile-stat-box">
          <div class="profile-stat-box__val" style="color:var(--ch-fg-muted); font-size:14px; margin-top:5px;">Empty</div>
          <div class="profile-stat-box__label">${b.label}</div>
        </div>`;
      }
      return `<div class="profile-stat-box">
        <div class="profile-stat-box__val">${b.val}</div>
        <div class="profile-stat-box__label">${b.label}</div>
      </div>`;
    }).join('');
  } else {
    statsGrid.innerHTML = `<div class="profile-wl-empty">This user's statistics are empty.</div>`;
  }

  // 4. Fetch Watchlist
  const watchlist = await chAuth.fetchWatchlist(profile.id);
  const wlContainer = $('profileWatchlist');
  
  if (!watchlist || watchlist.length === 0) {
    wlContainer.innerHTML = `<div class="profile-wl-empty">This user's watchlist is empty.</div>`;
  } else {
    const groups = {
      watching: [],
      completed: [],
      plan: [],
      dropped: []
    };
    
    watchlist.forEach(item => {
      if (groups[item.status]) groups[item.status].push(item);
    });

    let html = '';
    
    const statusOrder = [
      { key: 'watching', label: 'Currently Watching' },
      { key: 'completed', label: 'Completed' },
      { key: 'plan', label: 'Plan to Watch' },
      { key: 'dropped', label: 'Dropped' }
    ];

    statusOrder.forEach(group => {
      const items = groups[group.key] || [];

      html += `<h3 class="profile-section__title" style="font-size:14px; margin: var(--s-4) 0 var(--s-3);">${group.label} <span style="color:var(--ch-fg-muted); font-size:12px; margin-left:8px;">(${items.length})</span></h3>`;
      
      if (items.length === 0) {
        html += `<div class="profile-wl-empty" style="margin-bottom: var(--s-4);">This user's ${group.label.toLowerCase()} list is empty.</div>`;
      } else {
        html += `<div class="profile-wl-grid">`;
        items.forEach(item => {
          const img = item.image || '';
          const title = item.title || `AniList ${item.anilist_id}`;
          html += `
            <a href="/preview?id=${item.anilist_id}" class="profile-wl-card">
              <div class="profile-wl-card__thumb">
                ${img ? `<img src="${chEscapeHtml(img)}" alt="" loading="lazy">` : ''}
              </div>
              <div class="profile-wl-card__title">${chEscapeHtml(title)}</div>
            </a>
          `;
        });
        html += `</div>`;
      }
    });

    wlContainer.innerHTML = html;
  }

  // 5. Reveal Page
  $('profileLoading').hidden = true;
  $('profileMain').hidden = false;
  
  if (typeof chPageReady === 'function') chPageReady();
}

function showNotFound() {
  $('profileLoading').hidden = true;
  $('profileNotFound').hidden = false;
  if (typeof chPageReady === 'function') chPageReady();
}

document.addEventListener('DOMContentLoaded', initProfile);
