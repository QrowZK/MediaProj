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
  dsp: {
    chooseIr: () => ipcRenderer.invoke('dsp:choose-ir'),
  },
  upnp: {
    serverConfig: (partial) => ipcRenderer.invoke('upnp:server-config', partial),
    serverStatus: () => ipcRenderer.invoke('upnp:server-status'),
    playlistsSnapshot: (s) => ipcRenderer.invoke('upnp:playlists-snapshot', s),
    discoverRenderers: () => ipcRenderer.invoke('upnp:discover-renderers'),
    zoneSelect: (location) => ipcRenderer.invoke('upnp:zone-select', location),
    zonePlay: (track, startAt) => ipcRenderer.invoke('upnp:zone-play', track, startAt),
    zonePause: () => ipcRenderer.invoke('upnp:zone-pause'),
    zoneResume: () => ipcRenderer.invoke('upnp:zone-resume'),
    zoneSeek: (s) => ipcRenderer.invoke('upnp:zone-seek', s),
    zoneSetNext: (track) => ipcRenderer.invoke('upnp:zone-set-next', track),
    zoneVolume: (v) => ipcRenderer.invoke('upnp:zone-volume', v),
    zoneStop: () => ipcRenderer.invoke('upnp:zone-stop'),
    on: (channel, cb) => {
      const allowed = ['upnp:progress', 'upnp:track-ended', 'upnp:track-changed',
                       'upnp:state', 'upnp:error'];
      if (!allowed.includes(channel)) return () => {};
      const listener = (_e, data) => cb(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  native: {
    available: () => ipcRenderer.invoke('native:available'),
    capabilities: () => ipcRenderer.invoke('native:capabilities'),
    signalPath: () => ipcRenderer.invoke('native:signal-path'),
    apis: () => ipcRenderer.invoke('native:apis'),
    devices: (apiId) => ipcRenderer.invoke('native:devices', apiId),
    config: (partial) => ipcRenderer.invoke('native:config', partial),
    play: (track, startAt) => ipcRenderer.invoke('native:play', track, startAt),
    pause: () => ipcRenderer.invoke('native:pause'),
    resume: () => ipcRenderer.invoke('native:resume'),
    seek: (time) => ipcRenderer.invoke('native:seek', time),
    setNext: (track) => ipcRenderer.invoke('native:set-next', track),
    stop: () => ipcRenderer.invoke('native:stop'),
    position: () => ipcRenderer.invoke('native:position'),
    on: (channel, cb) => {
      const allowed = ['native:progress', 'native:track-ended', 'native:track-changed',
                       'native:state', 'native:error', 'native:viz', 'native:signal-path'];
      if (!allowed.includes(channel)) return () => {};
      const listener = (_e, data) => cb(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
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
