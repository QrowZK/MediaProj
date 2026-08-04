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

  // opts: { format: 'copy'|'flac'|'alac'|'mp3_320'|'mp3_v0'|'aac_256', downsample: bool }
  async run(tracks, destDir, opts, onProgress) {
    const fmt = FORMATS[opts.format] || FORMATS.copy;
    const doneArtDirs = new Set();
    let exported = 0, skipped = 0, failed = 0;
    const failures = [];

    for (let i = 0; i < tracks.length; i++) {
      if (this.cancelled) break;
      const track = tracks[i];
      onProgress({ done: i, total: tracks.length, file: `${track.artist} — ${track.title}` });
      try {
        const { albumDir, filePath } = buildDestPath(destDir, track, fmt);
        await fsp.mkdir(albumDir, { recursive: true });
        await this._writeAlbumArt(track, albumDir, doneArtDirs);

        let already = false;
        try { already = (await fsp.stat(filePath)).size > 0; } catch { /* doesn't exist yet */ }
        if (already) { skipped++; continue; }

        if (opts.format === 'copy' || !fmt.args) {
          await fsp.copyFile(track.path, filePath);
        } else {
          await this._runFfmpeg([
            '-y', '-v', 'error', '-i', track.path, '-map_metadata', '0', '-vn',
            ...fmt.args(!!opts.downsample), filePath,
          ]);
        }
        exported++;
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
