'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auralis', {
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    chooseFolder: () => ipcRenderer.invoke('library:choose-folder'),
    scan: (folders) => ipcRenderer.invoke('library:scan', folders),
    cancelScan: () => ipcRenderer.invoke('library:cancel-scan'),
    onScanProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
  },
  playlists: {
    get: () => ipcRenderer.invoke('playlists:get'),
    set: (d) => ipcRenderer.invoke('playlists:set', d),
  },
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
    set: (d) => ipcRenderer.invoke('stats:set', d),
  },
  artist: {
    info: (name) => ipcRenderer.invoke('artist:info', name),
    cachedMap: () => ipcRenderer.invoke('artist:cached-map'),
  },
  shell: {
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized: (cb) => {
      const listener = (_e, v) => cb(v);
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
});
