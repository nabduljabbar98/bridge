const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { exec } = require('child_process');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function resolveRemoteScriptsDir() {
  // Try Ableton prefs
  const prefsRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'Ableton');
  try {
    if (fs.existsSync(prefsRoot)) {
      const versions = fs.readdirSync(prefsRoot).filter(v => /^Live \d/.test(v)).sort().reverse();
      for (const v of versions) {
        const cfg = path.join(prefsRoot, v, 'Preferences', 'Library.cfg');
        if (fs.existsSync(cfg)) {
          const xml = fs.readFileSync(cfg, 'utf8');
          const m = xml.match(/ProjectPath[^>]*Value="([^"]+)"[\s\S]*?ProjectName[^>]*Value="([^"]+)"/);
          if (m && m[1] && m[2] && m[2] !== '.' && m[2] !== '..') {
            return path.join(m[1], m[2], 'Remote Scripts');
          }
        }
      }
    }
  } catch {}
  return path.join(os.homedir(), 'Documents', 'Ableton', 'User Library', 'Remote Scripts');
}

function detectAbleton() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq Live.exe" /NH', (err, stdout) => {
      const running = !err && /Live\.exe/i.test(stdout);
      resolve({ running });
    });
  });
}

// --- OSC client -----------------------------------------------------------
// Ableton's remote script listens on 11000 and replies to 11001.
const OSC_SEND_PORT = 11000;
const OSC_REPLY_PORT = 11001;

let oscSocket = null;
const oscPending = new Map(); // address -> { resolve, timer }

function getOscSocket() {
  if (oscSocket) return oscSocket;
  oscSocket = dgram.createSocket('udp4');
  oscSocket.on('message', (buf) => {
    const addr = readOscString(buf, 0);
    const key = addr.str;
    const waiter = oscPending.get(key);
    if (waiter) {
      oscPending.delete(key);
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
        if (expectReply) { oscPending.delete(address); clearTimeout(oscPending.get(address)?.timer); }
        reject(err);
      } else if (!expectReply) {
        resolve(true);
      }
    });
  });
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
  await oscSend('/live/clip_slot/load_file', [trackIndex, clipIndex, filePath], { expectReply: false });
  return { ok: true };
}

function buildOscMessage(address, args) {
  // OSC string: address + type tag + args
  function oscStr(s) {
    const b = Buffer.from(s + '\0');
    const pad = 4 - (b.length % 4);
    return Buffer.concat([b, Buffer.alloc(pad === 4 ? 0 : pad)]);
  }
  let typeTag = ',';
  const argBufs = [];
  for (const a of args) {
    if (typeof a === 'string') { typeTag += 's'; argBufs.push(oscStr(a)); }
    else if (typeof a === 'number') { if (Number.isInteger(a)) { typeTag += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); argBufs.push(b); } else { typeTag += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b); } }
  }
  typeTag += '\0';
  const ttBuf = oscStr(typeTag);
  return Buffer.concat([oscStr(address), ttBuf, ...argBufs]);
}
function readOscString(buf, offset) {
  let end = offset;
  while (buf[end] !== 0) end++;
  const str = buf.slice(offset, end).toString('ascii');
  const next = end + 1;
  const pad = 4 - (next % 4);
  return { str, next: next + (pad === 4 ? 0 : pad) };
}

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960, height: 680,
    minWidth: 720, minHeight: 520,
    title: 'Bridge',
    backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, s) => { saveSettings({ ...loadSettings(), ...s }); return true; });
ipcMain.handle('detect-ableton', () => detectAbleton());
ipcMain.handle('osc-ping', () => oscPing());
ipcMain.handle('remote-scripts-dir', () => resolveRemoteScriptsDir());
ipcMain.handle('install-remote-script', async () => {
  const src = path.join(__dirname, 'ableton_bridge');
  const dest = path.join(resolveRemoteScriptsDir(), 'ableton_bridge');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // copy
  function copyDir(s, d) {
    fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(s)) {
      const sp = path.join(s, f), dp = path.join(d, f);
      if (fs.statSync(sp).isDirectory()) copyDir(sp, dp); else fs.copyFileSync(sp, dp);
    }
  }
  copyDir(src, dest);
  return { ok: true, dest };
});
ipcMain.handle('generate-music', async (_e, opts) => {
  const settings = loadSettings();
  const apiKey = settings.elevenlabsApiKey || opts.apiKey;
  if (!apiKey) throw new Error('ElevenLabs API key not set');
  const music = require('./elevenlabs/music.js');
  const outDir = path.join(app.getPath('music'), 'Bridge', 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `gen-${Date.now()}.mp3`;
  const dest = path.join(outDir, fileName);
  await music.composeToFile({ apiKey, prompt: opts.prompt, musicLengthMs: opts.durationMs, modelId: opts.modelId, forceInstrumental: opts.instrumental }, dest);
  return { ok: true, path: dest };
});
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('track-count', () => getTrackCount());
ipcMain.handle('load-file-into-slot', (_e, { trackIndex, clipIndex, filePath }) => loadFileIntoSlot(trackIndex, clipIndex, filePath));
