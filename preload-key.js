'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nightlightKey', Object.freeze({
  returnToLauncher(key) {
    const value = typeof key === 'string' && key.length > 0 && key.length < 200 ? key : null;
    ipcRenderer.send('nightlight:key-window-return', value);
  },
  closeWindow() {
    ipcRenderer.send('nightlight:key-window-return', null);
  },
}));