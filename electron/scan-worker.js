'use strict';

// Library scanner, running in a worker thread. Metadata parsing is CPU-heavy
// enough that doing it on the main process starves the audio pump (the
// WASAPI-exclusive ring refills every 10ms on that loop) — a rescan during
// playback caused audible pops and a backlog of IPC/UI errors.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.alac', '.ape', '.wv',
  '.dsf', '.dff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma',
]);
const LOSSLESS_EXTENSIONS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.alac', '.ape', '.wv', '.dsf', '.dff',
]);

const { folders, existingTracks, artCacheDir } = workerData;

let cancelled = false;
parentPort.on('message', (m) => { if (m && m.type === 'cancel') cancelled = true; });

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function toMediaUrl(filePath) {
  return 'auralis://media/' + Buffer.from(filePath, 'utf8').toString('base64url');
}

async function* walkFiles(dir) {
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
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// ── Cue sheets ─────────────────────────────────────────────────────────────
// MM:SS:FF, where FF is CD frames (75 per second).
function cueTimeToSec(str) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(String(str).trim());
  if (!m) return 0;
  return (+m[1]) * 60 + (+m[2]) + (+m[3]) / 75;
}

function unquote(s) {
  const m = /^"(.*)"$/.exec(String(s).trim());
  return m ? m[1] : String(s).trim();
}

// Parse a .cue into { title, performer, date, genre, files: [{ file, tracks:
// [{ no, title, performer, startSec }] }] }. FILE paths are resolved against
// the sheet's own directory.
function parseCue(text, cueDir) {
  const album = { title: '', performer: '', date: null, genre: '', files: [] };
  let curFile = null, curTrack = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const arg = line.slice(parts[0].length).trim();
    if (cmd === 'REM') {
      const k = (parts[1] || '').toUpperCase();
      if (k === 'DATE') album.date = parseInt(parts[2], 10) || null;
      else if (k === 'GENRE') album.genre = unquote(parts.slice(2).join(' '));
    } else if (cmd === 'TITLE') {
      if (curTrack) curTrack.title = unquote(arg); else album.title = unquote(arg);
    } else if (cmd === 'PERFORMER') {
      if (curTrack) curTrack.performer = unquote(arg); else album.performer = unquote(arg);
    } else if (cmd === 'FILE') {
      // FILE "name.flac" WAVE  → strip the trailing format token
      const m = /^"(.+)"\s+\S+$/.exec(arg) || /^(\S+)\s+\S+$/.exec(arg);
      const name = m ? m[1] : unquote(arg);
      curFile = { file: path.resolve(cueDir, name), tracks: [] };
      album.files.push(curFile);
      curTrack = null;
    } else if (cmd === 'TRACK') {
      curTrack = { no: parseInt(parts[1], 10) || (curFile ? curFile.tracks.length + 1 : 1), title: '', performer: '', startSec: 0 };
      if (curFile) curFile.tracks.push(curTrack);
    } else if (cmd === 'INDEX' && curTrack && parts[1] === '01') {
      // INDEX 01 is where the track's audio begins (INDEX 00 is pregap)
      curTrack.startSec = cueTimeToSec(parts[2] || '0:0:0');
    }
  }
  return album;
}

async function cacheAlbumArt(pictures, albumKey) {
  if (!pictures || pictures.length === 0) return null;
  try {
    await fsp.mkdir(artCacheDir, { recursive: true });
    const pic = pictures.find((p) => /front|cover/i.test(p.type || '')) || pictures[0];
    const ext = /png/i.test(pic.format || '') ? '.png' : '.jpg';
    const file = path.join(artCacheDir, hashString(albumKey) + ext);
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
  if (!artUrl) {
    artUrl = await cacheAlbumArt(c.picture, albumKey);
    if (artUrl) existingArtByAlbum.set(albumKey, artUrl);
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

// Build the virtual tracks for one physical file referenced by a cue sheet.
// Metadata (format, art, duration) is read once and shared across the file's
// segments. Unchanged segments are reused from the previous scan (keyed by id,
// gated on the file's mtime) so loudness/ReplayGain fields added later survive.
async function extractCueTracks(mm, album, fileEntry, artByAlbum, byId) {
  const filePath = fileEntry.file;
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return []; }
  const ext = path.extname(filePath).toLowerCase();
  let meta = null;
  try { meta = await mm.parseFile(filePath, { duration: true, skipCovers: false }); } catch { /* headerless */ }
  const c = meta?.common || {};
  const f = meta?.format || {};
  const fileDur = f.duration || 0;
  const albumArtist = album.performer || c.albumartist || c.artist || 'Unknown Artist';
  const albumTitle = album.title || c.album || path.basename(path.dirname(filePath)) || 'Unknown Album';
  const albumKey = `${albumArtist}::${albumTitle}`.toLowerCase();

  let artUrl = artByAlbum.get(albumKey);
  if (!artUrl) {
    artUrl = await cacheAlbumArt(c.picture, albumKey);
    if (artUrl) artByAlbum.set(albumKey, artUrl);
  }

  const trs = [...fileEntry.tracks].sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (let i = 0; i < trs.length; i++) {
    const t = trs[i];
    const start = t.startSec;
    const isLast = i + 1 >= trs.length;
    const end = isLast ? fileDur : trs[i + 1].startSec;
    const id = hashString(`${filePath}#${t.no}@${start.toFixed(3)}`);
    const prev = byId.get(id);
    if (prev && prev.mtime === stat.mtimeMs && prev.artUrl) { out.push(prev); continue; }
    out.push({
      id, path: filePath, url: toMediaUrl(filePath),
      title: t.title || `Track ${t.no}`,
      artist: t.performer || albumArtist,
      albumArtist, album: albumTitle, albumKey,
      genre: album.genre || (c.genre && c.genre[0]) || '',
      year: album.date || c.year || null,
      trackNo: t.no, discNo: null,
      duration: Math.max(0, (end || fileDur) - start),
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
      fileSize: stat.size, mtime: stat.mtimeMs, added: Date.now(),
      // cue segment of a shared file: url points at the whole file; playback
      // seeks to cueStart and stops at cueEnd (null cueEnd = play to file end).
      cue: true, cueStart: start, cueEnd: isLast ? null : end,
    });
  }
  return out;
}

(async () => {
  const mm = await import('music-metadata');
  const byPath = new Map(existingTracks.map((t) => [t.path, t]));
  const byId = new Map(existingTracks.map((t) => [t.id, t]));
  const artByAlbum = new Map();
  for (const t of existingTracks) {
    if (t.artUrl) artByAlbum.set(t.albumKey, t.artUrl);
  }

  const allFiles = [];
  const cueFiles = [];
  for (const folder of folders) {
    for await (const file of walkFiles(folder)) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.cue') cueFiles.push(file);
      else if (AUDIO_EXTENSIONS.has(ext)) allFiles.push(file);
      else continue;
      if ((allFiles.length + cueFiles.length) % 200 === 0) {
        parentPort.postMessage({ type: 'progress', phase: 'discover', found: allFiles.length });
      }
      if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
    }
  }

  // Parse cue sheets first so their referenced audio files aren't ALSO indexed
  // as one giant standalone track.
  const cueAlbums = [];
  const cueReferenced = new Set();
  for (const cuePath of cueFiles) {
    try {
      const album = parseCue(await fsp.readFile(cuePath, 'utf8'), path.dirname(cuePath));
      let referencesReal = false;
      for (const fe of album.files) {
        if (fs.existsSync(fe.file)) { cueReferenced.add(fe.file); referencesReal = true; }
      }
      if (referencesReal) cueAlbums.push(album);
    } catch { /* unreadable / malformed cue */ }
  }

  const tracks = [];
  for (let i = 0; i < allFiles.length; i++) {
    if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
    const file = allFiles[i];
    if (cueReferenced.has(file)) continue; // represented by cue segments instead
    const prev = byPath.get(file);
    try {
      if (prev && prev.mtime === (await fsp.stat(file)).mtimeMs && prev.artUrl) {
        tracks.push(prev);
      } else {
        tracks.push(await extractTrack(mm, file, artByAlbum));
      }
    } catch {
      // skip unreadable file
    }
    if (i % 20 === 0 || i === allFiles.length - 1) {
      parentPort.postMessage({
        type: 'progress', phase: 'read', done: i + 1, total: allFiles.length,
        file: path.basename(file),
      });
    }
  }

  // Emit cue segments (each album's referenced files parsed once).
  for (const album of cueAlbums) {
    if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
    for (const fe of album.files) {
      try { tracks.push(...await extractCueTracks(mm, album, fe, artByAlbum, byId)); }
      catch { /* skip bad cue file entry */ }
    }
  }

  // A track processed before its album's art was found (e.g. track 1 has no
  // embedded art but track 4 does) would otherwise stay stuck without art —
  // backfill from the now-complete per-album cache.
  for (const t of tracks) {
    if (!t.artUrl && artByAlbum.get(t.albumKey)) t.artUrl = artByAlbum.get(t.albumKey);
  }

  parentPort.postMessage({ type: 'done', tracks });
})().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
