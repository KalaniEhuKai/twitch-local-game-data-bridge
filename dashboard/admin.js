/**
 * =============================================================================
 * Twitch Local Game Data Bridge — Admin Portal Controller
 * =============================================================================
 */

const CONFIG = window.TLGDB_CONFIG || {};
const WORKER_URL = (CONFIG.workerUrl || '').replace(/\/$/, '');

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

const state = {
  adminSecret: localStorage.getItem('tlgdb:admin_secret') || '',
  selectedDate: getTodayString(),
  refreshTimer: null,
  streamers: [],
  globalStats: null,
};

const $ = (id) => document.getElementById(id);

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function initAdmin() {
  $('logout-admin-btn')?.addEventListener('click', logoutAdmin);
  $('refresh-btn')?.addEventListener('click', fetchAdminData);
  $('auto-refresh-check')?.addEventListener('change', toggleAutoRefresh);

  $('date-quick-select')?.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    if ($('date-custom-input')) $('date-custom-input').value = e.target.value;
    fetchAdminData();
  });

  $('date-custom-input')?.addEventListener('change', (e) => {
    if (e.target.value) {
      state.selectedDate = e.target.value;
      populateDateSelector();
      fetchAdminData();
    }
  });

  populateDateSelector();

  if (state.adminSecret) {
    authenticateAdmin(state.adminSecret);
  } else {
    showAuthView();
  }
}

function populateDateSelector() {
  const quickSelect = $('date-quick-select');
  const customInput = $('date-custom-input');
  if (!quickSelect) return;

  quickSelect.innerHTML = '';
  const todayObj = new Date();

  for (let i = 0; i < 14; i++) {
    const d = new Date(todayObj);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const opt = document.createElement('option');
    opt.value = dateStr;

    let label = dateStr;
    if (i === 0) label = `Today (${dateStr})`;
    else if (i === 1) label = `Yesterday (${dateStr})`;
    else label = `${i} Days Ago (${dateStr})`;

    opt.textContent = label;
    if (dateStr === state.selectedDate) opt.selected = true;
    quickSelect.appendChild(opt);
  }

  if (customInput) {
    customInput.value = state.selectedDate;
  }
}

function showAuthView() {
  $('admin-auth-card').hidden = false;
  $('admin-dashboard-view').hidden = true;
  $('logout-admin-btn').hidden = true;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
}

function showDashboardView() {
  $('admin-auth-card').hidden = true;
  $('admin-dashboard-view').hidden = false;
  $('logout-admin-btn').hidden = false;
  toggleAutoRefresh();
}

async function authenticateAdmin(keyToTest) {
  const secret = keyToTest || $('admin-secret-input')?.value?.trim();
  const authErr = $('auth-error');
  if (authErr) authErr.hidden = true;

  if (!secret) return;

  try {
    const res = await fetch(`${WORKER_URL}/admin/stats?date=${encodeURIComponent(state.selectedDate)}`, {
      headers: { 'Authorization': `Bearer ${secret}` },
    });

    if (res.status === 401) {
      if (authErr) {
        authErr.textContent = 'Invalid Admin Secret Key. Access denied.';
        authErr.hidden = false;
      }
      localStorage.removeItem('tlgdb:admin_secret');
      state.adminSecret = '';
      showAuthView();
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    state.adminSecret = secret;
    localStorage.setItem('tlgdb:admin_secret', secret);
    showDashboardView();
    fetchAdminData();
  } catch (err) {
    if (authErr) {
      authErr.textContent = `Could not connect to Worker: ${err.message}`;
      authErr.hidden = false;
    }
  }
}

function logoutAdmin() {
  localStorage.removeItem('tlgdb:admin_secret');
  state.adminSecret = '';
  showAuthView();
}

function toggleAutoRefresh() {
  const check = $('auto-refresh-check');
  if (state.refreshTimer) clearInterval(state.refreshTimer);

  if (check?.checked && state.adminSecret) {
    state.refreshTimer = setInterval(fetchAdminData, 10000);
  }
}

async function fetchAdminData() {
  if (!state.adminSecret) return;

  const dashErr = $('dashboard-error');
  if (dashErr) dashErr.hidden = true;

  try {
    const [statsRes, streamersRes] = await Promise.all([
      fetch(`${WORKER_URL}/admin/stats?date=${encodeURIComponent(state.selectedDate)}`, {
        headers: { 'Authorization': `Bearer ${state.adminSecret}` },
      }),
      fetch(`${WORKER_URL}/admin/streamers?date=${encodeURIComponent(state.selectedDate)}`, {
        headers: { 'Authorization': `Bearer ${state.adminSecret}` },
      }),
    ]);

    if (!statsRes.ok || !streamersRes.ok) {
      throw new Error('Failed to fetch admin stats');
    }

    const globalStats = await statsRes.json();
    const streamers = await streamersRes.json();

    state.globalStats = globalStats;
    state.streamers = streamers;

    renderAdminDashboard();
  } catch (err) {
    if (dashErr) {
      dashErr.textContent = `Error refreshing admin data: ${err.message}`;
      dashErr.hidden = false;
    }
  }
}

function renderAdminDashboard() {
  const g = state.globalStats || { uploads: 0, bytesIn: 0, gets: 0, bytesOut: 0, streamers: [] };
  const sList = state.streamers || [];

  const isToday = state.selectedDate === getTodayString();
  const dateTitle = isToday ? 'Today' : state.selectedDate;

  setText('lbl-uploads', isToday ? "Today's Total Uploads" : `Uploads (${dateTitle})`);
  setText('lbl-gets', isToday ? "Today's Extension GETs" : `GETs (${dateTitle})`);
  setText('lbl-bytes', isToday ? "Today's Data Transferred" : `Data Transferred (${dateTitle})`);
  setText('lbl-streamers', isToday ? "Active Streamers Today" : `Active Streamers (${dateTitle})`);
  setText('th-uploads', isToday ? "Today's Uploads" : `Uploads (${dateTitle})`);
  setText('th-gets', isToday ? "Today's GETs" : `GETs (${dateTitle})`);
  setText('th-bytes', isToday ? "Today's Data" : `Data (${dateTitle})`);

  if ($('stat-today-uploads')) $('stat-today-uploads').textContent = (g.uploads || 0).toLocaleString();
  if ($('stat-today-gets')) $('stat-today-gets').textContent = (g.gets || 0).toLocaleString();
  if ($('stat-today-bytes')) $('stat-today-bytes').textContent = formatBytes(g.bytesIn || 0);
  if ($('stat-active-streamers')) $('stat-active-streamers').textContent = (g.streamers ? g.streamers.length : 0).toLocaleString();
  if ($('stat-total-streamers')) $('stat-total-streamers').textContent = sList.length.toLocaleString();

  const tbody = $('streamers-tbody');
  if (!tbody) return;

  if (sList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-dim); padding: 2rem;">
          No streamers or channels registered yet.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = sList.map(ch => {
    const isBlocked = ch.blocked;
    const todayUploads = ch.todayStats?.uploads || 0;
    const todayGets = ch.todayStats?.gets || 0;
    const todayBytes = ch.todayStats?.bytesIn || 0;
    const regDate = ch.registeredAt ? new Date(ch.registeredAt).toLocaleDateString() : 'Unknown';

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #fff;">@${escapeHtml(ch.twitchLogin || 'unknown')}</div>
        </td>
        <td style="font-family: monospace; color: var(--text-dim); font-size: 0.85rem;">
          ${ch.channelId || ch.twitchUserId || '—'}
        </td>
        <td style="color: var(--text-dim); font-size: 0.85rem;">${regDate}</td>
        <td style="font-family: monospace; font-weight: 600;">${todayUploads.toLocaleString()}</td>
        <td style="font-family: monospace; font-weight: 600; color: #38bdf8;">${todayGets.toLocaleString()}</td>
        <td style="font-family: monospace; color: var(--text-dim); font-size: 0.85rem;">${formatBytes(todayBytes)}</td>
        <td>
          ${isBlocked ? `
            <span class="badge-status badge-blocked" title="${escapeHtml(ch.blockInfo?.reason || 'Blocked')}">
              🚫 Blocked
            </span>
          ` : `
            <span class="badge-status badge-active">
              🟢 Active
            </span>
          `}
        </td>
        <td style="text-align: right;">
          <div style="display: flex; gap: 0.4rem; justify-content: flex-end;">
            ${isBlocked ? `
              <button class="btn btn-secondary btn-sm" onclick="unblockChannel('${ch.channelId}')">🟢 Unblock</button>
            ` : `
              <button class="btn btn-danger btn-sm" onclick="blockChannel('${ch.channelId}')">🚫 Block</button>
            `}
            <button class="btn btn-secondary btn-sm" onclick="revokeChannel('${ch.channelId}', '${escapeHtml(ch.twitchLogin)}')">🔑 Revoke</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function blockChannel(channelId) {
  const reason = prompt('Enter a reason for blocking this channel (optional):', 'Violation of terms');
  if (reason === null) return;

  try {
    const res = await fetch(`${WORKER_URL}/admin/block`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channelId, reason }),
    });
    if (res.ok) fetchAdminData();
    else alert('Failed to block channel');
  } catch (err) {
    alert(`Error blocking channel: ${err.message}`);
  }
}

async function unblockChannel(channelId) {
  if (!confirm(`Are you sure you want to unblock channel ${channelId}?`)) return;

  try {
    const res = await fetch(`${WORKER_URL}/admin/unblock`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channelId }),
    });
    if (res.ok) fetchAdminData();
    else alert('Failed to unblock channel');
  } catch (err) {
    alert(`Error unblocking channel: ${err.message}`);
  }
}

async function revokeChannel(channelId, login) {
  if (!confirm(`Are you sure you want to REVOKE API access for @${login} (${channelId})? This will disconnect the streamer.`)) return;

  try {
    const res = await fetch(`${WORKER_URL}/admin/revoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channelId }),
    });
    if (res.ok) fetchAdminData();
    else alert('Failed to revoke API access');
  } catch (err) {
    alert(`Error revoking channel: ${err.message}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

document.addEventListener('DOMContentLoaded', initAdmin);
