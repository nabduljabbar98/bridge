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

// Minimal OSC client: send a message, wait for reply on response port
function oscPing(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const msg = buildOscMessage('/live/ping', []);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { sock.close(); } catch {} resolve(false); } }, timeoutMs);
    sock.on('message', (buf) => {
      // parse address
      const addr = readOscString(buf, 0);
      if (addr.str === '/live/ping' && !done) {
        done = true; clearTimeout(timer); try { sock.close(); } catch {} resolve(true);
      }
    });
    sock.bind(11001, '127.0.0.1', () => {
      sock.send(msg, 11000, '127.0.0.1');
    });
  });
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
