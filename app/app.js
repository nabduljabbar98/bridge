const { bridge } = window;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function setBadge(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'badge ' + (cls || '');
}

async function refreshStatus() {
  const ableton = await bridge.detectAbleton();
  setBadge('#ableton-status', ableton.running ? 'running' : 'not running', ableton.running ? 'ok' : 'err');
  const osc = await bridge.oscPing();
  setBadge('#osc-status', osc ? 'connected' : 'not connected', osc ? 'ok' : 'warn');
  const dir = await bridge.remoteScriptsDir();
  $('#scripts-dir').textContent = dir;
  $('#scripts-folder').value = dir;
  // check if installed
  try {
    const fs = null;
  } catch {}
  setBadge('#script-status', 'check manually', 'warn');
}

// nav
$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const screen = btn.dataset.screen;
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#screen-' + screen).classList.add('active');
  });
});

$('#btn-refresh-status').addEventListener('click', refreshStatus);

$('#btn-install-script').addEventListener('click', async () => {
  try {
    const r = await bridge.installRemoteScript();
    alert('installed to: ' + r.dest);
    refreshStatus();
  } catch (e) { alert('install failed: ' + e.message); }
});

// settings
(async () => {
  const s = await bridge.getSettings();
  if (s.elevenlabsApiKey) $('#api-key').value = s.elevenlabsApiKey;
  const dir = await bridge.remoteScriptsDir();
  $('#scripts-folder').value = dir;
})();

$('#btn-save-settings').addEventListener('click', async () => {
  await bridge.saveSettings({ elevenlabsApiKey: $('#api-key').value });
  $('#settings-status').textContent = 'saved.';
  $('#settings-status').className = 'status';
});

// duration slider
$('#duration').addEventListener('input', (e) => {
  $('#duration-val').textContent = e.target.value + 's';
});

// generate
let lastResult = null;
$('#btn-generate').addEventListener('click', async () => {
  const btn = $('#btn-generate');
  btn.disabled = true;
  $('#gen-status').textContent = 'generating...';
  $('#gen-status').className = 'status';
  try {
    const r = await bridge.generateMusic({
      prompt: $('#prompt').value,
      durationMs: parseInt($('#duration').value, 10) * 1000,
      modelId: $('#model').value,
      instrumental: $('#instrumental').checked,
    });
    lastResult = r.path;
    $('#result-card').hidden = false;
    $('#result-audio').src = 'file://' + r.path.replace(/\\/g, '/');
    $('#gen-status').textContent = 'done.';
  } catch (e) {
    $('#gen-status').textContent = 'error: ' + e.message;
    $('#gen-status').className = 'status err';
  } finally {
    btn.disabled = false;
  }
});

$('#btn-open-result').addEventListener('click', () => {
  if (lastResult) bridge.openPath(lastResult);
});

refreshStatus();
