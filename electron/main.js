'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
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
