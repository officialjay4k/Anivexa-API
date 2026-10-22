const $ = (id) => document.getElementById(id);
let currentUser = null;

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

$('sendBroadcastBtn').addEventListener('click', async () => {
  const title = $('notifTitle').value.trim();
  const message = $('notifMessage').value.trim();
  const image = $('notifImage').value.trim() || null;
  const link = $('notifLink').value.trim() || null;
  if (!title || !message) { showToast('Title and Message required'); return; }
  const btn = $('sendBroadcastBtn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const { error } = await chAuth.client.rpc('broadcast_notification', { notif_title: title, notif_message: message, notif_image: image, notif_link: link });
    if (error) throw error;
    showToast('Sent!');
    $('notifTitle').value = ''; $('notifMessage').value = ''; $('notifImage').value = ''; $('notifLink').value = '';
  } catch (err) { showToast('Failed: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'Send to All Users'; }
});

async function loadReports() {
  const tbody = $('reportsTable').querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>';
  const { data, error } = await chAuth.client.from('reports').select('*').order('created_at', { ascending: false });
  if (error || !data?.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No reports.</td></tr>'; return; }
  tbody.innerHTML = data.map(r => `<tr><td><span class="status-badge ${r.status}">${r.status}</span></td><td>${chEscapeHtml(r.category)}</td><td>${r.username ? '@' + chEscapeHtml(r.username) : 'Guest'}</td><td style="max-width:300px;">${chEscapeHtml(r.message)}</td><td style="font-size:11px;color:var(--ch-fg-muted);">${chEscapeHtml(r.context || '')}</td><td>${r.status === 'open' ? `<button class="admin-act-btn" onclick="resolveReport('${r.id}')">Resolve</button>` : ''}</td></tr>`).join('');
}

window.resolveReport = async (id) => {
  await chAuth.client.from('reports').update({ status: 'resolved' }).eq('id', id);
  loadReports();
};

function getLastSeen(ts) {
  if (!ts) return 'Never';
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 120) return '🟢 Online';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

async function loadUsers() {
  const tbody = $('usersTable').querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading...</td></tr>';
  const { data, error } = await chAuth.client.from('profiles').select('*').order('last_seen', { ascending: false, nullsFirst: false });
  if (error || !data?.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No users.</td></tr>'; return; }
  tbody.innerHTML = data.map(u => {
    const initial = (u.username || 'U').charAt(0).toUpperCase();
    const avatar = u.avatar_url ? `<img src="${chEscapeHtml(u.avatar_url)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">` : `<div style="width:28px;height:28px;border-radius:50%;background:var(--ch-bg-3);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;">${initial}</div>`;
    const statusClass = u.status === 'banned' ? 'banned' : u.status === 'suspended' ? 'suspended' : 'active';
    const flagIcon = u.flag_reason ? ' 🚩' : '';
    return `<tr>
      <td style="display:flex;align-items:center;gap:8px;">${avatar}<div><div style="font-weight:700;">${chEscapeHtml(u.display_name || u.username)}${flagIcon}</div><div style="font-size:11px;color:var(--ch-fg-muted);">@${chEscapeHtml(u.username)} ${u.is_admin ? '· <span style="color:var(--ch-red-bright);">ADMIN</span>' : ''}</div></div></td>
      <td style="font-size:12px;">${getLastSeen(u.last_seen)}</td>
      <td><span class="status-badge ${statusClass}">${u.status || 'active'}</span></td>
      <td><input type="number" class="admin-points-input" data-pts="${u.id}" value="${u.points || 0}"></td>
      <td>
        <button class="admin-act-btn" onclick="setStatus('${u.id}','active')">Activate</button>
        <button class="admin-act-btn" onclick="setStatus('${u.id}','suspended')">Suspend</button>
        <button class="admin-act-btn" onclick="setStatus('${u.id}','banned')">Ban</button>
        <button class="admin-act-btn" onclick="flagUser('${u.id}')">Flag</button>
        <button class="admin-act-btn" onclick="savePoints('${u.id}', this)">Save Pts</button>
      </td>
    </tr>`;
  }).join('');
}

window.setStatus = async (id, status) => {
  try {
    const { error } = await chAuth.client.rpc('admin_set_status', { target_id: id, new_status: status });
    if (error) throw error;
    showToast('Status set to ' + status);
    loadUsers();
  } catch (err) { showToast(err.message); }
};

window.flagUser = async (id) => {
  const reason = prompt('Flag reason?');
  if (!reason) return;
  try {
    const { error } = await chAuth.client.rpc('admin_flag_user', { target_id: id, reason });
    if (error) throw error;
    showToast('User flagged');
    loadUsers();
  } catch (err) { showToast(err.message); }
};

window.savePoints = async (id, btn) => {
  const input = btn.closest('tr').querySelector(`input[data-pts="${id}"]`);
  const val = parseInt(input.value, 10);
  if (isNaN(val)) return;
  try {
    const { error } = await chAuth.client.rpc('admin_set_points', { target_id: id, new_pts: val });
    if (error) throw error;
    showToast('Points saved');
  } catch (err) { showToast(err.message); }
};

(async function init() {
  const session = await chAuth.requireAuth('/admin');
  if (!session) return;
  currentUser = session.user;
  if (!session.profile || !session.profile.is_admin) {
    document.querySelector('.admin-content').innerHTML = '<div style="text-align:center;padding:100px 20px;"><h1 style="color:#ff5d6b;font-size:32px;">Access Denied</h1><a href="/home" class="ch-btn ch-btn--primary" style="margin-top:20px;">Return Home</a></div>';
    if (typeof chPageReady === 'function') chPageReady();
    return;
  }
  loadReports();
  if (typeof chPageReady === 'function') chPageReady();
})();
