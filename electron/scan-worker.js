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

(async () => {
  const mm = await import('music-metadata');
  const byPath = new Map(existingTracks.map((t) => [t.path, t]));
  const artByAlbum = new Map();
  for (const t of existingTracks) {
    if (t.artUrl) artByAlbum.set(t.albumKey, t.artUrl);
  }

  const allFiles = [];
  for (const folder of folders) {
    for await (const file of walkAudioFiles(folder)) {
      allFiles.push(file);
      if (allFiles.length % 200 === 0) {
        parentPort.postMessage({ type: 'progress', phase: 'discover', found: allFiles.length });
      }
      if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
    }
  }

  const tracks = [];
  for (let i = 0; i < allFiles.length; i++) {
    if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
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
      parentPort.postMessage({
        type: 'progress', phase: 'read', done: i + 1, total: allFiles.length,
        file: path.basename(file),
      });
    }
  }

  parentPort.postMessage({ type: 'done', tracks });
})().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
