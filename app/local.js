const api = window.bridge;
const $ = (s) => document.querySelector(s);

let lastResult = null;

function setBadge(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'badge ' + (cls || '');
}

async function refresh() {
  const ableton = await api.detectAbleton();
  setBadge('#ableton-status', ableton.running ? 'running' : 'not running', ableton.running ? 'ok' : 'err');
  const osc = await api.oscPing();
  setBadge('#osc-status', osc ? 'connected' : 'not connected', osc ? 'ok' : 'warn');
  const pill = $('#ableton-pill');
  pill.classList.toggle('off', !osc);
  const dir = await api.remoteScriptsDir();
  $('#scripts-dir').textContent = dir;
}

async function loadSettings() {
  const s = await api.getSettings();
  if (s.elevenlabsApiKey) $('#api-key').value = s.elevenlabsApiKey;
}

$('#btn-refresh').addEventListener('click', refresh);
$('#btn-install').addEventListener('click', async () => {
  try {
    const r = await api.installRemoteScript();
    alert('installed to: ' + r.dest);
    refresh();
  } catch (e) { alert('install failed: ' + e.message); }
});

$('#btn-save-key').addEventListener('click', async () => {
  await api.saveSettings({ elevenlabsApiKey: $('#api-key').value });
  $('#key-status').textContent = 'saved locally.';
  $('#key-status').className = 'status';
});

$('#duration').addEventListener('input', (e) => {
  $('#duration-val').textContent = e.target.value + 's';
});

$('#btn-generate').addEventListener('click', async () => {
  const btn = $('#btn-generate');
  btn.disabled = true;
  $('#gen-status').textContent = 'generating...';
  $('#gen-status').className = 'status';
  try {
    const r = await api.generateMusic({
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
  if (lastResult) api.openPath(lastResult);
});

$('#btn-send-ableton').addEventListener('click', async () => {
  if (!lastResult) return;
  $('#send-status').textContent = 'sending...';
  $('#send-status').className = 'status';
  try {
    const trackIndex = parseInt($('#track-index').value, 10);
    const clipIndex = parseInt($('#clip-index').value, 10);
    if (trackIndex >= 0) {
      const tracks = await api.trackCount();
      if (trackIndex >= tracks) throw new Error(`track ${trackIndex} out of range (0-${tracks - 1})`);
    }
    const r = await api.loadFileIntoSlot({ trackIndex, clipIndex, filePath: lastResult });
    $('#send-status').textContent = `loaded into track ${r.trackIndex}, slot ${clipIndex}.`;
  } catch (e) {
    $('#send-status').textContent = 'error: ' + e.message;
    $('#send-status').className = 'status err';
  }
});

$('#btn-settings').addEventListener('click', () => {
  document.querySelector('.local-side').scrollIntoView({ behavior: 'smooth' });
});

refresh();
loadSettings();
