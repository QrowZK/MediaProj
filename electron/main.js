'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { createJobQueue } = require('./library-jobs');
const {
  isUncPath, isAbsolutePath, isInsideDir, findLibraryTrack, isLibraryPath,
  isFresh, pruneCache, migrateLyricsCache, LYRICS_CACHE_LIMITS, LYRICS_MAX_ENTRY_CHARS,
  ARTIST_CACHE_LIMITS, splitLastfmSettings, encodeSecretRecord, decodeSecretRecord,
} = require('./hardening');

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
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.json');
const ARTIST_INFO_FILE = () => path.join(app.getPath('userData'), 'artist-info.json');
const ART_CACHE_DIR = () => path.join(app.getPath('userData'), 'art-cache');
// Main-owned: the page can't write these, unlike settings.json.
const LASTFM_CREDS_FILE = () => path.join(app.getPath('userData'), 'lastfm-credentials.json');
const DSP_IR_FILE = () => path.join(app.getPath('userData'), 'dsp-ir.json');

let mainWindow = null;
// Folders the user picked in an open-folder dialog this session.
const pickedFolders = new Set();
let activeExporter = null;
let activeLoudness = null;

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
      if (!isAbsolutePath(filePath)) return new Response('Forbidden', { status: 403 });
      const inArtCache = isInsideDir(ART_CACHE_DIR(), filePath);
      if (!AUDIO_EXTENSIONS.has(ext) && !inArtCache) {
        return new Response('Forbidden', { status: 403 });
      }
      // Network paths only for files the user put in the library or picked
      // as an impulse response: a page-chosen \\host\share URL would make
      // Windows authenticate to that host.
      if (isUncPath(filePath) && !isLibraryPath(await getCachedLibrary(), filePath) &&
          filePath !== (await trustedIrPath())) {
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

// Writes to the same file are serialized and use a unique tmp name so two
// concurrent saves can't race each other's rename.
const writeChains = new Map();
function writeJson(file, data) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, file);
  });
  writeChains.set(file, next);
  return next;
}

// ---------------------------------------------------------------------------
// Library scanning
// ---------------------------------------------------------------------------

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The scan runs in a WORKER THREAD: music-metadata parsing is CPU-heavy, and
// on the main loop it starves the audio pump (WASAPI ring refills, IPC,
// progress) — a rescan during playback caused pops and error cascades.
let activeScan = null; // { worker, promise, abort } — a second Rescan click joins it

// Scans and loudness analysis both rewrite library.json from a snapshot taken
// when they start, so they take turns; the second one waits in this queue.
const libraryJobs = createJobQueue();

function scanFolders(folders) {
  if (activeScan) return activeScan.promise;
  const abort = new AbortController();
  const { Worker } = require('worker_threads');

  const promise = libraryJobs.run('scan', async () => {
    let worker = null;
    try {
      const existing = await readJson(LIBRARY_FILE(), { folders: [], tracks: [] });
      worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
        workerData: {
          folders,
          existingTracks: existing.tracks,
          artCacheDir: ART_CACHE_DIR(),
        },
      });
      if (activeScan) activeScan.worker = worker;
      // cancel-scan may have arrived while the library was still being read
      if (abort.signal.aborted) worker.postMessage({ type: 'cancel' });

      const tracks = await new Promise((resolve, reject) => {
        worker.on('message', (m) => {
          if (m.type === 'progress') {
            const { type, ...p } = m;
            mainWindow?.webContents.send('scan:progress', p);
          } else if (m.type === 'done') resolve(m.tracks);
          else if (m.type === 'cancelled') resolve(null);
          else if (m.type === 'error') reject(new Error(m.message));
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error('scan worker exited with code ' + code));
        });
      });
      if (!tracks) return null;
      const library = { folders, tracks, updated: Date.now() };
      await writeJson(LIBRARY_FILE(), library);
      cachedLibrary = library;
      mediaServer?.bumpUpdateId();
      return library;
    } finally {
      worker?.terminate().catch(() => {});
    }
  }, {
    signal: abort.signal,
    cancelledValue: null,
    onWait: (ahead) => mainWindow?.webContents.send('scan:progress', { phase: 'waiting', for: ahead }),
  });
  // also covers a scan cancelled while waiting, which settles without running
  const done = () => { if (activeScan?.promise === promise) activeScan = null; };
  promise.then(done, done);

  activeScan = { worker: null, promise, abort };
  return promise;
}

// ---------------------------------------------------------------------------
// Online artist info (photo via Deezer, biography via Wikipedia)
// ---------------------------------------------------------------------------

let artistIndex = null;

async function loadArtistIndex() {
  if (!artistIndex) artistIndex = await readJson(ARTIST_INFO_FILE(), {});
  return artistIndex;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // nothing we fetch (JSON, lyrics, one photo) comes near this
        if (size > MAX_RESPONSE_BYTES) res.destroy(new Error('response too large'));
        else chunks.push(c);
      });
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
  if (cached && isFresh(cached, ARTIST_CACHE_LIMITS)) return artistInfoResult(cached);

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
  // so a temporary network failure doesn't stick; offline, an expired entry
  // is still better than nothing.
  if (!deezerOk && !wikiOk) return cached ? artistInfoResult(cached) : artistInfoResult(info);
  if (cached?.imgFile && !info.imgFile && isInsideDir(ART_CACHE_DIR(), cached.imgFile)) {
    fsp.unlink(cached.imgFile).catch(() => {}); // photo gone upstream
  }
  index[key] = info;
  // Bounded: expired and oldest entries go, along with their downloaded photo.
  for (const [, old] of pruneCache(index, ARTIST_CACHE_LIMITS, Date.now(), key)) {
    if (old?.imgFile && old.imgFile !== info.imgFile && isInsideDir(ART_CACHE_DIR(), old.imgFile)) {
      fsp.unlink(old.imgFile).catch(() => {});
    }
  }
  await writeJson(ARTIST_INFO_FILE(), index);
  return artistInfoResult(info);
}

function artistInfoResult(info) {
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

// The API key, shared secret and session key live in a main-owned file,
// encrypted with safeStorage (DPAPI on Windows) — never in settings.json and
// never sent back to the page. Access is serialized so a migration and a
// connect can't interleave their read-modify-writes.
let lastfmCredsChain = Promise.resolve();
function withLastfmCreds(fn) {
  const run = lastfmCredsChain.then(async () => {
    const creds = decodeSecretRecord(await readJson(LASTFM_CREDS_FILE(), null), safeStorage);
    const next = await fn(creds);
    if (next) await writeJson(LASTFM_CREDS_FILE(), encodeSecretRecord(next, safeStorage));
    return next || creds;
  });
  lastfmCredsChain = run.catch(() => {});
  return run;
}
const getLastfmCreds = () => withLastfmCreds(() => null);

// Older versions kept the credentials in settings.json: move them out.
async function readSettings() {
  const raw = await readJson(SETTINGS_FILE(), {});
  const { settings, secrets } = splitLastfmSettings(raw);
  if (!secrets) return settings;
  await withLastfmCreds((creds) => {
    const next = { ...creds };
    for (const [k, v] of Object.entries(secrets)) {
      if (v !== undefined && next[k] == null) next[k] = v;
    }
    return next;
  });
  await writeJson(SETTINGS_FILE(), settings);
  return settings;
}

// The page may still send credentials with its settings (a window loaded
// before the upgrade); they are split off the same way.
async function writeSettings(incoming) {
  const { settings, secrets } = splitLastfmSettings(incoming || {});
  if (secrets) {
    await withLastfmCreds((creds) => {
      const next = { ...creds };
      for (const [k, v] of Object.entries(secrets)) if (v) next[k] = v;
      return next;
    });
  }
  return writeJson(SETTINGS_FILE(), settings);
}

async function lastfmStatus() {
  const c = await getLastfmCreds();
  return {
    apiKey: c.apiKey || '',
    hasSecret: !!c.apiSecret,
    connected: !!(c.apiKey && c.apiSecret && c.sessionKey),
    username: c.sessionKey ? (c.username || null) : null,
  };
}

let pendingAuthToken = null;

// An empty secret keeps the saved one, so reconnecting doesn't mean
// re-pasting it.
async function lastfmStartAuth(input) {
  const apiKey = String(input?.apiKey || '').trim();
  const secretIn = String(input?.apiSecret || '').trim();
  const creds = await withLastfmCreds((c) => {
    const apiSecret = secretIn || (apiKey === c.apiKey ? c.apiSecret : '');
    if (!apiKey || !apiSecret) throw new Error('Enter your Last.fm API key and shared secret first');
    const changed = apiKey !== c.apiKey || apiSecret !== c.apiSecret;
    // a new key/secret invalidates the old session
    return changed ? { apiKey, apiSecret } : { ...c };
  });
  const { token } = await lastfmCall('auth.getToken', {}, creds);
  pendingAuthToken = token;
  await shell.openExternal(
    `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(creds.apiKey)}&token=${encodeURIComponent(token)}`);
  return true;
}

async function lastfmCompleteAuth() {
  if (!pendingAuthToken) throw new Error('No authorization in progress');
  const creds = await getLastfmCreds();
  const res = await lastfmCall('auth.getSession', { token: pendingAuthToken }, creds);
  pendingAuthToken = null;
  await withLastfmCreds((c) => ({ ...c, sessionKey: res.session.key, username: res.session.name }));
  return { username: res.session.name };
}

async function lastfmDisconnect() {
  pendingAuthToken = null;
  await withLastfmCreds((c) => ({ apiKey: c.apiKey, apiSecret: c.apiSecret }));
  return true;
}

async function connectedLastfmCreds() {
  const c = await getLastfmCreds();
  if (!c.apiKey || !c.apiSecret || !c.sessionKey) throw new Error('Not connected to Last.fm');
  return c;
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

// Queue scrobbles on disk so offline listens are submitted later. Calls are
// serialized: two overlapping read-modify-writes of the queue file lost
// scrobbles (a failed submit's queued entry overwritten by a successful one).
let scrobbleChain = Promise.resolve();
function submitScrobble(scrobble) {
  const run = scrobbleChain.then(() => submitScrobbleNow(scrobble));
  scrobbleChain = run.catch(() => {});
  return run;
}

async function submitScrobbleNow(scrobble) {
  const queue = await readJson(SCROBBLE_QUEUE_FILE(), []);
  queue.push(scrobble);
  // Last.fm accepts up to 50 per batch
  try {
    await lastfmScrobble(await connectedLastfmCreds(), queue.slice(0, 50));
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

// Tag parsing runs off the main thread: lyrics are requested at every track
// start, and a parseFile on the main loop can starve the WASAPI pump.
function parseTagsInWorker(filePath) {
  return new Promise((resolve) => {
    const { Worker } = require('worker_threads');
    let worker;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker?.terminate().catch(() => {});
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15000);
    try {
      worker = new Worker(path.join(__dirname, 'lyrics-worker.js'), { workerData: { path: filePath } });
    } catch { return finish(null); }
    worker.on('message', (m) => finish(m && m.ok ? m : null));
    worker.on('error', () => finish(null));
    worker.on('exit', () => finish(null));
  });
}

const LYRICS_CACHE_FILE = () => path.join(app.getPath('userData'), 'lyrics-cache.json');
let lyricsCache = null;

async function loadLyricsCache() {
  if (!lyricsCache) lyricsCache = migrateLyricsCache(await readJson(LYRICS_CACHE_FILE(), {}));
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
    const meta = await parseTagsInWorker(track.path);
    const lyr = meta?.lyrics?.[0];
    const text = typeof lyr === 'string' ? lyr : (lyr?.text || lyr?.syncText?.map((l) => l.text).join('\n'));
    if (text && text.trim()) {
      return { text, synced: /\[\d{1,2}:\d{2}/.test(text), source: 'embedded' };
    }
  } catch { /* unparseable */ }

  // 3. LRCLIB (no API key, community-run)
  const cache = await loadLyricsCache();
  const key = `${track.artist}::${track.title}`.toLowerCase();
  const cached = cache[key];
  if (cached && isFresh(cached, LYRICS_CACHE_LIMITS)) {
    return cached.entry ? { ...cached.entry, source: 'lrclib' } : null;
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
    if (!entry || entry.text.length <= LYRICS_MAX_ENTRY_CHARS) {
      cache[key] = { entry, ts: Date.now() };
      pruneCache(cache, LYRICS_CACHE_LIMITS, Date.now(), key);
      await writeJson(LYRICS_CACHE_FILE(), cache);
    }
    return entry ? { ...entry, source: 'lrclib' } : null;
  } catch {
    // offline — don't cache, retry next time; an expired hit still beats nothing
    return cached?.entry ? { ...cached.entry, source: 'lrclib' } : null;
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
    if (res.canceled) return [];
    res.filePaths.forEach((p) => pickedFolders.add(p));
    return res.filePaths;
  });

  // Folders come back from the page; a network folder is accepted only if the
  // user picked it in the dialog or it is already in the library.
  ipcMain.handle('library:scan', async (_e, folders) => {
    const known = new Set((await getCachedLibrary()).folders || []);
    const ok = (Array.isArray(folders) ? folders : []).filter((f) => isAbsolutePath(f) &&
      (!isUncPath(f) || pickedFolders.has(f) || known.has(f)));
    return scanFolders(ok);
  });
  ipcMain.handle('library:cancel-scan', () => {
    activeScan?.abort.abort();
    activeScan?.worker?.postMessage({ type: 'cancel' });
  });

  ipcMain.handle('library:choose-export-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Export To…',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled) return null;
    pickedFolders.add(res.filePaths[0]);
    return res.filePaths[0];
  });

  ipcMain.handle('library:export', async (_e, { trackIds, destDir, format, downsample }) => {
    if (activeExporter) return { ok: false, error: 'An export is already running' };
    // only a folder the user picked in the export dialog
    if (!pickedFolders.has(destDir)) return { ok: false, error: 'Choose the export folder again' };
    const { LibraryExporter } = require('./export');
    const lib = await readJson(LIBRARY_FILE(), { tracks: [] });
    const byId = new Map(lib.tracks.map((t) => [t.id, t]));
    const tracks = (trackIds || []).map((id) => byId.get(id)).filter(Boolean);
    activeExporter = new LibraryExporter({ resolveArtPath: decodeMediaUrl });
    try {
      return await activeExporter.run(tracks, destDir, { format, downsample }, (p) => {
        mainWindow?.webContents.send('export:progress', p);
      });
    } finally {
      activeExporter = null;
    }
  });
  ipcMain.handle('library:cancel-export', () => { activeExporter?.cancel(); });

  // Analyze loudness (EBU R128) and derive ReplayGain for a selection, then
  // merge the measured values into the library so playback normalizes and the
  // dynamics are surfaced in the UI. Source files are never modified. Returns
  // the updated library so the renderer can swap state and re-render, exactly
  // like a scan.
  ipcMain.handle('library:analyze-loudness', async (_e, { trackIds, force }) => {
    if (activeLoudness) return { ok: false, error: 'A loudness analysis is already running' };
    const { LoudnessAnalyzer } = require('./loudness');
    const analyzer = new LoudnessAnalyzer();
    const abort = new AbortController();
    // Set before queueing so Cancel and quit reach it while it waits its turn.
    activeLoudness = { cancel: () => { abort.abort(); analyzer.cancel(); } };
    try {
      return await libraryJobs.run('loudness', async () => {
        // Read only now, after any scan ahead of us has written its result.
        const lib = await readJson(LIBRARY_FILE(), { folders: [], tracks: [] });
        const byId = new Map(lib.tracks.map((t) => [t.id, t]));
        const tracks = (trackIds || []).map((id) => byId.get(id)).filter(Boolean);
        if (!tracks.length) return { ok: false, error: 'No matching tracks to analyze' };
        const res = await analyzer.run(tracks, { force: !!force }, (p) => {
          mainWindow?.webContents.send('loudness:progress', p);
        });
        // Merge measured fields into the library and persist.
        const merged = lib.tracks.map((t) => (res.results[t.id] ? { ...t, ...res.results[t.id] } : t));
        const updated = { ...lib, folders: lib.folders || [], tracks: merged, updated: Date.now() };
        await writeJson(LIBRARY_FILE(), updated);
        cachedLibrary = updated;
        mediaServer?.bumpUpdateId();
        // the native engine holds its own copies of the playing/next track
        nativeEngine?.refreshTracks(res.results);
        return { ...res, library: updated };
      }, {
        signal: abort.signal,
        cancelledValue: { ok: false, cancelled: true, analyzed: 0, skipped: 0, failed: 0, failures: [], results: {} },
        onWait: (ahead) => mainWindow?.webContents.send('loudness:progress', { waiting: ahead }),
      });
    } finally {
      activeLoudness = null;
    }
  });
  ipcMain.handle('library:cancel-loudness', () => { activeLoudness?.cancel(); });

  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', async (_e, settings) => writeSettings(settings));

  ipcMain.handle('playlists:get', () => readJson(PLAYLISTS_FILE(), { playlists: [] }));
  ipcMain.handle('playlists:set', async (_e, data) => writeJson(PLAYLISTS_FILE(), data));

  ipcMain.handle('stats:get', () => readJson(STATS_FILE(), { plays: {}, lastPlayed: {} }));
  ipcMain.handle('stats:set', async (_e, data) => writeJson(STATS_FILE(), data));

  ipcMain.handle('session:get', () => readJson(SESSION_FILE(), null));
  ipcMain.handle('session:set', async (_e, data) => writeJson(SESSION_FILE(), data));

  ipcMain.handle('artist:info', (_e, name) => getArtistInfo(String(name)));
  ipcMain.handle('artist:cached-map', () => getCachedArtistMap());

  // The page names tracks by id; paths always come from the library.
  ipcMain.handle('lyrics:get', async (_e, track) => {
    const t = findLibraryTrack(await getCachedLibrary(), track?.id);
    return t ? getLyrics(t) : null;
  });

  ipcMain.handle('lastfm:status', () => lastfmStatus());
  ipcMain.handle('lastfm:start-auth', (_e, input) => lastfmStartAuth(input));
  ipcMain.handle('lastfm:complete-auth', () => lastfmCompleteAuth());
  ipcMain.handle('lastfm:disconnect', () => lastfmDisconnect());
  ipcMain.handle('lastfm:now-playing', async (_e, track) => {
    try { await lastfmNowPlaying(await connectedLastfmCreds(), track); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('lastfm:scrobble', (_e, scrobble) => submitScrobble(scrobble));

  ipcMain.handle('window:mini', (_e, on) => setMiniMode(on));

  ipcMain.handle('shell:show-track', async (_e, id) => {
    const t = findLibraryTrack(await getCachedLibrary(), id);
    if (t) shell.showItemInFolder(t.path);
  });
  ipcMain.handle('shell:show-folder', (_e, dir) => {
    if (pickedFolders.has(dir)) shell.showItemInFolder(dir);
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
}

// ---------------------------------------------------------------------------
// UPnP/DLNA media server (streamers browse & pull the library)
// ---------------------------------------------------------------------------

const { MediaServer } = require('./upnp/media-server');

const UPNP_FILE = () => path.join(app.getPath('userData'), 'upnp.json');
let mediaServer = null;
let upnpPlaylistSnapshot = [];
let cachedLibrary = null;

async function getCachedLibrary() {
  if (!cachedLibrary) cachedLibrary = await readJson(LIBRARY_FILE(), { folders: [], tracks: [] });
  return cachedLibrary;
}

function decodeMediaUrl(url) {
  try {
    const encoded = new URL(url).pathname.replace(/^\//, '');
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch { return null; }
}

function getMediaServer() {
  if (!mediaServer) {
    mediaServer = new MediaServer({
      getLibrary: () => cachedLibrary || { folders: [], tracks: [] },
      getPlaylists: () => upnpPlaylistSnapshot,
      evaluatePlaylist: (p) => {
        const byId = new Map((cachedLibrary?.tracks || []).map((t) => [t.id, t]));
        return (p.trackIds || []).map((id) => byId.get(id)).filter(Boolean);
      },
      decodeMediaUrl,
    });
  }
  return mediaServer;
}

async function upnpConfig() {
  const cfg = await readJson(UPNP_FILE(), {});
  if (!cfg.uuid) {
    cfg.uuid = crypto.randomUUID();
    await writeJson(UPNP_FILE(), cfg);
  }
  return { enabled: false, name: 'Auralis', port: 47700, ...cfg };
}

// Addresses the selected network zone's renderer may pull audio from, while
// a zone is selected (null otherwise).
let zoneClients = null;
let zoneGen = 0; // bumped per select/stop so a slow renderer handshake can't win late
let mediaServerSync = Promise.resolve();

// Bring the media server in line with the user's setting and the zone:
// enabled → the full server, advertised to the whole network; disabled with a
// zone selected → zone-only, unadvertised and serving just that renderer;
// otherwise stopped. Runs one at a time so a quick zone switch can't race two
// listeners onto the port.
function syncMediaServer() {
  const run = mediaServerSync.then(async () => {
    const cfg = await upnpConfig();
    const server = getMediaServer();
    if (!cfg.enabled && !zoneClients) { server.stop(); return server.status(); }
    await getCachedLibrary();
    try {
      return await server.start({ enabled: cfg.enabled, name: cfg.name, port: cfg.port }, cfg.uuid,
        cfg.enabled ? { advertise: true } : { advertise: false, allowedClients: zoneClients });
    } catch (err) {
      server.stop();
      throw err;
    }
  });
  mediaServerSync = run.catch(() => {});
  return run;
}

async function applyUpnpConfig(partial) {
  const cfg = { ...(await upnpConfig()), ...partial };
  await writeJson(UPNP_FILE(), cfg);
  try {
    return { ok: true, ...(await syncMediaServer()) };
  } catch (err) {
    return { ok: false, error: err.message, running: false };
  }
}

// ── network renderer zone (UPnP AV / OpenHome control point) ──

const { RendererEngine, discoverRenderers } = require('./upnp/renderer-client');
const { trackItemXml } = require('./upnp/media-server');
const { localIPv4: upnpLocalIp } = require('./upnp/ssdp');
const os = require('os');
const net = require('net');
const dnsPromises = require('dns').promises;
let rendererEngine = null;

function getRendererEngine() {
  if (!rendererEngine) {
    rendererEngine = new RendererEngine((channel, payload) => {
      mainWindow?.webContents.send(channel, payload);
    });
    rendererEngine.buildTrackUrl = (track) => {
      const base = `http://${upnpLocalIp()}:${getMediaServer().config.port || 47700}`;
      const t = (cachedLibrary?.tracks || []).find((x) => x.id === track.id) || track;
      const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${trackItemXml(t, '0', base)}</DIDL-Lite>`;
      return { uri: `${base}/stream/${encodeURIComponent(t.id)}`, didl };
    };
  }
  return rendererEngine;
}

// The host in the renderer's description URL is where it pulls audio from.
// A renderer on this PC may connect from any of our own addresses instead.
async function rendererAddresses(location) {
  const host = new URL(location).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host]
    : (await dnsPromises.lookup(host, { all: true })).map((a) => a.address);
  const own = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address);
  if (addrs.some((a) => own.includes(a) || a.startsWith('127.') || a === '::1')) {
    addrs.push(...own, '127.0.0.1', '::1');
  }
  return addrs;
}

// The renderer pulls audio from our HTTP server — make sure it's up even if
// the user hasn't enabled the media server (zone-only; see syncMediaServer).
async function ensureServerForZone() {
  if (getMediaServer().status().running) return;
  await syncMediaServer();
}

function registerUpnpIpc() {
  ipcMain.handle('upnp:server-config', async (_e, partial) => applyUpnpConfig(partial || {}));
  ipcMain.handle('upnp:server-status', async () => {
    const cfg = await upnpConfig();
    return { ...getMediaServer().status(), enabled: cfg.enabled, name: cfg.name, port: cfg.port };
  });
  ipcMain.handle('upnp:playlists-snapshot', (_e, snapshot) => {
    upnpPlaylistSnapshot = Array.isArray(snapshot) ? snapshot : [];
  });

  ipcMain.handle('upnp:discover-renderers', () => discoverRenderers());
  ipcMain.handle('upnp:zone-select', async (_e, location) => {
    const gen = ++zoneGen;
    let info;
    try {
      info = await getRendererEngine().select(location);
      const addrs = info ? await rendererAddresses(location) : null;
      if (gen === zoneGen) zoneClients = addrs;
    } catch (err) {
      if (gen === zoneGen) zoneClients = null;
      await syncMediaServer().catch(() => {});
      throw err;
    }
    await syncMediaServer();
    return info;
  });
  ipcMain.handle('upnp:zone-play', async (_e, track, startAt) => {
    try {
      await ensureServerForZone();
      await getRendererEngine().play(track, startAt || 0);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('upnp:zone-pause', () => getRendererEngine().pause());
  ipcMain.handle('upnp:zone-resume', () => getRendererEngine().resume());
  ipcMain.handle('upnp:zone-seek', (_e, s) => getRendererEngine().seek(s));
  ipcMain.handle('upnp:zone-set-next', (_e, track) => getRendererEngine().setNext(track));
  ipcMain.handle('upnp:zone-volume', (_e, v) => getRendererEngine().setVolume(v));
  // Sent when the app leaves the zone: stop the renderer, forget it, and take
  // the zone-only server down with it. (Cleared before any await so a
  // zone-select for the next zone, sent right behind this, always wins.)
  ipcMain.handle('upnp:zone-stop', async () => {
    zoneGen++;
    zoneClients = null;
    await getRendererEngine().select(null);
    await syncMediaServer().catch(() => {});
  });
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
  ipcMain.handle('native:config', async (_e, partial) => {
    const cfg = { ...(partial || {}) };
    if (cfg.correction && typeof cfg.correction === 'object') {
      const irPath = cfg.correction.irPath;
      cfg.correction = { ...cfg.correction, irPath: (await isAllowedIrPath(irPath)) ? irPath : null };
    }
    return getNativeEngine().setConfig(cfg);
  });
  // The page names tracks by id; the engine gets the library's copy, so its
  // path (and cue bounds) can't be chosen by the page.
  ipcMain.handle('native:play', async (_e, track, startAt, startPaused) => {
    try {
      const t = findLibraryTrack(await getCachedLibrary(), track?.id);
      if (!t) throw new Error('Track is not in the library');
      await getNativeEngine().play(t, startAt || 0, false, { startPaused: !!startPaused });
      return { ok: true };
    }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('native:pause', () => getNativeEngine().pause());
  ipcMain.handle('native:resume', () => getNativeEngine().resume());
  ipcMain.handle('native:seek', (_e, time) => getNativeEngine().seek(time));
  ipcMain.handle('native:set-next', async (_e, track) => {
    const t = track ? findLibraryTrack(await getCachedLibrary(), track.id) : null;
    getNativeEngine().setNext(t);
  });
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
    trustedIr = irPath;
    await writeJson(DSP_IR_FILE(), { path: irPath });
    return { path: irPath, url: toMediaUrl(irPath), name: path.basename(irPath) };
  });
}

// The impulse response the user last picked in the dialog, remembered in a
// main-owned file (the copy in settings.json is page-writable).
let trustedIr;
async function trustedIrPath() {
  if (trustedIr === undefined) trustedIr = (await readJson(DSP_IR_FILE(), {})).path || null;
  return trustedIr;
}

// ffmpeg opens this path: the picked file, or else a local .wav.
async function isAllowedIrPath(p) {
  if (!p) return false;
  if (p === (await trustedIrPath())) return true;
  return isAbsolutePath(p) && !isUncPath(p) && path.extname(p).toLowerCase() === '.wav';
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
    readSettings().then((s) => {
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

  // The window only ever shows the bundled UI. Without this, dropping a file
  // or a browser link onto the window navigates it away (frameless, no menu —
  // no way back), and the loaded page would inherit the preload API.
  const appUrl = require('url').pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== appUrl) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
  registerUpnpIpc();
  // Loaded up front so the id lookups in the playback handlers never wait on
  // disk (a play and the pause right behind it stay in order).
  await Promise.all([getCachedLibrary(), trustedIrPath()]).catch(() => {});
  createWindow();
  // resume the media server if it was enabled last session
  upnpConfig().then((cfg) => { if (cfg.enabled) applyUpnpConfig({}); }).catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  try { activeExporter?.cancel(); } catch {}
  try { activeLoudness?.cancel(); } catch {} // else its ffmpeg can outlive us and strand a .rgpart
  try { activeScan?.abort.abort(); } catch {} // a scan still waiting never starts
  try { activeScan?.worker?.terminate(); } catch {}
  try { nativeEngine?.stopAll(); } catch {}
  try { rendererEngine?.stopAll(); } catch {}
  try { mediaServer?.stop(); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
