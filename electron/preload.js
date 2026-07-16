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
  lyrics: {
    get: (track) => ipcRenderer.invoke('lyrics:get', track),
  },
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    version: () => ipcRenderer.invoke('app:version'),
    onReady: (cb) => {
      const listener = (_e, info) => cb(info);
      ipcRenderer.on('update:ready', listener);
      return () => ipcRenderer.removeListener('update:ready', listener);
    },
  },
  lastfm: {
    startAuth: (creds) => ipcRenderer.invoke('lastfm:start-auth', creds),
    completeAuth: (creds) => ipcRenderer.invoke('lastfm:complete-auth', creds),
    nowPlaying: (creds, track) => ipcRenderer.invoke('lastfm:now-playing', creds, track),
    scrobble: (creds, scrobble) => ipcRenderer.invoke('lastfm:scrobble', creds, scrobble),
  },
  shell: {
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    mini: (on) => ipcRenderer.invoke('window:mini', on),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized: (cb) => {
      const listener = (_e, v) => cb(v);
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
});
