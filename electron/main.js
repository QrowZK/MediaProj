'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.alac', '.ape', '.wv',
  '.dsf', '.dff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma',
]);

const LOSSLESS_EXTENSIONS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.alac', '.ape', '.wv', '.dsf', '.dff',
]);

const LIBRARY_FILE = () => path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const PLAYLISTS_FILE = () => path.join(app.getPath('userData'), 'playlists.json');
const STATS_FILE = () => path.join(app.getPath('userData'), 'stats.json');
const ARTIST_INFO_FILE = () => path.join(app.getPath('userData'), 'artist-info.json');
const ART_CACHE_DIR = () => path.join(app.getPath('userData'), 'art-cache');

let mainWindow = null;
let scanCancelled = false;

// music-metadata is ESM-only; load it lazily via dynamic import.
let mmPromise = null;
function loadMusicMetadata() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

// ---------------------------------------------------------------------------
// Privileged protocol for streaming local audio / artwork with Range support
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'auralis',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

function registerAuralisProtocol() {
  protocol.handle('auralis', (request) => {
    try {
      const url = new URL(request.url);
      // auralis://media/<base64url-encoded absolute path>
      const encoded = url.pathname.replace(/^\//, '');
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
          !filePath.startsWith(ART_CACHE_DIR())) {
        return new Response('Forbidden', { status: 403 });
      }
      // net.fetch on a file:// URL handles Range requests + streaming.
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
    } catch (err) {
      return new Response('Bad request: ' + err.message, { status: 400 });
    }
  });
}

function toMediaUrl(filePath) {
  return 'auralis://media/' + Buffer.from(filePath, 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// JSON persistence helpers
// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Library scanning
// ---------------------------------------------------------------------------

async function* walkAudioFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAudioFiles(full);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function cacheAlbumArt(pictures, albumKey) {
  if (!pictures || pictures.length === 0) return null;
  try {
    await fsp.mkdir(ART_CACHE_DIR(), { recursive: true });
    const pic = pictures.find((p) => /front|cover/i.test(p.type || '')) || pictures[0];
    const ext = /png/i.test(pic.format || '') ? '.png' : '.jpg';
    const file = path.join(ART_CACHE_DIR(), hashString(albumKey) + ext);
    if (!fs.existsSync(file)) await fsp.writeFile(file, Buffer.from(pic.data));
    return toMediaUrl(file);
  } catch {
    return null;
  }
}

async function extractTrack(mm, filePath, existingArtByAlbum) {
  const stat = await fsp.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let meta = null;
  try {
    meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
  } catch {
    // Unparseable — fall back to filename-derived info.
  }

  const c = meta?.common || {};
  const f = meta?.format || {};
  const artist = c.artist || c.albumartist || 'Unknown Artist';
  const albumArtist = c.albumartist || c.artist || 'Unknown Artist';
  const album = c.album || path.basename(path.dirname(filePath)) || 'Unknown Album';
  const albumKey = `${albumArtist}::${album}`.toLowerCase();

  let artUrl = existingArtByAlbum.get(albumKey);
  if (artUrl === undefined) {
    artUrl = await cacheAlbumArt(c.picture, albumKey);
    existingArtByAlbum.set(albumKey, artUrl);
  }

  return {
    id: hashString(filePath),
    path: filePath,
    url: toMediaUrl(filePath),
    title: c.title || path.basename(filePath, ext),
    artist,
    albumArtist,
    album,
    albumKey,
    genre: (c.genre && c.genre[0]) || '',
    year: c.year || null,
    trackNo: c.track?.no || null,
    discNo: c.disk?.no || null,
    duration: f.duration || 0,
    codec: f.codec || ext.slice(1).toUpperCase(),
    container: f.container || '',
    sampleRate: f.sampleRate || null,
    bitsPerSample: f.bitsPerSample || null,
    bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
    channels: f.numberOfChannels || null,
    lossless: f.lossless != null ? f.lossless : LOSSLESS_EXTENSIONS.has(ext),
    dsd: ext === '.dsf' || ext === '.dff',
    replayGainTrack: c.replaygain_track_gain?.dB ?? null,
    replayGainAlbum: c.replaygain_album_gain?.dB ?? null,
    artUrl: artUrl || null,
    fileSize: stat.size,
    mtime: stat.mtimeMs,
    added: Date.now(),
  };
}

async function scanFolders(folders) {
  scanCancelled = false;
  const mm = await loadMusicMetadata();
  const existing = await readJson(LIBRARY_FILE(), { folders: [], tracks: [] });
  const byPath = new Map(existing.tracks.map((t) => [t.path, t]));
  const artByAlbum = new Map();
  for (const t of existing.tracks) {
    if (t.artUrl) artByAlbum.set(t.albumKey, t.artUrl);
  }

  const allFiles = [];
  for (const folder of folders) {
    for await (const file of walkAudioFiles(folder)) {
      allFiles.push(file);
      if (allFiles.length % 200 === 0) {
        mainWindow?.webContents.send('scan:progress', {
          phase: 'discover', found: allFiles.length,
        });
      }
      if (scanCancelled) return null;
    }
  }

  const tracks = [];
  for (let i = 0; i < allFiles.length; i++) {
    if (scanCancelled) return null;
    const file = allFiles[i];
    const prev = byPath.get(file);
    try {
      if (prev && prev.mtime === (await fsp.stat(file)).mtimeMs) {
        tracks.push(prev);
      } else {
        tracks.push(await extractTrack(mm, file, artByAlbum));
      }
    } catch {
      // skip unreadable file
    }
    if (i % 20 === 0 || i === allFiles.length - 1) {
      mainWindow?.webContents.send('scan:progress', {
        phase: 'read', done: i + 1, total: allFiles.length, file: path.basename(file),
      });
    }
  }

  const library = { folders, tracks, updated: Date.now() };
  await writeJson(LIBRARY_FILE(), library);
  return library;
}

// ---------------------------------------------------------------------------
// Online artist info (photo via Deezer, biography via Wikipedia)
// ---------------------------------------------------------------------------

let artistIndex = null;

async function loadArtistIndex() {
  if (!artistIndex) artistIndex = await readJson(ARTIST_INFO_FILE(), {});
  return artistIndex;
}

// Plain Node HTTPS client with CONNECT tunneling when HTTPS_PROXY is set —
// works on direct connections and behind corporate proxies alike.
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    const headers = { 'User-Agent': 'Auralis/1.1 (desktop music player)', Accept: '*/*' };
    const onResponse = (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, target).toString(), redirects - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    };
    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      const connectReq = http.request({
        host: proxy.hostname, port: proxy.port, method: 'CONNECT',
        path: `${target.hostname}:443`,
      });
      connectReq.on('connect', (res, socket) => {
        socket.on('error', () => {}); // tunnel teardown after response is fine
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error('Proxy CONNECT ' + res.statusCode));
        }
        const req = https.request({
          host: target.hostname, servername: target.hostname,
          path: target.pathname + target.search, headers,
          agent: false, createConnection: () => socket,
        }, (r) => { r.on('end', () => socket.destroy()); onResponse(r); });
        req.on('error', reject);
        req.end();
      });
      connectReq.on('error', reject);
      connectReq.setTimeout(15000, () => connectReq.destroy(new Error('proxy timeout')));
      connectReq.end();
    } else {
      const req = https.get(url, { headers }, onResponse);
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    }
  });
}

async function fetchJson(url) {
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  return JSON.parse(res.buffer.toString('utf8'));
}

async function downloadImage(url, file) {
  const res = await httpGet(url);
  if (res.status !== 200 || !res.buffer.length) return false;
  await fsp.mkdir(ART_CACHE_DIR(), { recursive: true });
  await fsp.writeFile(file, res.buffer);
  return true;
}

const MUSIC_DESC = /band|singer|musician|rapper|composer|songwriter|artist|duo|group|producer|violinist|pianist|guitarist|orchestra|ensemble|dj/i;

async function getArtistInfo(name) {
  const key = name.trim().toLowerCase();
  if (!key || key === 'unknown artist') return null;
  const index = await loadArtistIndex();
  const cached = index[key];
  if (cached) {
    return { ...cached, img: cached.imgFile ? toMediaUrl(cached.imgFile) : null };
  }

  const info = { bio: null, url: null, imgFile: null, ts: Date.now() };
  let deezerOk = false;
  let wikiOk = false;

  // Photo: Deezer artist search (no API key required)
  try {
    const dz = await fetchJson(
      'https://api.deezer.com/search/artist?q=' + encodeURIComponent(name) + '&limit=1');
    deezerOk = true;
    const hit = dz?.data?.[0];
    const imgUrl = hit?.picture_xl || hit?.picture_big;
    if (imgUrl) {
      const file = path.join(ART_CACHE_DIR(), 'artist-' + hashString(key) + '.jpg');
      if (await downloadImage(imgUrl, file)) info.imgFile = file;
    }
  } catch { /* offline or blocked — degrade gracefully */ }

  // Biography: Wikipedia — search first so bands with ambiguous names resolve
  try {
    const search = await fetchJson(
      'https://en.wikipedia.org/w/rest.php/v1/search/title?q=' +
      encodeURIComponent(name) + '&limit=5');
    wikiOk = true;
    const pages = search?.pages || [];
    const page = pages.find((p) => MUSIC_DESC.test(p.description || '')) || pages[0];
    if (page) {
      const sum = await fetchJson(
        'https://en.wikipedia.org/api/rest_v1/page/summary/' +
        encodeURIComponent(page.key) + '?redirect=true');
      if (sum?.extract && sum.type !== 'disambiguation') {
        info.bio = sum.extract;
        info.url = sum.content_urls?.desktop?.page || null;
        if (!info.imgFile && sum.originalimage?.source) {
          const file = path.join(ART_CACHE_DIR(), 'artist-' + hashString(key) + '.jpg');
          if (await downloadImage(sum.originalimage.source, file)) info.imgFile = file;
        }
      }
    }
  } catch { /* offline or blocked — degrade gracefully */ }

  // Cache the result (including "nothing found") only if the services answered,
  // so a temporary network failure doesn't stick.
  if (deezerOk || wikiOk) {
    index[key] = info;
    await writeJson(ARTIST_INFO_FILE(), index);
  }
  return { ...info, img: info.imgFile ? toMediaUrl(info.imgFile) : null };
}

async function getCachedArtistMap() {
  const index = await loadArtistIndex();
  const out = {};
  for (const [key, info] of Object.entries(index)) {
    out[key] = {
      img: info.imgFile ? toMediaUrl(info.imgFile) : null,
      hasBio: !!info.bio,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('library:get', () => readJson(LIBRARY_FILE(), { folders: [], tracks: [] }));

  ipcMain.handle('library:choose-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Music Folder',
      properties: ['openDirectory', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('library:scan', async (_e, folders) => scanFolders(folders));
  ipcMain.handle('library:cancel-scan', () => { scanCancelled = true; });

  ipcMain.handle('settings:get', () => readJson(SETTINGS_FILE(), {}));
  ipcMain.handle('settings:set', async (_e, settings) => writeJson(SETTINGS_FILE(), settings));

  ipcMain.handle('playlists:get', () => readJson(PLAYLISTS_FILE(), { playlists: [] }));
  ipcMain.handle('playlists:set', async (_e, data) => writeJson(PLAYLISTS_FILE(), data));

  ipcMain.handle('stats:get', () => readJson(STATS_FILE(), { plays: {}, lastPlayed: {} }));
  ipcMain.handle('stats:set', async (_e, data) => writeJson(STATS_FILE(), data));

  ipcMain.handle('artist:info', (_e, name) => getArtistInfo(String(name)));
  ipcMain.handle('artist:cached-map', () => getCachedArtistMap());

  ipcMain.handle('shell:show-item', (_e, filePath) => shell.showItemInFolder(filePath));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0b0c10',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Dev/CI smoke-test hook: AURALIS_SHOT=<file.png> captures the window and quits.
    if (process.env.AURALIS_SHOT) {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          await fsp.writeFile(process.env.AURALIS_SHOT, image.toPNG());
        } finally {
          app.quit();
        }
      }, 2500);
    }
  });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

Menu.setApplicationMenu(null);

// Honor environment proxies (corporate networks, sandboxes). Chromium picks up
// OS-level proxy settings natively; env vars need to be forwarded explicitly.
const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (envProxy) app.commandLine.appendSwitch('proxy-server', envProxy);

app.whenReady().then(async () => {
  registerAuralisProtocol();
  registerIpc();
  // Dev/CI hook: pre-scan a folder before the UI boots.
  if (process.env.AURALIS_SCAN_DIR) {
    await scanFolders([process.env.AURALIS_SCAN_DIR]);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
