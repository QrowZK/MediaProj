'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');

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

const MIME_BY_EXT = {
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.alac': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack', '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

function registerAuralisProtocol() {
  const { Readable } = require('stream');
  protocol.handle('auralis', async (request) => {
    try {
      const url = new URL(request.url);
      // auralis://media/<base64url-encoded absolute path>
      const encoded = url.pathname.replace(/^\//, '');
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8');
      const ext = path.extname(filePath).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext) && !filePath.startsWith(ART_CACHE_DIR())) {
        return new Response('Forbidden', { status: 403 });
      }

      const stat = await fsp.stat(filePath);
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };

      // Serve Range requests ourselves (206) so the media element can seek.
      const range = request.headers.get('range');
      const match = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? parseInt(match[1], 10) : Math.max(0, stat.size - parseInt(match[2], 10));
        const end = match[1] && match[2]
          ? Math.min(parseInt(match[2], 10), stat.size - 1)
          : stat.size - 1;
        if (start >= stat.size || start > end) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          });
        }
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }

      const stream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
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
function httpRequest(url, { method = 'GET', body = null, headers = {} } = {}, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    const allHeaders = {
      'User-Agent': 'Auralis/1.2 (desktop music player)',
      Accept: '*/*',
      ...headers,
    };
    if (body) allHeaders['Content-Length'] = Buffer.byteLength(body);
    const onResponse = (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpRequest(new URL(res.headers.location, target).toString(),
          { method: 'GET', headers }, redirects - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    };
    const sendRequest = (socket) => {
      const options = {
        host: target.hostname, servername: target.hostname,
        path: target.pathname + target.search, method, headers: allHeaders,
      };
      if (socket) {
        options.agent = false;
        options.createConnection = () => socket;
      }
      const req = https.request(options, (r) => {
        if (socket) r.on('end', () => socket.destroy());
        onResponse(r);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      if (body) req.write(body);
      req.end();
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
        sendRequest(socket);
      });
      connectReq.on('error', reject);
      connectReq.setTimeout(15000, () => connectReq.destroy(new Error('proxy timeout')));
      connectReq.end();
    } else {
      sendRequest(null);
    }
  });
}

// GETs are idempotent — retry once on a transient stall or reset.
async function httpGet(url) {
  try {
    return await httpRequest(url);
  } catch {
    return httpRequest(url);
  }
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
// Last.fm scrobbling (user supplies their own API key/secret; browser auth)
// ---------------------------------------------------------------------------

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const SCROBBLE_QUEUE_FILE = () => path.join(app.getPath('userData'), 'scrobble-queue.json');

function lastfmSign(params, secret) {
  const sig = Object.keys(params).sort()
    .filter((k) => k !== 'format' && k !== 'callback')
    .map((k) => k + params[k]).join('') + secret;
  return crypto.createHash('md5').update(sig, 'utf8').digest('hex');
}

async function lastfmCall(method, params, creds, { signed = true, post = false } = {}) {
  const all = { method, api_key: creds.apiKey, ...params };
  if (signed) all.api_sig = lastfmSign(all, creds.apiSecret);
  all.format = 'json';
  const form = Object.entries(all)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const res = post
    ? await httpRequest(LASTFM_API, {
        method: 'POST', body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    : await httpGet(LASTFM_API + '?' + form);
  const json = JSON.parse(res.buffer.toString('utf8'));
  if (json.error) throw new Error(json.message || 'Last.fm error ' + json.error);
  return json;
}

let pendingAuthToken = null;

async function lastfmStartAuth(creds) {
  const { token } = await lastfmCall('auth.getToken', {}, creds);
  pendingAuthToken = token;
  shell.openExternal(
    `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(creds.apiKey)}&token=${encodeURIComponent(token)}`);
  return true;
}

async function lastfmCompleteAuth(creds) {
  if (!pendingAuthToken) throw new Error('No authorization in progress');
  const res = await lastfmCall('auth.getSession', { token: pendingAuthToken }, creds);
  pendingAuthToken = null;
  return { sessionKey: res.session.key, username: res.session.name };
}

async function lastfmNowPlaying(creds, track) {
  const params = { artist: track.artist, track: track.title, sk: creds.sessionKey };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(Math.round(track.duration));
  await lastfmCall('track.updateNowPlaying', params, creds, { post: true });
}

async function lastfmScrobble(creds, scrobbles) {
  const params = { sk: creds.sessionKey };
  scrobbles.forEach((s, i) => {
    params[`artist[${i}]`] = s.artist;
    params[`track[${i}]`] = s.title;
    params[`timestamp[${i}]`] = String(s.timestamp);
    if (s.album) params[`album[${i}]`] = s.album;
    if (s.duration) params[`duration[${i}]`] = String(Math.round(s.duration));
  });
  await lastfmCall('track.scrobble', params, creds, { post: true });
}

// Queue scrobbles on disk so offline listens are submitted later.
async function submitScrobble(creds, scrobble) {
  const queue = await readJson(SCROBBLE_QUEUE_FILE(), []);
  queue.push(scrobble);
  // Last.fm accepts up to 50 per batch
  try {
    await lastfmScrobble(creds, queue.slice(0, 50));
    const rest = queue.slice(50);
    await writeJson(SCROBBLE_QUEUE_FILE(), rest);
    return { submitted: Math.min(queue.length, 50), queued: rest.length };
  } catch (err) {
    await writeJson(SCROBBLE_QUEUE_FILE(), queue.slice(-500)); // cap the backlog
    return { submitted: 0, queued: queue.length, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Lyrics: side files (.lrc/.txt) → embedded tags → LRCLIB lookup
// ---------------------------------------------------------------------------

const LYRICS_CACHE_FILE = () => path.join(app.getPath('userData'), 'lyrics-cache.json');
let lyricsCache = null;

async function loadLyricsCache() {
  if (!lyricsCache) lyricsCache = await readJson(LYRICS_CACHE_FILE(), {});
  return lyricsCache;
}

async function getLyrics(track) {
  // 1. Side files next to the audio: same basename, .lrc preferred over .txt
  const base = track.path.replace(/\.[^.]+$/, '');
  for (const ext of ['.lrc', '.txt']) {
    try {
      const text = await fsp.readFile(base + ext, 'utf8');
      if (text.trim()) return { text, synced: ext === '.lrc', source: 'file' };
    } catch { /* not there */ }
  }

  // 2. Embedded lyrics tag
  try {
    const mm = await loadMusicMetadata();
    const meta = await mm.parseFile(track.path, { skipCovers: true });
    const lyr = meta?.common?.lyrics?.[0];
    const text = typeof lyr === 'string' ? lyr : (lyr?.text || lyr?.syncText?.map((l) => l.text).join('\n'));
    if (text && text.trim()) {
      return { text, synced: /\[\d{1,2}:\d{2}/.test(text), source: 'embedded' };
    }
  } catch { /* unparseable */ }

  // 3. LRCLIB (no API key, community-run)
  const cache = await loadLyricsCache();
  const key = `${track.artist}::${track.title}`.toLowerCase();
  if (cache[key] !== undefined) {
    return cache[key] ? { ...cache[key], source: 'lrclib' } : null;
  }
  try {
    const url = 'https://lrclib.net/api/search?artist_name=' +
      encodeURIComponent(track.artist) + '&track_name=' + encodeURIComponent(track.title);
    const res = await httpGet(url);
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const hits = JSON.parse(res.buffer.toString('utf8'));
    // Prefer a duration match (±4s), then any synced hit, then first
    const byDuration = hits.find((h) =>
      track.duration && h.duration && Math.abs(h.duration - track.duration) <= 4);
    const hit = byDuration || hits.find((h) => h.syncedLyrics) || hits[0];
    const entry = hit && (hit.syncedLyrics || hit.plainLyrics)
      ? { text: hit.syncedLyrics || hit.plainLyrics, synced: !!hit.syncedLyrics }
      : null;
    cache[key] = entry;
    await writeJson(LYRICS_CACHE_FILE(), cache);
    return entry ? { ...entry, source: 'lrclib' } : null;
  } catch {
    return null; // offline — don't cache, retry next time
  }
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

  ipcMain.handle('lyrics:get', (_e, track) => getLyrics(track));

  ipcMain.handle('lastfm:start-auth', (_e, creds) => lastfmStartAuth(creds));
  ipcMain.handle('lastfm:complete-auth', (_e, creds) => lastfmCompleteAuth(creds));
  ipcMain.handle('lastfm:now-playing', async (_e, creds, track) => {
    try { await lastfmNowPlaying(creds, track); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('lastfm:scrobble', (_e, creds, scrobble) => submitScrobble(creds, scrobble));

  ipcMain.handle('window:mini', (_e, on) => setMiniMode(on));

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
// Native output engine (ASIO / WASAPI / DirectSound via RtAudio + ffmpeg)
// ---------------------------------------------------------------------------

const { NativeAudioEngine } = require('./native-engine');
let nativeEngine = null;

function getNativeEngine() {
  if (!nativeEngine) {
    nativeEngine = new NativeAudioEngine((channel, payload) => {
      mainWindow?.webContents.send(channel, payload);
    });
  }
  return nativeEngine;
}

function registerNativeIpc() {
  ipcMain.handle('native:available', () => getNativeEngine().available);
  ipcMain.handle('native:apis', () => getNativeEngine().listApis());
  ipcMain.handle('native:devices', (_e, apiId) => getNativeEngine().listDevices(apiId));
  ipcMain.handle('native:config', (_e, partial) => getNativeEngine().setConfig(partial));
  ipcMain.handle('native:play', async (_e, track, startAt) => {
    try { await getNativeEngine().play(track, startAt || 0); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('native:pause', () => getNativeEngine().pause());
  ipcMain.handle('native:resume', () => getNativeEngine().resume());
  ipcMain.handle('native:seek', (_e, time) => getNativeEngine().seek(time));
  ipcMain.handle('native:set-next', (_e, track) => getNativeEngine().setNext(track));
  ipcMain.handle('native:stop', () => getNativeEngine().stopAll());
  ipcMain.handle('native:position', () => getNativeEngine().getPosition());
  ipcMain.handle('native:signal-path', () => getNativeEngine().getSignalPath());
  ipcMain.handle('native:capabilities', () => ({
    available: getNativeEngine().available,
    wasapiExclusive: getNativeEngine().wasapiExclusiveAvailable,
  }));

  ipcMain.handle('dsp:choose-ir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Load Impulse Response',
      filters: [{ name: 'Impulse response (WAV)', extensions: ['wav'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const irPath = res.filePaths[0];
    return { path: irPath, url: toMediaUrl(irPath), name: path.basename(irPath) };
  });
}

// ---------------------------------------------------------------------------
// Auto-update (GitHub Releases via electron-updater)
// ---------------------------------------------------------------------------

let updater = null;

function setupAutoUpdater() {
  // In dev there is no app-update.yml and nothing to update against.
  if (app.isPackaged) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true; // "Later" still updates on next quit
      updater.on('update-downloaded', (info) => {
        mainWindow?.webContents.send('update:ready', { version: info.version });
      });
      updater.on('error', () => { /* offline or rate-limited — try again next launch */ });
    } catch {
      updater = null;
    }
  }

  ipcMain.handle('update:check', async () => {
    if (!updater) return { supported: false };
    try {
      const res = await updater.checkForUpdates();
      const available = !!res?.updateInfo &&
        res.updateInfo.version !== app.getVersion();
      return { supported: true, available, version: res?.updateInfo?.version || null };
    } catch (err) {
      return { supported: true, available: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', () => {
    if (updater) setImmediate(() => updater.quitAndInstall());
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // Silent startup check, unless the user turned auto-updates off.
  if (updater) {
    readJson(SETTINGS_FILE(), {}).then((s) => {
      if (s.autoUpdate !== false) updater.checkForUpdates().catch(() => {});
    });
  }
}

// ---------------------------------------------------------------------------
// Mini player mode
// ---------------------------------------------------------------------------

const MINI_SIZE = [420, 148];
let savedBounds = null;

function setMiniMode(on) {
  if (!mainWindow) return false;
  if (on) {
    savedBounds = mainWindow.getBounds();
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setMinimumSize(MINI_SIZE[0], MINI_SIZE[1]);
    mainWindow.setSize(MINI_SIZE[0], MINI_SIZE[1]);
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setResizable(false);
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(980, 640);
    if (savedBounds) mainWindow.setBounds(savedBounds);
    else mainWindow.setSize(1440, 900);
  }
  return true;
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
  setupAutoUpdater();
  registerNativeIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
