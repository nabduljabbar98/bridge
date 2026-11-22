const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  detectAbleton: () => ipcRenderer.invoke('detect-ableton'),
  oscPing: () => ipcRenderer.invoke('osc-ping'),
  remoteScriptsDir: () => ipcRenderer.invoke('remote-scripts-dir'),
  installRemoteScript: () => ipcRenderer.invoke('install-remote-script'),
  generateMusic: (opts) => ipcRenderer.invoke('generate-music', opts),
  trackCount: () => ipcRenderer.invoke('track-count'),
  loadFileIntoSlot: (opts) => ipcRenderer.invoke('load-file-into-slot', opts),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
