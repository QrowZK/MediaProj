'use strict';

// Exports tracks (a whole library, an album, a playlist, or a single track)
// to a folder as either untouched copies or ffmpeg transcodes at a chosen
// quality, organized as <dest>/<Artist>/<Album>/<NN - Title>.<ext> — the
// layout portable players and DAPs expect, cover.jpg included per album.

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch { /* bundled binary missing on this install */ }

const FORMATS = {
  copy: { label: 'Keep original (copy)', ext: null },
  flac: {
    label: 'FLAC (lossless)', ext: 'flac',
    args: (ds) => ['-c:a', 'flac', '-compression_level', '8', ...(ds ? ['-ar', '44100', '-sample_fmt', 's16'] : [])],
  },
  alac: {
    label: 'ALAC (lossless, Apple)', ext: 'm4a',
    args: (ds) => ['-c:a', 'alac', ...(ds ? ['-ar', '44100', '-sample_fmt', 's16p'] : [])],
  },
  mp3_320: {
    label: 'MP3 320 kbps', ext: 'mp3',
    args: (ds) => ['-c:a', 'libmp3lame', '-b:a', '320k', ...(ds ? ['-ar', '44100'] : [])],
  },
  mp3_v0: {
    label: 'MP3 V0 (VBR, ~245 kbps)', ext: 'mp3',
    args: (ds) => ['-c:a', 'libmp3lame', '-q:a', '0', ...(ds ? ['-ar', '44100'] : [])],
  },
  aac_256: {
    label: 'AAC 256 kbps', ext: 'm4a',
    args: (ds) => ['-c:a', 'aac', '-b:a', '256k', ...(ds ? ['-ar', '44100'] : [])],
  },
};

function sanitizeSegment(s) {
  const cleaned = String(s || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // Windows-illegal chars + control chars
    .replace(/[.\s]+$/, ''); // trailing dots/spaces (Windows can't create these)
  return (cleaned || 'Unknown').slice(0, 120);
}

// A cue-sheet track is a [cueStart, cueEnd) slice of a shared disc image:
// trim to that span (input-side -ss is sample-accurate when transcoding) and
// write the segment's own tags — -map_metadata alone would stamp every track
// with the disc file's title/track number. Disc-wide tags that are wrong for a
// single track (the embedded cue sheet, the whole disc's track gain) are
// cleared; an empty -metadata value deletes the key. If Auralis measured this
// segment's loudness, its own track gain goes in instead.
function cueSegmentArgs(track, muxer) {
  if (!track.cue) return { inputArgs: [], outputArgs: [] };
  const start = Number(track.cueStart) || 0;
  const inputArgs = start > 0 ? ['-ss', start.toFixed(6)] : [];
  const outputArgs = [];
  if (track.cueEnd != null) outputArgs.push('-t', Math.max(0.001, track.cueEnd - start).toFixed(6));
  const rgKey = (n) => (muxer === 'mp3' ? `replaygain_${n}` : `REPLAYGAIN_${n.toUpperCase()}`);
  const measured = track.loudnessLufs != null && track.replayGainTrack != null;
  const tags = {
    title: track.title, artist: track.artist, album: track.album,
    album_artist: track.albumArtist, track: track.trackNo, date: track.year, genre: track.genre,
  };
  if (measured) {
    tags[rgKey('track_gain')] = `${track.replayGainTrack.toFixed(2)} dB`;
    if (track.rgTrackPeak != null) tags[rgKey('track_peak')] = track.rgTrackPeak.toFixed(6);
  }
  for (const [k, v] of Object.entries(tags)) {
    if (v != null && v !== '') outputArgs.push('-metadata', `${k}=${v}`);
  }
  for (const k of ['cuesheet', rgKey('track_gain'), rgKey('track_peak')]) {
    if (!(k in tags)) outputArgs.push('-metadata', `${k}=`);
  }
  return { inputArgs, outputArgs };
}

// "Keep original" can't byte-copy one track out of a disc image, so a cue
// track from a lossless image is re-encoded to FLAC trimmed to the track: the
// decoded samples are identical, only the container changes. FLAC takes
// integer PCM up to 24-bit; anything else (lossy images, DSD, 32-bit PCM)
// falls back to copying the whole image and its .cue once per album.
const CUE_LOSSLESS = {
  label: 'FLAC (lossless, trimmed from disc image)', ext: 'flac',
  args: () => ['-c:a', 'flac', '-compression_level', '8'], // never resample: bit-perfect
};

function cueTrimsToFlac(track) {
  return !!track.lossless && !track.dsd && !(track.bitsPerSample > 24);
}

// The scanner doesn't record which .cue a segment came from, so find it the
// way the scanner matched it: a .cue beside the image whose FILE line names
// the image (or the same stem with another extension, e.g. FILE "x.wav" for
// x.flac).
async function findCueSheet(imagePath) {
  const dir = path.dirname(imagePath);
  const stem = (p) => path.basename(p, path.extname(p)).toLowerCase();
  const want = path.basename(imagePath).toLowerCase();
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  let byStem = null;
  for (const name of names) {
    if (path.extname(name).toLowerCase() !== '.cue') continue;
    let buf;
    try { buf = await fsp.readFile(path.join(dir, name)); } catch { continue; }
    // cue sheets are UTF-8 or a legacy code page; try both readings
    for (const text of [buf.toString('utf8'), buf.toString('latin1')]) {
      for (const m of text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)) {
        const ref = path.basename((m[1] || m[2]).replace(/\\/g, '/')).toLowerCase();
        if (ref === want) return path.join(dir, name);
        if (!byStem && stem(ref) === stem(want)) byStem = path.join(dir, name);
      }
    }
  }
  return byStem;
}

function buildDestPath(destDir, track, fmt) {
  const artist = sanitizeSegment(track.albumArtist || track.artist);
  const album = sanitizeSegment(track.album);
  const ext = fmt.ext || path.extname(track.path).slice(1).toLowerCase() || 'audio';
  const num = track.trackNo ? String(track.trackNo).padStart(2, '0') + ' - ' : '';
  return {
    albumDir: path.join(destDir, artist, album),
    filePath: path.join(destDir, artist, album, `${num}${sanitizeSegment(track.title)}.${ext}`),
  };
}

class LibraryExporter {
  constructor({ resolveArtPath }) {
    this.resolveArtPath = resolveArtPath;
    this.cancelled = false;
    this.currentChild = null;
  }

  cancel() {
    this.cancelled = true;
    try { this.currentChild?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) return reject(new Error('Bundled ffmpeg is unavailable on this install'));
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.currentChild = child;
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('error', reject);
      child.on('close', (code) => {
        this.currentChild = null;
        if (code === 0) resolve();
        else if (this.cancelled) reject(new Error('cancelled'));
        else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      });
    });
  }

  async _writeAlbumArt(track, albumDir, doneDirs) {
    if (doneDirs.has(albumDir) || !track.artUrl) return;
    doneDirs.add(albumDir); // mark attempted even on failure — don't retry every track
    const src = this.resolveArtPath(track.artUrl);
    if (!src) return;
    try {
      const ext = path.extname(src).toLowerCase() === '.png' ? '.png' : '.jpg';
      await fsp.copyFile(src, path.join(albumDir, 'cover' + ext));
    } catch { /* non-fatal — the audio file is what matters */ }
  }

  // Write `filePath` via a .part sibling renamed on success, so a cancelled or
  // failed export never leaves a truncated file that looks "already exported".
  // Returns 'skipped' when a non-empty file is already there.
  async _writeAtomic(filePath, produce) {
    try {
      if ((await fsp.stat(filePath)).size > 0) return 'skipped';
    } catch { /* doesn't exist yet */ }
    const partPath = filePath + '.part';
    await fsp.unlink(partPath).catch(() => {}); // stale from a previous run
    try {
      await produce(partPath);
      await fsp.rename(partPath, filePath);
    } catch (err) {
      await fsp.unlink(partPath).catch(() => {});
      throw err;
    }
    return 'exported';
  }

  // Copy a cue track's whole disc image and its .cue into the album folder,
  // once per image; every track of the disc reports the same outcome. The
  // image keeps its name so the .cue's FILE line still points at it. Two
  // different images with the same name in one album folder (EAC's
  // CDImage.ape per disc) go in numbered subfolders instead of colliding.
  _copyDisc(track, albumDir, discs) {
    if (!discs.byImage.has(track.path)) {
      discs.byImage.set(track.path, (async () => {
        let dir = albumDir;
        for (let n = 2; ; n++) {
          const owner = discs.claimed.get(path.join(dir, path.basename(track.path)).toLowerCase());
          if (!owner || owner === track.path) break;
          dir = path.join(albumDir, `Disc ${n}`);
        }
        discs.claimed.set(path.join(dir, path.basename(track.path)).toLowerCase(), track.path);
        await fsp.mkdir(dir, { recursive: true });
        const status = await this._writeAtomic(path.join(dir, path.basename(track.path)),
          (part) => fsp.copyFile(track.path, part));
        const cuePath = await findCueSheet(track.path);
        if (cuePath) {
          await this._writeAtomic(path.join(dir, path.basename(cuePath)), (part) => fsp.copyFile(cuePath, part));
        }
        return status;
      })());
    }
    return discs.byImage.get(track.path);
  }

  // opts: { format: 'copy'|'flac'|'alac'|'mp3_320'|'mp3_v0'|'aac_256', downsample: bool }
  async run(tracks, destDir, opts, onProgress) {
    const fmt = FORMATS[opts.format] || FORMATS.copy;
    const doneArtDirs = new Set();
    const discs = { byImage: new Map(), claimed: new Map() };
    let exported = 0, skipped = 0, failed = 0;
    const failures = [];

    for (let i = 0; i < tracks.length; i++) {
      if (this.cancelled) break;
      const track = tracks[i];
      onProgress({ done: i, total: tracks.length, file: `${track.artist} — ${track.title}` });
      try {
        let trackFmt = fmt;
        if (fmt === FORMATS.copy && track.cue) trackFmt = cueTrimsToFlac(track) ? CUE_LOSSLESS : null;
        const { albumDir, filePath } = buildDestPath(destDir, track, trackFmt || fmt);
        await fsp.mkdir(albumDir, { recursive: true });
        await this._writeAlbumArt(track, albumDir, doneArtDirs);

        let status;
        if (!trackFmt) {
          status = await this._copyDisc(track, albumDir, discs);
        } else if (!trackFmt.args) {
          status = await this._writeAtomic(filePath, (part) => fsp.copyFile(track.path, part));
        } else {
          // the .part name hides the extension from ffmpeg, so name the muxer
          const muxer = { flac: 'flac', m4a: 'ipod', mp3: 'mp3' }[trackFmt.ext];
          const { inputArgs, outputArgs } = cueSegmentArgs(track, muxer);
          status = await this._writeAtomic(filePath, (part) => this._runFfmpeg([
            '-y', '-v', 'error', ...inputArgs, '-i', track.path, '-map_metadata', '0', '-vn',
            ...outputArgs, ...trackFmt.args(!!opts.downsample), '-f', muxer, part,
          ]));
        }
        if (status === 'skipped') skipped++;
        else exported++;
      } catch (err) {
        if (this.cancelled) break;
        failed++;
        failures.push({ title: track.title, error: err.message });
      }
    }

    onProgress({ done: tracks.length, total: tracks.length, file: '' });
    return { ok: !this.cancelled, cancelled: this.cancelled, exported, skipped, failed, failures, destDir };
  }
}

module.exports = { LibraryExporter, FORMATS };
