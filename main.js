const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { exec } = require('child_process');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SESSION_KEY = 'local';

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...loadSettings(), ...s }, null, 2));
}

function resolveRemoteScriptsDir() {
  const prefsRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'Ableton');
  try {
    if (fs.existsSync(prefsRoot)) {
      const versions = fs.readdirSync(prefsRoot).filter(v => /^Live \d/.test(v)).sort().reverse();
      for (const v of versions) {
        const cfg = path.join(prefsRoot, v, 'Preferences', 'Library.cfg');
        if (fs.existsSync(cfg)) {
          const xml = fs.readFileSync(cfg, 'utf8');
          const pathMatch = xml.match(/ProjectPath[^>]*Value="([^"]+)"/);
          const nameMatch = xml.match(/ProjectName[^>]*Value="([^"]+)"/);
          if (pathMatch && nameMatch && pathMatch[1] && nameMatch[1] && nameMatch[1] !== '.' && nameMatch[1] !== '..') {
            return path.join(pathMatch[1], nameMatch[1], 'Remote Scripts');
          }
        }
      }
    }
  } catch {}
  return path.join(os.homedir(), 'Documents', 'Ableton', 'User Library', 'Remote Scripts');
}

function detectAbleton() {
  return new Promise((resolve) => {
    exec('tasklist /NH', (err, stdout) => {
      const running = !err && /Ableton Live/i.test(stdout);
      resolve({ running });
    });
  });
}

// --- OSC client -----------------------------------------------------------
const OSC_SEND_PORT = 11000;
const OSC_REPLY_PORT = 11001;
let oscSocket = null;
const oscPending = new Map();

function getOscSocket() {
  if (oscSocket) return oscSocket;
  oscSocket = dgram.createSocket('udp4');
  oscSocket.on('message', (buf) => {
    const addr = readOscString(buf, 0);
    const waiter = oscPending.get(addr.str);
    if (waiter) {
      oscPending.delete(addr.str);
      clearTimeout(waiter.timer);
      waiter.resolve(parseOscArgs(buf));
    }
  });
  oscSocket.on('error', () => {});
  oscSocket.bind(OSC_REPLY_PORT, '127.0.0.1');
  return oscSocket;
}

function oscSend(address, args = [], { expectReply = false, timeoutMs = 3000 } = {}) {
  const sock = getOscSocket();
  const msg = buildOscMessage(address, args);
  return new Promise((resolve, reject) => {
    if (expectReply) {
      const timer = setTimeout(() => {
        oscPending.delete(address);
        reject(new Error(`No reply from Ableton for ${address}`));
      }, timeoutMs);
      oscPending.set(address, { resolve, timer });
    }
    sock.send(msg, OSC_SEND_PORT, '127.0.0.1', (err) => {
      if (err) {
        if (expectReply) {
          const w = oscPending.get(address);
          if (w) { clearTimeout(w.timer); oscPending.delete(address); }
        }
        reject(err);
      } else if (!expectReply) {
        resolve(true);
      }
    });
  });
}

function buildOscMessage(address, args) {
  function oscStr(s) {
    const b = Buffer.from(s + '\0');
    const pad = 4 - (b.length % 4);
    return Buffer.concat([b, Buffer.alloc(pad === 4 ? 0 : pad)]);
  }
  let typeTag = ',';
  const argBufs = [];
  for (const a of args) {
    if (typeof a === 'string') { typeTag += 's'; argBufs.push(oscStr(a)); }
    else if (typeof a === 'number') {
      if (Number.isInteger(a)) { typeTag += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); argBufs.push(b); }
      else { typeTag += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b); }
    }
  }
  typeTag += '\0';
  return Buffer.concat([oscStr(address), oscStr(typeTag), ...argBufs]);
}
function readOscString(buf, offset) {
  let end = offset;
  while (buf[end] !== 0) end++;
  const str = buf.slice(offset, end).toString('ascii');
  const next = end + 1;
  const pad = 4 - (next % 4);
  return { str, next: next + (pad === 4 ? 0 : pad) };
}
function parseOscArgs(buf) {
  const addr = readOscString(buf, 0);
  const tags = readOscString(buf, addr.next);
  const types = tags.str.slice(1);
  const args = [];
  let off = tags.next;
  for (const t of types) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 's') { const s = readOscString(buf, off); args.push(s.str); off = s.next; }
    else if (t === 'h' || t === 't') { off += 8; }
    else break;
  }
  return { address: addr.str, args };
}

async function oscPing() {
  try {
    const r = await oscSend('/live/ping', [], { expectReply: true, timeoutMs: 1500 });
    return Array.isArray(r.args) && r.args[0] === 'ok';
  } catch { return false; }
}
async function getTrackCount() {
  const r = await oscSend('/live/song/get/num_tracks', [], { expectReply: true });
  return Number(r.args[0]) || 0;
}
async function loadFileIntoSlot(trackIndex, clipIndex, filePath) {
  // Live can only load files that sit inside one of its Browser roots. The User
  // Library/Samples folder is already a root, so copy the file there first.
  let target = filePath;
  try {
    const dir = importsDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!filePath.toLowerCase().startsWith(dir.toLowerCase())) {
      target = path.join(dir, path.basename(filePath));
      fs.copyFileSync(filePath, target);
    }
  } catch {}

  let track = Number(trackIndex);
  if (!Number.isInteger(track) || track < 0) {
    // Create a fresh audio track and put the clip in its first slot.
    await oscSend('/live/song/create_audio_track', [], { expectReply: false });
    await new Promise((r) => setTimeout(r, 250));
    try {
      const nt = await oscSend('/live/song/get/num_tracks', [], { expectReply: true, timeoutMs: 1500 });
      track = (Number(nt.args[0]) || 1) - 1;
    } catch { track = 0; }
  }
  await oscSend('/live/clip_slot/load_file', [track, clipIndex, target], { expectReply: false });
  return { ok: true, path: target, trackIndex: track };
}

function importsDir() {
  return path.join(path.dirname(resolveRemoteScriptsDir()), 'Samples', 'Bridge Imports');
}

// --- Ableton live state ----------------------------------------------------
let abletonState = { connected: false };
let lastStateJson = '';

async function refreshAbletonState() {
  try {
    const ping = await oscSend('/live/ping', [], { expectReply: true, timeoutMs: 1200 });
    if (!ping || ping.args[0] !== 'ok') throw new Error('no ping');
    let numTracks = 0;
    let projectName = 'Untitled';
    try {
      const nt = await oscSend('/live/song/get/num_tracks', [], { expectReply: true, timeoutMs: 1200 });
      numTracks = Number(nt.args[0]) || 0;
      if (numTracks > 0) {
        const tn = await oscSend('/live/track/get/name', [0], { expectReply: true, timeoutMs: 1200 });
        if (tn.args[1]) projectName = String(tn.args[1]);
      }
    } catch {}
    abletonState = {
      connected: true,
      filePath: '',
      projectName,
      setInstanceId: 'live',
      numTracks,
    };
  } catch {
    abletonState = { connected: false };
  }
  const json = JSON.stringify(abletonState);
  if (json !== lastStateJson) {
    lastStateJson = json;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ableton-state', abletonState);
      mainWindow.webContents.send('ableton-connection-diagnostics', {
        bound: abletonState.connected, lastError: null,
      });
    }
  }
  return abletonState;
}

// --- window ---------------------------------------------------------------
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 760,
    minWidth: 720, minHeight: 520,
    title: 'Bridge',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-local.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'app', 'local.html'));
  buildMenu();
  if (process.env.BRIDGE_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function navigate(target) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigate-screen', target);
}

function buildMenu() {
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'About Bridge', click: () => navigate('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  refreshAbletonState();
  setInterval(refreshAbletonState, 3000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- IPC helpers ----------------------------------------------------------
const handle = (channel, fn) => ipcMain.handle(channel, fn);

const DEFAULTS = {
  'ableton-connection-diagnostics-snapshot': null,
  'ableton-state-snapshot': null,
  'agent-acknowledge-project': null,
  'agent-approve': null,
  'agent-cancel': null,
  'agent-chat-list': [],
  'agent-chat-select': null,
  'agent-create': null,
  'agent-dismiss-notices': null,
  'agent-insert-preview': null,
  'agent-invalidate-oauth': null,
  'agent-record-audition': null,
  'agent-status': null,
  'agent-transcript-clear': null,
  'agent-transcript-snapshot': null,
  'app-logs-download': null,
  'app-logs-inventory': [],
  'auto-update-check': { status: 'idle' },
  'auto-update-install': { status: 'idle' },
  'auto-update-status': { status: 'idle' },
  'billing-open-plans': null,
  'billing-premier-pricing': {},
  'billing-start-checkout': null,
  'cache-delete': null,
  'cache-inventory': [],
  'cache-view': null,
  'clean-imports-reveal': null,
  'clean-imports-run': { canceled: true },
  'clean-imports-scan': { dir: '', exists: false, fileCount: 0, totalBytes: 0 },
  'convert-build-zip': null,
  'convert-cleanup-zip': null,
  'convert-create': null,
  'convert-preview-audio': null,
  'convert-status': null,
  'convert-sync-create': null,
  'convert-upload': null,
  'convert-upload-complete': null,
  'credits-refresh': { sessionKey: SESSION_KEY, credits: 0 },
  'credits-status': { sessionKey: SESSION_KEY, credits: 0 },
  'deep-link-claim': null,
  'deep-link-release': null,
  'deep-link-status': null,
  'downloads-folder-path': '',
  'export-create': null,
  'export-download': null,
  'export-list-projects': [],
  'export-project-state': null,
  'export-status': null,
  'factory-reset-execute': null,
  'factory-reset-inventory': {},
  'get-git-info': null,
  'get-pending-navigation': null,
  'http-traffic-clear': null,
  'http-traffic-open-window': null,
  'http-traffic-set-enabled': null,
  'http-traffic-snapshot': null,
  'linked-projects-link': null,
  'linked-projects-list': [],
  'linked-projects-read': [],
  'notify-project-ready': null,
  'oauth-avatar-failed': null,
  'oauth-cancel': null,
  'oauth-refresh-profile': null,
  'oauth-sign-in': null,
  'oauth-sign-out': null,
  'onboarding-detect': null,
  'onboarding-install': null,
  'onboarding-reveal-install': null,
  'onboarding-uninstall': null,
  'open-privacy-settings': null,
  'parse-midi-file': null,
  'recent-projects-list': [],
  'repair-folder-access': null,
  'reveal-in-finder': null,
  'scan-directory': [],
  'scan-project-tree': { tracks: [], clips: [] },
  'select-download-folder': null,
  'settings-data-inventory': [],
  'suno-control-reconnect': null,
  'support-logs-copy': null,
  'support-logs-download': null,
  'support-logs-reveal': null,
  'track-event': null,
  'uninstall-app': null,
  'view-remote-control-log-clear': null,
  'view-remote-control-log-reveal': null,
  'view-remote-control-log-save-snapshot': null,
  'view-remote-control-log-snapshot': { path: '', status: 'idle', lines: [], lastError: null },
};

const OVERRIDDEN = new Set([
  'oauth-status', 'oauth-get-token', 'get-has-completed-first-run', 'set-has-completed-first-run',
  'oauth-refresh-profile', 'oauth-sign-in',
  'get-app-info', 'get-app-name', 'get-app-version',
  'check-for-ableton-process', 'ableton-open', 'ableton-restart',
  'ableton-state-snapshot', 'ableton-connection-diagnostics-snapshot',
  'bridge-setup-snapshot', 'bridge-setup-repair',
  'onboarding-detect', 'onboarding-install', 'onboarding-uninstall', 'onboarding-reveal-install',
  'suno-control-reconnect',
  'select-folder', 'select-download-folder', 'pick-audio-file', 'pick-midi-file',
  'settings-open-data-dir', 'settings-open-logs-dir', 'open-external', 'open-dev-tools', 'refresh-renderer',
  'remote-control-create-audio-track', 'remote-control-send-audio-file',
  'remote-control-create-midi-track', 'remote-control-send-midi-notes',
  'remote-control-errors-snapshot', 'remote-control-errors-clear',
  'remote-control-import-status-snapshot', 'remote-control-stop-import',
  'load-file-into-slot', 'track-count', 'osc-ping', 'generate-music',
]);

for (const [channel, value] of Object.entries(DEFAULTS)) {
  if (OVERRIDDEN.has(channel)) continue;
  handle(channel, () => (typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value));
}

// identity / first run
// identity / first run: local-first, no login
const LOCAL_API_BASE = 'https://studio-api.prod.elevenlabs.io';
const LOCAL_PROFILE = {
  signedIn: true, displayName: 'local', apiBase: LOCAL_API_BASE, avatarUrl: null,
  userId: 'local', email: '', sessionKey: SESSION_KEY, canCreate: true, canUseStudio: true,
};
handle('oauth-status', () => ({ ...LOCAL_PROFILE }));
handle('oauth-refresh-profile', () => ({ ...LOCAL_PROFILE }));
handle('oauth-sign-in', () => ({ ...LOCAL_PROFILE }));
handle('oauth-get-token', () => 'local-token');
handle('get-has-completed-first-run', () => true);
handle('set-has-completed-first-run', () => true);
handle('get-app-info', () => ({ name: 'bridge', version: app.getVersion(), packaged: app.isPackaged }));
handle('get-app-name', () => 'Bridge');
handle('get-app-version', () => app.getVersion());

// ableton
handle('check-for-ableton-process', () => detectAbleton());
handle('ableton-open', () => launchLive());
handle('ableton-restart', () => launchLive());
handle('ableton-state-snapshot', async () => refreshAbletonState());
handle('ableton-connection-diagnostics-snapshot', () => ({ bound: abletonState.connected, lastError: null }));
handle('bridge-setup-snapshot', () => {
  const dir = path.join(resolveRemoteScriptsDir(), 'ableton_bridge');
  const installed = fs.existsSync(dir);
  return {
    installed, health: installed ? 'healthy' : 'missing', detail: null, lastError: null,
    restartRequired: false, busy: false, automaticAction: null,
    destPath: dir, remoteScriptsDir: resolveRemoteScriptsDir(),
    live: { status: abletonState.connected ? 'running' : 'unknown' },
  };
});
handle('bridge-setup-repair', () => installRemoteScript());
handle('onboarding-detect', () => {
  const dir = path.join(resolveRemoteScriptsDir(), 'ableton_bridge');
  return { installed: fs.existsSync(dir), destPath: dir, remoteScriptsDir: resolveRemoteScriptsDir(), sourceDir: path.join(__dirname, 'ableton_bridge') };
});
handle('onboarding-install', () => installRemoteScript());
handle('onboarding-uninstall', () => {
  const dir = path.join(resolveRemoteScriptsDir(), 'ableton_bridge');
  const removed = fs.existsSync(dir);
  if (removed) fs.rmSync(dir, { recursive: true, force: true });
  return { destPath: dir, removed };
});
handle('onboarding-reveal-install', () => shell.openPath(resolveRemoteScriptsDir()));
handle('suno-control-reconnect', () => oscPing());

// files
handle('select-folder', () => dialog.showOpenDialog({ properties: ['openDirectory'] }).then(r => r.canceled ? null : r.filePaths[0]));
handle('select-download-folder', () => dialog.showOpenDialog({ properties: ['openDirectory'] }).then(r => r.canceled ? null : r.filePaths[0]));
handle('pick-audio-file', () => dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav','mp3','aiff','flac'] }] }).then(r => r.canceled ? null : r.filePaths[0]));
handle('pick-midi-file', () => dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'MIDI', extensions: ['mid','midi'] }] }).then(r => r.canceled ? null : r.filePaths[0]));
handle('settings-open-data-dir', () => shell.openPath(app.getPath('userData')));
handle('settings-open-logs-dir', () => shell.openPath(app.getPath('logs')));
handle('open-external', (_e, url) => shell.openExternal(url));
handle('open-dev-tools', async () => { if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' }); });
handle('refresh-renderer', () => { if (mainWindow) mainWindow.webContents.reload(); });

// remote control
handle('remote-control-create-audio-track', () => getTrackCount().then(count => ({ trackIndex: count })));
handle('remote-control-send-audio-file', (_e, opts) => loadFileIntoSlot(opts?.trackIndex ?? 0, opts?.clipIndex ?? 0, opts?.filePath));
handle('remote-control-create-midi-track', () => null);
handle('remote-control-send-midi-notes', () => null);
handle('remote-control-errors-snapshot', () => []);
handle('remote-control-errors-clear', () => null);
handle('remote-control-import-status-snapshot', () => ({ active: false }));
handle('remote-control-stop-import', () => null);

// generated audio insert
handle('load-file-into-slot', (_e, { trackIndex, clipIndex, filePath }) => loadFileIntoSlot(trackIndex, clipIndex, filePath));
handle('track-count', () => getTrackCount());
handle('osc-ping', () => oscPing());
handle('get-settings', () => loadSettings());
handle('save-settings', (_e, s) => { saveSettings(s); return true; });
handle('detect-ableton', () => detectAbleton());
handle('remote-scripts-dir', () => resolveRemoteScriptsDir());
handle('install-remote-script', () => installRemoteScript());
handle('open-path', (_e, p) => shell.openPath(p));
handle('generate-music', async (_e, opts) => {
  const settings = loadSettings();
  const apiKey = settings.elevenlabsApiKey || opts.apiKey;
  if (!apiKey) throw new Error('ElevenLabs API key not set');
  const music = require('./elevenlabs/music.js');
  const outDir = importsDir();
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `gen-${Date.now()}.mp3`);
  await music.composeToFile({ apiKey, prompt: opts.prompt, musicLengthMs: opts.durationMs, modelId: opts.modelId, forceInstrumental: opts.instrumental }, dest);
  return { ok: true, path: dest };
});

// --- live helpers ---------------------------------------------------------
function launchLive() {
  const candidates = [
    'C:\\ProgramData\\Ableton\\Live 12 Suite\\Program\\Live.exe',
    'C:\\ProgramData\\Ableton\\Live 12 Standard\\Program\\Live.exe',
    'C:\\ProgramData\\Ableton\\Live 11 Suite\\Program\\Live.exe',
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) return shell.openPath(found);
  return shell.openPath('C:\\ProgramData\\Ableton');
}

function installRemoteScript() {
  const src = path.join(__dirname, 'ableton_bridge');
  const dest = path.join(resolveRemoteScriptsDir(), 'ableton_bridge');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let filesCopied = 0;
  function copyDir(s, d) {
    fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(s)) {
      const sp = path.join(s, f), dp = path.join(d, f);
      if (fs.statSync(sp).isDirectory()) copyDir(sp, dp);
      else { fs.copyFileSync(sp, dp); filesCopied++; }
    }
  }
  copyDir(src, dest);
  return { destPath: dest, filesCopied, replaced: true, restart: { status: 'pending' } };
}
