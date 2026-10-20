// ============================================================
// Cloud Hub — admin.js
// ============================================================

const $ = (id) => document.getElementById(id);

let currentUser = null;

// Tab switching
document.querySelectorAll('.admin-nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('is-active'));
    
    btn.classList.add('is-active');
    $('panel-' + btn.dataset.tab).classList.add('is-active');

    if (btn.dataset.tab === 'reports') loadReports();
    if (btn.dataset.tab === 'users') loadUsers();
  });
});

// Broadcast logic
$('sendBroadcastBtn').addEventListener('click', async () => {
  const title = $('notifTitle').value.trim();
  const message = $('notifMessage').value.trim();
  const image = $('notifImage').value.trim() || null;
  const link = $('notifLink').value.trim() || null;

  if (!title || !message) {
    if (typeof showToast === 'function') showToast('Title and Message are required.');
    return;
  }

  const btn = $('sendBroadcastBtn');
  btn.disabled = true;
  btn.textContent = 'Sending to all users...';

  try {
    const { error } = await chAuth.client.rpc('broadcast_notification', {
      notif_title: title,
      notif_message: message,
      notif_image: image,
      notif_link: link
    });

    if (error) throw error;

    if (typeof showToast === 'function') showToast('Broadcast sent successfully!');
    $('notifTitle').value = '';
    $('notifMessage').value = '';
    $('notifImage').value = '';
    $('notifLink').value = '';
  } catch (err) {
    console.error(err);
    if (typeof showToast === 'function') showToast('Failed to send broadcast: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send to All Users';
  }
});

// Fetch Reports
async function loadReports() {
  const tbody = $('reportsTable').querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading reports...</td></tr>';

  try {
    const { data, error } = await chAuth.client
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No reports found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(r => `
      <tr>
        <td><span class="status-badge ${r.status}">${r.status}</span></td>
        <td>${chEscapeHtml(r.category)}</td>
        <td>${r.username ? '@' + chEscapeHtml(r.username) : 'Guest'}</td>
        <td style="max-width: 300px;">${chEscapeHtml(r.message)}</td>
        <td style="max-width: 200px; font-size: 11px; color: var(--ch-fg-muted);">${chEscapeHtml(r.context || '')}</td>
        <td>
          ${r.status === 'open' ? `<button class="btn-sm" onclick="resolveReport('${r.id}')">Resolve</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: #ff5d6b;">Error loading reports: ${err.message}</td></tr>`;
  }
}

window.resolveReport = async (id) => {
  try {
    await chAuth.client.from('reports').update({ status: 'resolved' }).eq('id', id);
    loadReports();
  } catch (err) {
    alert('Failed to resolve report.');
  }
};

// Fetch Users
async function loadUsers() {
  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading users...</td></tr>';

  try {
    const { data, error } = await chAuth.client
      .from('profiles')
      .select('id, username, display_name, avatar_url, is_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(u => {
      const initial = (u.username || 'U').charAt(0).toUpperCase();
      const avatar = u.avatar_url 
        ? `<img src="${chEscapeHtml(u.avatar_url)}" style="width:24px; height:24px; border-radius:50%; object-fit:cover;">` 
        : `<div style="width:24px; height:24px; border-radius:50%; background:var(--ch-bg-3); display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold;">${initial}</div>`;
      
      const date = new Date(u.created_at).toLocaleDateString();

      return `
        <tr>
          <td style="display:flex; align-items:center; gap:8px;">
            ${avatar}
            ${chEscapeHtml(u.display_name || u.username)}
          </td>
          <td>@${chEscapeHtml(u.username)}</td>
          <td>${u.is_admin ? '<span style="color:var(--ch-red-bright); font-weight:bold;">Admin</span>' : 'User'}</td>
          <td>${date}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: #ff5d6b;">Error loading users: ${err.message}</td></tr>`;
  }
}

// Boot
(async function init() {
  const session = await chAuth.requireAuth('/admin');
  if (!session) return;

  currentUser = session.user;
  const profile = session.profile;

  // Verify Admin status
  if (!profile || !profile.is_admin) {
    document.querySelector('.admin-content').innerHTML = `
      <div style="text-align:center; padding: 100px 20px;">
        <h1 style="color: #ff5d6b; font-size: 32px; margin-bottom: 16px;">Access Denied</h1>
        <p style="color: var(--ch-fg-muted); margin-bottom: 24px;">You do not have administrator privileges to view this page.</p>
        <a href="/home" class="ch-btn ch-btn--primary">Return Home</a>
      </div>
    `;
    if (typeof chPageReady === 'function') chPageReady();
    return;
  }

  loadReports();

  if (typeof chPageReady === 'function') chPageReady();
})();
