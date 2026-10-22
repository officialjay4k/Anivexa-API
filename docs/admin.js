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
  tbody.innerHTML = data.map(r => `<tr><td><span
