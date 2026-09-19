'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedWindowActions = new Set(['minimize', 'toggleMaximize', 'close']);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

contextBridge.exposeInMainWorld('nightlight', Object.freeze({
  windowAction(action) {
    if (!allowedWindowActions.has(action)) return Promise.resolve(false);
    return ipcRenderer.invoke('nightlight:window', action);
  },
  getAppInfo() {
    return ipcRenderer.invoke('nightlight:app-info');
  },
  openExternal(url) {
    return ipcRenderer.invoke('nightlight:open-external', text(url, 2048));
  },
  retryConnection() {
    return ipcRenderer.invoke('nightlight:retry-connection');
  },
  openSteam() {
    return ipcRenderer.invoke('nightlight:steam-open');
  },
  openWindowsSecurityExclusions() {
    return ipcRenderer.invoke('nightlight:windows-security-exclusions');
  },
  onWindowState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(Object.freeze({
      maximized: Boolean(state && state.maximized),
    }));
    ipcRenderer.on('nightlight:window-state', listener);
    return () => ipcRenderer.removeListener('nightlight:window-state', listener);
  },
  getSteamInfo() {
    return ipcRenderer.invoke('nightlight:steam-info');
  },
  getSteamPath() {
    return ipcRenderer.invoke('nightlight:steam-path-get');
  },
  setSteamPath(path) {
    return ipcRenderer.invoke('nightlight:steam-path-set', text(path, 500));
  },
  detectGame(appId, executable) {
    return ipcRenderer.invoke(
      'nightlight:detect-game',
      text(String(appId ?? ''), 20),
      text(executable, 120),
    );
  },
  selectFolder() {
    return ipcRenderer.invoke('nightlight:select-folder');
  },
  validateFolder(folder, executable) {
    return ipcRenderer.invoke(
      'nightlight:validate-folder',
      text(folder, 500),
      text(executable, 120),
    );
  },
  getLocations() {
    return ipcRenderer.invoke('nightlight:locations-get');
  },
  saveLocation(appId, folder) {
    return ipcRenderer.invoke(
      'nightlight:location-set',
      text(String(appId ?? ''), 20),
      text(folder, 500),
    );
  },
  launchGame(options) {
    const input = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('nightlight:launch-game', {
      appId: text(String(input.appId ?? ''), 20),
      folder: text(input.folder, 500),
      executable: text(input.executable, 120),
      location: text(input.location, 260),
      arguments: text(input.arguments, 500),
    });
  },
  trySteamLogin(username, password) {
    return ipcRenderer.invoke('nightlight:try-steam-login',
        String(username).trim(),
        String(password).trim()
    );
  },
  loginSteamAccount(username, password) {
    return ipcRenderer.invoke('nightlight:steam-login-account',
        String(username).trim(),
        String(password).trim()
    );
  },
  fileExists(filePath) {
    return ipcRenderer.invoke('nightlight:file-exists', text(filePath, 500));
  },
  downloadAndExtractZip(url, folder, password) {
    return ipcRenderer.invoke('nightlight:download-extract-zip',
        text(url, 2048),
        text(folder, 500),
        password ? String(password).slice(0, 128) : ''
    );
  },
  downloadAndExtractZipProgress(url, folder, password, progressCallback) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const channel = `nightlight:download-progress-${id}`;
    const handler = (_event, data) => {
        if (typeof progressCallback === 'function') {
            progressCallback(data);
        }
    };
    ipcRenderer.on(channel, handler);
    return ipcRenderer.invoke('nightlight:download-extract-zip-progress',
        text(url, 2048),
        text(folder, 500),
        password ? String(password).slice(0, 128) : '',
        id
    ).finally(() => {
        ipcRenderer.removeListener(channel, handler);
    });
  },
  checkSteamTool(steamPath) {
    return ipcRenderer.invoke('nightlight:check-steam-tool', text(steamPath, 500));
  },
  writeFile(filePath, content) {
    return ipcRenderer.invoke('nightlight:write-file', text(filePath, 500), typeof content === 'string' ? content : '');
  },
  writeLua(steamPath, appId, content) {
    return ipcRenderer.invoke('nightlight:write-lua', text(steamPath, 500), text(String(appId ?? ''), 20), typeof content === 'string' ? content : '');
  },
  getMachineGuid() {
    return ipcRenderer.invoke('nightlight:machine-guid');
  },
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),

  // ---- Windows Defender exclusions (UAC prompt + nl.winexc marker) ----
  addWindowsExclusion:    (folderPath) => ipcRenderer.invoke('nightlight:add-windows-exclusion',    text(folderPath, 500)),
  removeWindowsExclusion: (folderPath) => ipcRenderer.invoke('nightlight:remove-windows-exclusion', text(folderPath, 500)),
  getWindowsExclusionStatus: (folderPath) => ipcRenderer.invoke('nightlight:get-windows-exclusion-status', text(folderPath, 500)),

  // ---- In-app key window ----
  openKeyWindow() {
    return ipcRenderer.invoke('nightlight:open-key-window');
  },
  onKeyReceived(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, key) => {
      try { callback(typeof key === 'string' ? key : ''); } catch (e) {}
    };
    ipcRenderer.on('nightlight:key-received', listener);
    return () => ipcRenderer.removeListener('nightlight:key-received', listener);
  },
}));