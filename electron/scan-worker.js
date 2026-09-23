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
      // FILE "name.flac" WAVE  → strip the trailing format token. Unquoted
      // names may contain spaces (FILE my disc.flac WAVE): drop only the last
      // token.
      const m = /^"(.+)"(?:\s+\S+)?$/.exec(arg) || /^(.+?)\s+\S+$/.exec(arg);
      const name = m ? m[1] : unquote(arg);
      curFile = { file: path.resolve(cueDir, name), tracks: [] };
      album.files.push(curFile);
      // NOT resetting curTrack: in multi-file cues with gaps appended to the
      // previous track (EAC "noncompliant"), a track's INDEX 01 follows the
      // FILE line of the file where its audio actually starts.
    } else if (cmd === 'TRACK') {
      curTrack = { no: parseInt(parts[1], 10) || (curFile ? curFile.tracks.length + 1 : 1), title: '', performer: '', startSec: null, pregapSec: null, file: curFile };
      if (curFile) curFile.tracks.push(curTrack);
    } else if (cmd === 'INDEX' && curTrack && (parts[1] === '01' || parts[1] === '00')) {
      const t = cueTimeToSec(parts[2] || '0:0:0');
      if (parts[1] === '00') { curTrack.pregapSec = t; continue; }
      // INDEX 01 is where the track's audio begins (INDEX 00 is pregap). If it
      // appears under a later FILE than the TRACK line, the track's audio
      // lives in that file — move it there.
      curTrack.startSec = t;
      if (curFile && curTrack.file !== curFile) {
        const from = curTrack.file;
        if (from) from.tracks = from.tracks.filter((x) => x !== curTrack);
        curFile.tracks.push(curTrack);
        curTrack.file = curFile;
      }
    }
  }
  // A track with no INDEX 01 falls back to its INDEX 00; with neither it has
  // no defined start and is dropped (a default of 0 duplicated track 1's start).
  for (const f of album.files) {
    f.tracks = f.tracks.filter((t) => {
      if (t.startSec == null) t.startSec = t.pregapSec;
      delete t.file;
      return t.startSec != null;
    });
  }
  return album;
}

// Cue sheets are plain text in whatever encoding the ripper used: UTF-8
// (often with a BOM) from modern tools, but EAC and older rippers write the
// Windows ANSI code page, whose accented letters are invalid UTF-8 and came
// out as U+FFFD. Decode strictly as UTF-8 first, then fall back to
// Windows-1252. A UTF-16 BOM is honoured too.
function decodeCueText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf); // strips a UTF-8 BOM
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// Cue sheets very often name a file that was converted after ripping
// (FILE "Album.wav" with Album.flac on disk), or differ in case. Resolve to
// the real file: exact path, then a case-insensitive match, then the same
// basename with any supported audio extension.
function resolveCueAudio(file) {
  if (fs.existsSync(file)) return file;
  let entries;
  try { entries = fs.readdirSync(path.dirname(file)); } catch { return null; }
  const want = path.basename(file).toLowerCase();
  const exact = entries.find((e) => e.toLowerCase() === want);
  if (exact) return path.join(path.dirname(file), exact);
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  const alt = entries.find((e) => AUDIO_EXTENSIONS.has(path.extname(e).toLowerCase()) &&
    path.basename(e, path.extname(e)).toLowerCase() === stem);
  return alt ? path.join(path.dirname(file), alt) : null;
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

// ReplayGain peaks from tags (linear, 1.0 = full scale). Playback caps a
// positive gain at 1/peak so it can't clip; without the peak it can't.
function tagPeaks(c) {
  const lin = (p) => (p && Number.isFinite(p.ratio) && p.ratio > 0 ? p.ratio : null);
  return { rgTrackPeak: lin(c.replaygain_track_peak), rgAlbumPeak: lin(c.replaygain_album_peak) };
}

// Entries scanned before peaks were read carry a tagged gain but no peak
// field at all — re-read those once so their gain gets clipping protection.
// (Tracks Auralis analyzed always have rgTrackPeak.)
const needsPeakReread = (t) => t.rgTrackPeak === undefined && t.replayGainTrack != null;

// Re-reading an entry whose audio is unchanged (it had no art, or needed its
// peaks) rebuilt it from the tags alone, dropping Auralis's loudness analysis
// and resetting its "added" date — so an art-less album lost its ReplayGain on
// every rescan. Carry those over; a changed file (or a cue edit that moved the
// segment's end) is measured afresh.
const ANALYSIS_KEYS = ['loudnessLufs', 'loudnessRange', 'truePeakDb', 'replayGainTrack',
  'replayGainAlbum', 'rgTrackPeak', 'rgAlbumPeak', 'loudnessAnalyzedAt', 'rgTagged', 'rgTagReason'];
function keepFromPrev(prev, fresh) {
  if (!prev || prev.mtime !== fresh.mtime) return fresh;
  if (prev.added) fresh.added = prev.added;
  if (prev.loudnessAnalyzedAt && (prev.cueEnd ?? null) === (fresh.cueEnd ?? null)) {
    for (const k of ANALYSIS_KEYS) if (k in prev) fresh[k] = prev[k];
  }
  return fresh;
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
    ...tagPeaks(c),
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
    // reuse only if neither the audio nor the .cue changed (a cue edit can
    // change titles or the next track's INDEX, i.e. this track's cueEnd)
    if (prev && prev.mtime === stat.mtimeMs && prev.cueMtime === album.cueMtime && prev.artUrl &&
        !needsPeakReread(prev)) { out.push(prev); continue; }
    out.push(keepFromPrev(prev, {
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
      ...tagPeaks(c),
      artUrl: artUrl || null,
      fileSize: stat.size, mtime: stat.mtimeMs, added: Date.now(),
      // cue segment of a shared file: url points at the whole file; playback
      // seeks to cueStart and stops at cueEnd (null cueEnd = play to file end).
      cue: true, cueStart: start, cueEnd: isLast ? null : end, cueMtime: album.cueMtime,
    }));
  }
  return out;
}

(async () => {
  const mm = await import('music-metadata');
  // standalone-file reuse only: a cue segment's `path` is the whole disc file,
  // so if its cue later disappears, reusing the segment would put one stray
  // slice in the library instead of the full file
  const byPath = new Map(existingTracks.filter((t) => !t.cue).map((t) => [t.path, t]));
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
  const cueReferenced = new Set(); // fileKey()s of audio files cue sheets cover
  // Windows paths are case-insensitive: a sheet spelling the file name in a
  // different case must still claim the file the folder walk found.
  const fileKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  // Sorted so the same sheet wins every scan when several point at one file.
  cueFiles.sort();
  for (const cuePath of cueFiles) {
    try {
      const album = parseCue(decodeCueText(await fsp.readFile(cuePath)), path.dirname(cuePath));
      album.cueMtime = (await fsp.stat(cuePath)).mtimeMs;
      // keep only entries that resolve to a real file AND have segments — a
      // file marked cue-covered but yielding no tracks would vanish entirely.
      // A file an earlier sheet already claimed is skipped: two sheets for one
      // image (a UTF-8 and an ANSI copy, say) made every track twice, with the
      // same ids, so the album listed each track twice and id lookups collided.
      album.files = album.files.filter((fe) => {
        const real = fe.tracks.length ? resolveCueAudio(fe.file) : null;
        if (real) fe.file = real;
        return !!real && !cueReferenced.has(fileKey(real));
      });
      for (const fe of album.files) cueReferenced.add(fileKey(fe.file));
      if (album.files.length) cueAlbums.push(album);
    } catch { /* unreadable / malformed cue */ }
  }

  const tracks = [];
  for (let i = 0; i < allFiles.length; i++) {
    if (cancelled) { parentPort.postMessage({ type: 'cancelled' }); return; }
    const file = allFiles[i];
    if (cueReferenced.has(fileKey(file))) continue; // represented by cue segments instead
    const prev = byPath.get(file);
    try {
      if (prev && prev.mtime === (await fsp.stat(file)).mtimeMs && prev.artUrl && !needsPeakReread(prev)) {
        tracks.push(prev);
      } else {
        tracks.push(keepFromPrev(prev, await extractTrack(mm, file, artByAlbum)));
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
