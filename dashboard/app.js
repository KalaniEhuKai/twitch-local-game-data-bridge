/**
 * =============================================================================
 * Twitch Local Game Data Bridge — Streamer Dashboard
 * =============================================================================
 *
 * Flow:
 *   1. User visits the page — if an OAuth `?code=` param is present, we
 *      exchange it with the Worker to receive an API key.
 *   2. Authenticated state is persisted in localStorage so the streamer
 *      only needs to log in once per browser.
 *   3. Streamer picks a game profile and selects the game file(s) via the
 *      browser's File System Access API — no software install required.
 *   4. Once started, a polling loop reads each file every POLL_MS milliseconds.
 *      An upload is only triggered when the file content has actually changed,
 *      keeping request counts (and costs) as low as possible.
 *   5. If a game profile defines a parse() function, it runs client-side
 *      before the upload so only a compact, relevant payload is sent.
 *
 * Adding a new game: edit dashboard/games/registry.js — no changes needed here.
 */

const GAMES = window.TLGDB_GAMES || [];

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = window.TLGDB_CONFIG || {};
const WORKER_URL = (CONFIG.workerUrl || '').replace(/\/$/, '');
const CLIENT_ID = CONFIG.twitchClientId || '';

if (!WORKER_URL || WORKER_URL.includes('YOUR_WORKER')) {
  console.warn('[TLGDB] workerUrl is not configured in config.js');
}
if (!CLIENT_ID || CLIENT_ID.includes('YOUR_TWITCH')) {
  console.warn('[TLGDB] twitchClientId is not configured in config.js');
}

// How often to check whether game files have changed.
// We poll at 2× the desired update frequency so a 1-second game change
// is caught within ~500 ms. An upload only fires if content changed.
const POLL_MS = 500;

// Maximum activity log entries to keep in memory
const MAX_LOG_ENTRIES = 60;

// ─── Application State ───────────────────────────────────────────────────────

function getStorage(key) {
  const val = localStorage.getItem(key);
  return (val && val !== 'undefined' && val !== 'null') ? val : null;
}

// ─── Application State ───────────────────────────────────────────────────────

const state = {
  // Auth
  apiKey: getStorage('tlgdb:apiKey'),
  channelId: getStorage('tlgdb:channelId'),
  twitchLogin: getStorage('tlgdb:twitchLogin'),

  // Game / file selection
  selectedGame: null,
  fileHandles: {},   // { [fileKey]: FileSystemFileHandle }

  // Upload tracking
  lastContents: {},   // { [fileKey]: string } — last successfully uploaded content per file
  pollTimer: null, // setInterval handle
  isRunning: false,

  // Stats (reset each session)
  stats: { uploads: 0, skipped: 0, errors: 0, bytesOut: 0, startTime: null },

  // Activity log
  log: [],
};

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.hidden = hidden;
}

// ─── Initialisation ──────────────────────────────────────────────────────────

function init() {
  // Wire up persistent button handlers
  $('login-btn')?.addEventListener('click', loginWithTwitch);
  $('logout-btn')?.addEventListener('click', logout);
  $('delete-data-btn')?.addEventListener('click', handleManualDeleteData);
  $('delete-setup-btn')?.addEventListener('click', handleManualDeleteData);
  $('start-btn')?.addEventListener('click', startUploadLoop);
  $('stop-btn')?.addEventListener('click', stopUploadLoop);
  $('game-select')?.addEventListener('change', onGameChange);
  $('toggle-details-btn')?.addEventListener('click', toggleDetailsPanel);

  // Check if the File System Access API is available
  if (!window.showOpenFilePicker) {
    const note = $('file-api-note');
    if (note) note.hidden = false;
    const startBtn = $('start-btn');
    if (startBtn) startBtn.disabled = true;
  }

  // Populate game dropdown
  populateGameDropdown();

  // Handle Twitch OAuth redirect (code in URL query string)
  const params = new URLSearchParams(location.search);
  if (params.has('code')) {
    handleOAuthCallback(params.get('code'));
    return;
  }
  if (params.has('error')) {
    showError('Twitch authentication was denied or failed. Please try again.');
    history.replaceState({}, '', location.pathname);
  }

  render();
}

function generateSafeUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch { }
  }
  return 'xxxx-xxxx-4xxx-yxxx-xxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function loginWithTwitch() {
  try {
    clearError();

    if (!CLIENT_ID || CLIENT_ID.includes('YOUR_TWITCH')) {
      showError('Twitch Client ID is not configured in config.js.');
      return;
    }

    const oauthState = generateSafeUuid();
    try {
      sessionStorage.setItem('tlgdb:oauth_state', oauthState);
    } catch { }

    // Normalize redirect URL to match exactly what is registered in Twitch Console
    const redirectUri = location.origin + location.pathname;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: oauthState,
    });

    location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
  } catch (err) {
    console.error('[TLGDB] loginWithTwitch error:', err);
    showError(`Could not initiate Twitch login: ${err.message}`);
  }
}

async function handleOAuthCallback(code) {
  showView('loading');
  setText('loading-msg', 'Verifying your Twitch identity…');

  const redirectUri = location.origin + location.pathname;
  history.replaceState({}, '', location.pathname); // clean URL

  try {
    let res = await fetch(`${WORKER_URL}/auth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });

    // Fallback: If primary backend auth fails (e.g. Supabase missing secret or 404), try Cloudflare Worker Auth endpoint
    if (!res.ok && CONFIG.cloudflareWorkerUrl && WORKER_URL !== CONFIG.cloudflareWorkerUrl) {
      console.warn('[TLGDB] Primary auth endpoint failed, falling back to Cloudflare auth endpoint...');
      res = await fetch(`${CONFIG.cloudflareWorkerUrl}/auth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.apiKey) {
      throw new Error('Server did not return an API key');
    }
    saveAuth(data.apiKey, data.channelId, data.twitchLogin);
  } catch (err) {
    console.error('[TLGDB] Auth failed:', err);
    showError(`Authentication failed: ${err.message}. Please check if the redirect URI matches Twitch Application settings.`);
  } finally {
    render();
  }
}

function saveAuth(apiKey, channelId, twitchLogin) {
  state.apiKey = apiKey;
  state.channelId = channelId;
  state.twitchLogin = twitchLogin;
  localStorage.setItem('tlgdb:apiKey', apiKey);
  localStorage.setItem('tlgdb:channelId', channelId);
  localStorage.setItem('tlgdb:twitchLogin', twitchLogin);
}

function logout() {
  stopUploadLoop();
  clearError();
  state.apiKey = state.channelId = state.twitchLogin = null;
  localStorage.removeItem('tlgdb:apiKey');
  localStorage.removeItem('tlgdb:channelId');
  localStorage.removeItem('tlgdb:twitchLogin');
  render();
}

// ─── Game Selection ───────────────────────────────────────────────────────────
function populateGameDropdown() {
  const select = $('game-select');
  if (!select) return;
  const currentVal = state.selectedGame?.id || select.value;
  select.innerHTML = '<option value="">Choose a game…</option>';
  const gamesList = (window.TLGDB_GAMES && window.TLGDB_GAMES.length) ? window.TLGDB_GAMES : GAMES;
  gamesList.forEach(game => {
    const opt = document.createElement('option');
    opt.value = game.id;
    opt.textContent = `${game.emoji || '🎮'} ${game.name}`;
    if (game.id === currentVal) opt.selected = true;
    select.appendChild(opt);
  });
}

function onGameChange() {
  const select = $('game-select');
  const gamesList = (window.TLGDB_GAMES && window.TLGDB_GAMES.length) ? window.TLGDB_GAMES : GAMES;
  const game = gamesList.find(g => g.id === select?.value) || null;

  state.selectedGame = game;
  state.fileHandles = {};
  state.lastContents = {};

  setText('game-desc', game?.description || '');

  // Pre-fill check frequency input with game default (or 2s fallback)
  const intervalInput = $('poll-interval');
  if (intervalInput && game) {
    intervalInput.value = game.defaultIntervalSec || 2;
  }

  renderFileList();
  updateStartButton();
}

function renderFileList() {
  const container = $('file-list');
  if (!container) return;

  if (!state.selectedGame) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = state.selectedGame.files.map(f => {
    const isDir = f.type === 'directory';
    const mainBtnText = isDir ? '📁 Choose Folder...' : '📄 Choose File...';
    const suggestedPath = f.suggestedPath || f.description || '';

    return `
      <div class="file-selector-card" id="file-selector-${f.key}" style="border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; background: rgba(15, 23, 42, 0.5);">
        <div class="file-selector-header" style="margin-bottom: 0.85rem;">
          <div style="font-weight: 600; font-size: 1.05rem; color: var(--text, #f8fafc); margin-bottom: 0.35rem;">
            ${f.label}
          </div>
          ${suggestedPath ? `
            <div style="font-size: 0.83rem; color: var(--text-dim, #94a3b8); margin-bottom: 0.5rem; word-break: break-all; white-space: normal; line-height: 1.45;">
              <strong style="color: #cbd5e1;">Suggested Location:</strong>
              <code style="background: rgba(0, 0, 0, 0.35); padding: 3px 8px; border-radius: 5px; color: #38bdf8; word-break: break-all; font-family: monospace; display: inline-block; margin-top: 3px;">${escapeHtml(suggestedPath)}</code>
            </div>
          ` : ''}
        </div>

        <!-- Integrated Action & Drop Box -->
        <div id="drop-zone-${f.key}" class="unified-drop-zone" style="border: 2px dashed rgba(255, 255, 255, 0.22); border-radius: 10px; padding: 1.4rem 1rem; text-align: center; background: rgba(0, 0, 0, 0.2); transition: all 0.2s ease; margin-bottom: 0.85rem;">
          <div style="font-size: 2.2rem; margin-bottom: 0.4rem;">${isDir ? '📁' : '📄'}</div>
          <div style="display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
            <button class="btn btn-primary" id="pick-btn-${f.key}" style="font-size: 0.92rem; padding: 0.55rem 1.3rem;">
              ${mainBtnText}
            </button>
          </div>
          <div style="font-size: 0.83rem; color: var(--text-dim, #94a3b8);">
            or <strong>Drag & Drop</strong> your ${isDir ? 'folder' : 'file'} directly into this box
          </div>
        </div>

        <!-- Selected Status Badge -->
        <div id="file-status-${f.key}" class="file-status-badge" style="display: flex; align-items: center; gap: 0.6rem; padding: 0.65rem 0.9rem; border-radius: 8px; font-size: 0.88rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); transition: all 0.2s ease;">
          <span id="file-status-icon-${f.key}" style="font-size: 1rem;">⚠️</span>
          <span id="file-status-text-${f.key}" style="color: var(--text-dim, #94a3b8); word-break: break-all;">No ${isDir ? 'folder' : 'file'} selected yet</span>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers after rendering
  state.selectedGame.files.forEach(f => {
    const isDir = f.type === 'directory';
    if (isDir) {
      $(`pick-btn-${f.key}`)?.addEventListener('click', () => pickDirectory(f.key));
    } else {
      $(`pick-btn-${f.key}`)?.addEventListener('click', () => pickFile(f.key));
    }
    if (state.fileHandles[f.key]) {
      const handleObj = state.fileHandles[f.key];
      updateFileStatusBadge(f.key, '✅', `Selected ${isDir ? 'Folder' : 'File'}: ${handleObj.name}`, true);
    }
  });

  initDropZone();
}

function updateFileStatusBadge(fileKey, icon, text, isSelected = true) {
  const statusEl = $(`file-status-${fileKey}`);
  const iconEl = $(`file-status-icon-${fileKey}`);
  const textEl = $(`file-status-text-${fileKey}`);

  if (iconEl) iconEl.textContent = icon;
  if (textEl) textEl.textContent = text;

  if (statusEl) {
    if (isSelected) {
      statusEl.style.background = 'rgba(34, 197, 94, 0.12)';
      statusEl.style.borderColor = 'rgba(34, 197, 94, 0.4)';
      if (textEl) {
        textEl.style.color = '#4ade80';
        textEl.style.fontWeight = '600';
      }
    } else {
      statusEl.style.background = 'rgba(255, 255, 255, 0.05)';
      statusEl.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      if (textEl) {
        textEl.style.color = 'var(--text-dim, #94a3b8)';
        textEl.style.fontWeight = 'normal';
      }
    }
  }
}

function initDropZone() {
  if (!state.selectedGame) return;

  state.selectedGame.files.forEach(f => {
    const dropZone = $(`drop-zone-${f.key}`);
    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.borderColor = 'var(--primary, #3b82f6)';
        dropZone.style.background = 'rgba(59, 130, 246, 0.25)';
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.borderColor = 'rgba(255, 255, 255, 0.22)';
        dropZone.style.background = 'rgba(0, 0, 0, 0.2)';
      }, false);
    });

    dropZone.addEventListener('drop', async (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.items) return;

      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
          if (entry) {
            if (entry.isDirectory) {
              state.fileHandles[f.key] = {
                type: 'directory-entry',
                entry: entry,
                name: entry.name
              };
              updateFileStatusBadge(f.key, '✅', `Selected Folder: ${entry.name} (Drag & Drop)`, true);
              addLog('success', `Selected folder "${entry.name}" via Drag & Drop`);
            } else if (entry.isFile) {
              state.fileHandles[f.key] = {
                type: 'file-entry',
                entry: entry,
                name: entry.name
              };
              updateFileStatusBadge(f.key, '✅', `Selected File: ${entry.name} (Drag & Drop)`, true);
              addLog('success', `Selected file "${entry.name}" via Drag & Drop`);
            }
            clearError();
            updateStartButton();
            break;
          }
        }
      }
    });
  });
}

/**
 * Handle directory picker via File System Access API (showDirectoryPicker)
 */
async function pickDirectory(fileKey) {
  try {
    const dirHandle = await window.showDirectoryPicker();

    state.fileHandles[fileKey] = {
      type: 'directory',
      handle: dirHandle,
      name: dirHandle.name
    };

    updateFileStatusBadge(fileKey, '✅', `Selected Folder: ${dirHandle.name}`, true);
    clearError();
    updateStartButton();
  } catch (err) {
    if (err.name === 'SecurityError' || err.name === 'NotAllowedError' || (err.message && err.message.toLowerCase().includes('system'))) {
      pickDirectoryWithInputFallback(fileKey);
    } else if (err.name !== 'AbortError') {
      showError(`Could not access directory: ${err.message}`);
    }
  }
}

/**
 * Fallback directory picker using <input type="file" webkitdirectory>
 */
function pickDirectoryWithInputFallback(fileKey) {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.onchange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Determine folder name from webkitRelativePath
    const relPath = files[0]?.webkitRelativePath || '';
    const folderName = relPath.split('/')[0] || 'Selected Folder';

    state.fileHandles[fileKey] = {
      type: 'directory-fallback',
      file: files[0],
      name: folderName,
      allFiles: files
    };

    updateFileStatusBadge(fileKey, '✅', `Selected Folder: ${folderName} (Fallback)`, true);
    addLog('warn', `Folder snapshot selected ("${folderName}"). For live streaming inside C:\\Program Files, click "📄 Select Log File (Live)".`);
    clearError();
    updateStartButton();
  };
  input.click();
}

function pickFileWithInputFallback(fileKey) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      state.fileHandles[fileKey] = {
        type: 'file',
        file: file,
        name: file.name
      };
      updateFileStatusBadge(fileKey, '✅', `Selected File: ${file.name}`, true);
      clearError();
      updateStartButton();
    }
  };
  input.click();
}

async function pickFile(fileKey) {
  try {
    const opts = { multiple: false };

    const [handle] = await window.showOpenFilePicker(opts);
    state.fileHandles[fileKey] = {
      type: 'file-handle',
      handle: handle,
      name: handle.name
    };

    updateFileStatusBadge(fileKey, '✅', `Selected File: ${handle.name}`, true);
    clearError();
    updateStartButton();
  } catch (err) {
    if (err.name === 'SecurityError' || err.name === 'NotAllowedError' || (err.message && err.message.toLowerCase().includes('system file'))) {
      pickFileWithInputFallback(fileKey);
    } else if (err.name !== 'AbortError') {
      showError(`Could not access file: ${err.message}`);
    }
  }
}

function updateStartButton() {
  const btn = $('start-btn');
  if (!btn || !state.selectedGame) return;
  const allPicked = state.selectedGame.files.every(f => state.fileHandles[f.key]);
  btn.disabled = !allPicked;
}

// ─── Upload Loop ──────────────────────────────────────────────────────────────

function startUploadLoop() {
  if (state.isRunning) return;

  // Read check frequency from input, falling back to game default or 2s
  const rawSec = parseFloat($('poll-interval')?.value);
  const defaultSec = state.selectedGame?.defaultIntervalSec || 2;
  const intervalSec = (!isNaN(rawSec) && rawSec > 0) ? rawSec : defaultSec;

  // Enforce minimum 1.0s to prevent browser/network overload
  const clampedSec = Math.max(1.0, intervalSec);
  const pollMs = Math.round(clampedSec * 1000);

  state.activeIntervalSec = clampedSec;
  state.isRunning = true;
  state.stats = { uploads: 0, skipped: 0, errors: 0, bytesOut: 0, startTime: Date.now() };
  state.lastContents = {};
  state.log = [];

  setText('live-game-name', state.selectedGame?.name || '');
  render();

  addLog('success', `Started — watching ${state.selectedGame?.files.length} file(s) every ${clampedSec}s`);

  // Run initial upload check immediately on start
  poll();

  state.pollTimer = setInterval(poll, pollMs);
}

function stopUploadLoop() {
  if (!state.isRunning) return;
  state.isRunning = false;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  addLog('warn', 'Stopped — clearing server data…');

  deleteUploadedData().then(ok => {
    if (ok) addLog('warn', 'Server data cleared successfully');
  });

  render();
}

async function deleteUploadedData(gameId = null, fileKey = null, keepalive = false) {
  if (!state.apiKey) return false;
  const path = gameId ? `/data/${encodeURIComponent(gameId)}${fileKey ? '/' + encodeURIComponent(fileKey) : ''}` : '/data';
  const url = `${WORKER_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${state.apiKey}`,
        'X-Channel-Id': state.channelId || '',
      },
      keepalive,
    });
    return res.ok;
  } catch (err) {
    console.error('[TLGDB] Delete data error:', err);
    return false;
  }
}

async function handleManualDeleteData() {
  if (!confirm('Are you sure you want to delete all your uploaded game data from the server?')) return;
  showView('loading');
  setText('loading-msg', 'Deleting your uploaded data from the server…');
  const ok = await deleteUploadedData();
  render();
  if (ok) {
    showError('Successfully deleted all uploaded data from the server.');
  } else {
    showError('Could not delete data. Please check your connection.');
  }
}

async function poll() {
  if (!state.selectedGame || !state.isRunning) return;
  for (const fileDef of state.selectedGame.files) {
    const handle = state.fileHandles[fileDef.key];
    if (handle) await processFile(fileDef, handle);
  }
  updateStatsDisplay();
}

async function processFile(fileDef, item) {
  let rawContent;
  let activeFileName = item.name || fileDef.label;

  // ── If game profile defines processDirectory for folders, delegate to it ──────
  if (fileDef.type === 'directory' && typeof state.selectedGame?.processDirectory === 'function') {
    try {
      const result = await state.selectedGame.processDirectory(fileDef.key, item);
      if (result === null || result === undefined) {
        state.stats.skipped++;
        return;
      }
      if (typeof result === 'object' && result.content !== undefined) {
        rawContent = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        if (result.fileName) activeFileName = result.fileName;
      } else {
        rawContent = typeof result === 'string' ? result : JSON.stringify(result);
      }
    } catch (err) {
      addLog('error', `Directory processing error on "${fileDef.label}": ${err.message}`);
      state.stats.errors++;
      return;
    }
  } else {
    // ── Single File Reading ──────────────────────────────────────────────────
    async function getFileObj(targetItem) {
      if (!targetItem) return null;
      if (targetItem.type === 'directory-fallback') return targetItem.file;
      if (targetItem.type === 'directory-entry' || targetItem.type === 'file-entry') {
        if (targetItem.entry && typeof targetItem.entry.file === 'function') {
          return await new Promise(res => targetItem.entry.file(f => res(f), () => res(null)));
        }
      }
      if (targetItem.type === 'file-handle') return await targetItem.handle.getFile();
      if (targetItem.type === 'file') return targetItem.file;
      if (typeof targetItem.getFile === 'function') return await targetItem.getFile();
      return targetItem;
    }

    try {
      const file = await getFileObj(item);
      if (!file) throw new Error('File not available');
      if (file.name) activeFileName = file.name;

      if (typeof file.arrayBuffer === 'function') {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binaryStr = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        rawContent = binaryStr;
      } else {
        rawContent = await file.text();
      }
    } catch (err) {
      // NOTE: For Guild Run only — if the file is not present when trying to send it, do not treat as error.
      // Send a payload indicating status is "no_file_found" (no active run).
      // NOTE: Long-term, a separate status endpoint (e.g. GET/POST /status) would be cleaner,
      // but sending status in the main data payload avoids additional HTTP overhead & bandwidth currently.
      const isGuildRun = (state.selectedGame && state.selectedGame.id === 'guild-run') ||
                         (fileDef && fileDef.label && fileDef.label.includes('Guild Run'));

      const isNotFoundError = err.name === 'NotFoundError' ||
                             err.name === 'TypeMismatchError' ||
                             err.code === 8 ||
                             (err.message && (
                               err.message.toLowerCase().includes('not found') ||
                               err.message.toLowerCase().includes('could not be found') ||
                               err.message.toLowerCase().includes('does not exist') ||
                               err.message.toLowerCase().includes('not available') ||
                               err.message.toLowerCase().includes('file or directory')
                             ));

      if (isGuildRun && (isNotFoundError || err.name === 'NotFoundError')) {
        rawContent = JSON.stringify({
          status: 'no_file_found',
          message: 'No active run file found',
          timestamp: new Date().toISOString()
        });
        activeFileName = 'Run (No Active Run)';
      } else {
        const isLockError = err.name === 'NotReadableError' ||
                            err.name === 'NotAllowedError' ||
                            err.name === 'SecurityError' ||
                            (err.message && (
                              err.message.toLowerCase().includes('readable') ||
                              err.message.toLowerCase().includes('permission') ||
                              err.message.toLowerCase().includes('lock') ||
                              err.message.toLowerCase().includes('access')
                            ));

        if (isLockError) {
          // Game is currently writing/locking the file — wait 150ms and retry once
          await new Promise(r => setTimeout(r, 150));
          try {
            const retryFile = typeof item.getFile === 'function' ? await item.getFile() : item;
            rawContent = await retryFile.text();
          } catch (retryErr) {
            addLog('warn', `File temporarily locked by game — retrying next check`);
            state.stats.skipped++;
            return;
          }
        } else {
          addLog('error', `Read error on "${fileDef.label}": ${err.message}`);
          state.stats.errors++;
          return;
        }
      }
    }
  }

  // ── Skip if unchanged — this is the primary cost-saving optimisation ────────
  if (rawContent === state.lastContents[fileDef.key]) {
    state.stats.skipped++;
    return;
  }

  // ── Run game-specific parser (if defined) ───────────────────────────────────
  let payload = rawContent;
  if (state.selectedGame.parse) {
    try {
      const result = await state.selectedGame.parse(fileDef.key, rawContent);
      if (result === null || result === undefined) {
        // Parser returning null is a deliberate signal to skip this update
        state.stats.skipped++;
        return;
      }
      payload = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      addLog('error', `Parse error on "${fileDef.label}": ${err.message}`);
      state.stats.errors++;
      return;
    }
  }

  // ── Upload to Worker / Supabase ─────────────────────────────────────────────
  const uploadUrl = `${WORKER_URL}/upload?gameId=${encodeURIComponent(state.selectedGame.id)}&fileKey=${encodeURIComponent(fileDef.key)}&channelId=${encodeURIComponent(state.channelId || '')}`;
  try {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.apiKey}`,
        'X-Channel-Id': state.channelId || '',
        'Content-Type': state.selectedGame.parse ? 'application/json' : 'text/plain',
      },
      body: payload,
    });

    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      const detail = [
        `HTTP Status: 401 Unauthorized`,
        `Endpoint: ${uploadUrl}`,
        `Server Reason: ${data.error || 'API key rejected by server'}`,
        `Troubleshooting: Click Disconnect and reconnect with Twitch to issue a fresh key.`
      ].join('\n');
      addLog('error', 'Upload authentication failed (401)', detail);
      stopUploadLoop();
      return;
    }

    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      const detail = [
        `HTTP Status: 403 Forbidden`,
        `Endpoint: ${uploadUrl}`,
        `Channel ID: ${state.channelId}`,
        `Server Reason: ${data.reason || 'Channel is blocked'}`,
        `Troubleshooting: Check if rate limit auto-block expired or contact server admin.`
      ].join('\n');
      addLog('error', 'Channel blocked (403)', detail);
      stopUploadLoop();
      return;
    }

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const title = data.quotaExceeded ? 'Cloudflare KV Daily Limit Reached (429)' : 'Rate limited by server (429)';
      const detail = [
        `HTTP Status: 429 Too Many Requests`,
        `Endpoint: ${uploadUrl}`,
        `Server Reason: ${data.error || 'Upload limit or rate limit reached.'}`,
        data.retryAfter ? `Retry After: ${data.retryAfter} seconds` : `Reset Time: Quota resets at 00:00 UTC`
      ].join('\n');
      addLog('warn', title, detail);
      state.stats.errors++;
      return;
    }

    if (!res.ok) {
      let bodyText = '';
      try {
        const bodyData = await res.json();
        bodyText = bodyData.error || JSON.stringify(bodyData, null, 2);
      } catch {
        bodyText = await res.text().catch(() => 'No response body');
      }
      const detail = [
        `HTTP Status: ${res.status} ${res.statusText}`,
        `Endpoint: ${uploadUrl}`,
        `File Uploaded: ${activeFileName}`,
        `Profile Label: ${fileDef.label}`,
        `Payload Size: ${formatBytes(payload.length)}`,
        `Server Response:\n${bodyText}`
      ].join('\n');
      addLog('error', `Upload failed (HTTP ${res.status})`, detail);
      state.stats.errors++;
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────────
    state.lastContents[fileDef.key] = rawContent; // track last *raw* content for change detection
    state.stats.uploads++;
    state.stats.bytesOut += payload.length;

    const displayMsg = (activeFileName && activeFileName !== fileDef.label)
      ? `${activeFileName} (${fileDef.label}) → ${formatBytes(payload.length)}`
      : `${fileDef.label} → ${formatBytes(payload.length)}`;

    const detail = [
      `File Uploaded: ${activeFileName}`,
      `Profile Label: ${fileDef.label}`,
      `Payload Size: ${formatBytes(payload.length)}`,
      `Endpoint: ${uploadUrl}`,
    ].join('\n');

    addLog('success', displayMsg, detail);

  } catch (err) {
    const detail = [
      `Target URL: ${uploadUrl}`,
      `File: ${fileDef.label} (${fileDef.key})`,
      `Payload Size: ${formatBytes(payload.length)}`,
      `Error Message: ${err.name}: ${err.message}`,
      `Diagnostic Steps:`,
      ` 1. Verify https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev/health is reachable in your browser.`,
      ` 2. Check if uBlock Origin, Brave Shields, or an adblocker is blocking Cloudflare Worker requests.`,
      ` 3. Check browser console (F12 -> Console / Network tab) for details.`
    ].join('\n');
    addLog('error', `Network error: ${err.message}`, detail);
    state.stats.errors++;
  }
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

function addLog(type, message, details = null) {
  state.log.unshift({
    type,
    message,
    details,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  });
  if (state.log.length > MAX_LOG_ENTRIES) state.log.pop();
  renderLog();
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

function renderLog() {
  const container = $('activity-log');
  if (!container) return;

  if (state.log.length === 0) {
    container.innerHTML = '<p class="log-empty">Waiting for file changes…</p>';
    return;
  }

  const ICON = { success: '✓', warn: '⚠', error: '✕' };
  container.innerHTML = state.log
    .map(entry => `
      <div class="log-entry log-entry--${entry.type}">
        <div class="log-header">
          <span class="log-time">${entry.time}</span>
          <span class="log-icon">${ICON[entry.type] || '·'}</span>
          <span class="log-msg">${escapeHtml(entry.message)}</span>
        </div>
        ${entry.details ? `<pre class="log-details">${escapeHtml(entry.details)}</pre>` : ''}
      </div>
    `)
    .join('');
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateHeroStatusCard() {
  const card = $('hero-status-card');
  const icon = $('hero-status-icon');
  const badge = $('hero-status-badge');
  const text = $('hero-status-text');
  const dot = $('hero-pulse-dot');
  const sub = $('hero-status-sub');
  const link = $('view-data-link');
  if (!card || !badge || !text || !sub) return;

  const hasErrors = state.stats.errors > 0;
  const isStalled = state.stats.uploads === 0 && state.stats.skipped > 0;
  const gameName = state.selectedGame?.name || 'Game';

  if (link && state.channelId && state.selectedGame) {
    const firstFileKey = state.selectedGame.files[0]?.key || 'default';
    link.href = `${WORKER_URL}/data/${state.channelId}/${state.selectedGame.id}/${firstFileKey}`;
    link.hidden = false;
  }

  if (hasErrors) {
    card.className = 'hero-status-card hero-status-card--error';
    if (icon) icon.textContent = '🔴';
    badge.className = 'hero-status-badge hero-status-badge--error';
    if (dot) dot.className = 'pulse-dot pulse-dot--error';
    text.textContent = 'Attention Needed';

    const errorCount = state.stats.errors;
    sub.textContent = `${errorCount} error(s) encountered while sending ${gameName} data. Click "Show Statistics & Logs" below to inspect details.`;
  } else if (isStalled) {
    card.className = 'hero-status-card hero-status-card--error';
    if (icon) icon.textContent = '⚠️';
    badge.className = 'hero-status-badge hero-status-badge--error';
    if (dot) dot.className = 'pulse-dot pulse-dot--error';
    text.textContent = 'File Locked / No Data Sent';

    sub.textContent = `The game file is currently locked by the game process. No data has been uploaded to the server yet.`;
  } else {
    card.className = 'hero-status-card hero-status-card--ok';
    if (icon) icon.textContent = '🟢';
    badge.className = 'hero-status-badge hero-status-badge--ok';
    if (dot) dot.className = 'pulse-dot';
    text.textContent = 'Everything is working';

    const updatesText = state.stats.uploads === 1 ? '1 update sent' : `${state.stats.uploads} updates sent`;
    sub.textContent = `Sending data for ${gameName} every ${state.activeIntervalSec || 2}s • ${updatesText}`;
  }
}

function toggleDetailsPanel() {
  const panel = $('details-panel');
  const btn = $('toggle-details-btn');
  if (!panel || !btn) return;

  panel.hidden = !panel.hidden;
  btn.textContent = panel.hidden ? '📊 Show Statistics & Logs ▼' : '📊 Hide Statistics & Logs ▲';
}

function updateStatsDisplay() {
  const s = state.stats;
  const elapsedSec = s.startTime ? (Date.now() - s.startTime) / 1000 : 0;
  const rate = elapsedSec > 0 ? (s.uploads / elapsedSec * 60).toFixed(1) : '—';

  setText('stat-uploads', s.uploads.toLocaleString());
  setText('stat-skipped', s.skipped.toLocaleString());
  setText('stat-errors', s.errors.toLocaleString());
  setText('stat-bytes', formatBytes(s.bytesOut));
  setText('stat-rate', rate === '—' ? '—' : `${rate} / min`);

  updateHeroStatusCard();
}

// ─── View Rendering ───────────────────────────────────────────────────────────

function render() {
  const views = ['auth', 'setup', 'live', 'loading'];

  let active;
  if (!state.apiKey) active = 'auth';
  else if (state.isRunning) active = 'live';
  else active = 'setup';

  views.forEach(v => setHidden(`view-${v}`, v !== active));

  // Header user area
  if (state.apiKey && state.twitchLogin) {
    setText('user-name', `@${state.twitchLogin}`);
    setHidden('header-user-area', false);
  } else {
    setHidden('header-user-area', true);
  }

  if (active === 'setup') {
    populateGameDropdown();
  }

  if (active === 'live') {
    updateStatsDisplay();
    renderLog();
  }
}

function showView(name) {
  ['auth', 'setup', 'live', 'loading'].forEach(v => setHidden(`view-${v}`, v !== name));
}

// ─── Error Display ────────────────────────────────────────────────────────────

function clearError() {
  const el = $('error-banner');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

function showError(msg) {
  const el = $('error-banner');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

window.addEventListener('pagehide', () => {
  if (state.apiKey) {
    deleteUploadedData(null, null, true);
  }
});
