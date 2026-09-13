'use strict';

// Loudness analysis + ReplayGain tagging.
//
// Runs ffmpeg's `ebur128` filter once per track to measure integrated loudness
// (I, LUFS), loudness range (LRA, LU), and true peak (dBTP), then derives
// ReplayGain 2.0 values against the -18 LUFS reference. Album gain is the
// duration-weighted loudness of the album's measured tracks; album peak is the
// loudest track's peak — the standard single-decode approximation, so no track
// is decoded twice.
//
// Optionally embeds the values as tags. Only containers ffmpeg can rewrite
// losslessly with the conventional ReplayGain keys are tagged (FLAC/OGG/Opus
// Vorbis comments, MP3 ID3 TXXX); everything else is measured and stored in the
// library so playback still normalizes, but the file is left untouched and
// reported as not-tagged rather than risking a bad remux.

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

// ReplayGain 2.0 / EBU R128 reference level.
const RG2_REF_LUFS = -18;

// ext → { muxer } for the formats we can losslessly remux with RG tags.
const TAGGABLE = {
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.opus': 'opus',
  '.mp3': 'mp3',
};

// ffmpeg prints the ebur128 summary to stderr at end-of-stream. Pull the
// integrated loudness, loudness range, and (peak=true) true peak out of it.
function parseEbur128(stderr) {
  const num = (re) => {
    const m = stderr.match(re);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const integrated = num(/\bI:\s*(-?[\d.]+|-?inf)\s*LUFS/i);
  const lra = num(/\bLRA:\s*(-?[\d.]+)\s*LU\b/i);
  // Only the "True peak:" block prints a "Peak:" line (peak=true); anchor to it
  // so the LRA low/high lines can't be mistaken for it.
  const tpBlock = stderr.split(/True peak:/i)[1] || '';
  const truePeak = (() => {
    const m = tpBlock.match(/Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  })();
  return { integrated, lra, truePeak };
}

const round2 = (n) => Math.round(n * 100) / 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const gainStr = (db) => `${db > 0 ? '+' : ''}${db.toFixed(2)} dB`;
const peakStr = (lin) => lin.toFixed(6);

class LoudnessAnalyzer {
  constructor() {
    this.cancelled = false;
    this.currentChild = null;
  }

  cancel() {
    this.cancelled = true;
    try { this.currentChild?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  _runFfmpeg(args, { capture = 'stderr' } = {}) {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) return reject(new Error('Bundled ffmpeg is unavailable on this install'));
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.currentChild = child;
      let buf = '';
      // ebur128's summary is at the very end; keep a generous tail.
      child.stderr.on('data', (d) => { buf = (buf + d).slice(capture === 'stderr' ? -16000 : -4000); });
      child.on('error', reject);
      child.on('close', (code) => {
        this.currentChild = null;
        if (code === 0) resolve(buf);
        else if (this.cancelled) reject(new Error('cancelled'));
        else reject(new Error(buf.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      });
    });
  }

  async _measure(track) {
    const out = await this._runFfmpeg([
      '-nostdin', '-hide_banner', '-i', track.path,
      '-map', 'a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
    ]);
    const { integrated, lra, truePeak } = parseEbur128(out);
    if (integrated == null) throw new Error('no loudness measured (silent or undecodable)');
    const trackGain = round2(RG2_REF_LUFS - integrated);
    // true peak is the honest ceiling; fall back to 1.0 (0 dBFS) if absent.
    const trackPeak = round6(truePeak != null ? Math.pow(10, truePeak / 20) : 1);
    return {
      loudnessLufs: round2(integrated),
      loudnessRange: lra != null ? round2(lra) : null,
      truePeakDb: truePeak != null ? round2(truePeak) : null,
      replayGainTrack: trackGain,
      rgTrackPeak: trackPeak,
    };
  }

  // Embed track+album RG into the source file (supported containers only).
  // Writes to a .part sibling and renames on success so a failure or cancel
  // never leaves a truncated file in place.
  async _writeTags(track, m) {
    const ext = path.extname(track.path).toLowerCase();
    const muxer = TAGGABLE[ext];
    if (!muxer) return { tagged: false, reason: `tagging not supported for ${ext || 'this format'}` };
    // Vorbis comments are conventionally UPPERCASE; ID3 TXXX descriptions are
    // read lowercase by foobar2000/Rockbox/etc.
    const key = muxer === 'mp3'
      ? (n) => `replaygain_${n}`
      : (n) => `REPLAYGAIN_${n.toUpperCase()}`;
    const meta = [
      [key('track_gain'), gainStr(m.replayGainTrack)],
      [key('track_peak'), peakStr(m.rgTrackPeak)],
    ];
    if (m.replayGainAlbum != null) meta.push([key('album_gain'), gainStr(m.replayGainAlbum)]);
    if (m.rgAlbumPeak != null) meta.push([key('album_peak'), peakStr(m.rgAlbumPeak)]);

    const partPath = track.path + '.rgpart';
    await fsp.unlink(partPath).catch(() => {}); // stale from a previous run
    const args = ['-y', '-v', 'error', '-i', track.path, '-map', '0', '-c', 'copy', '-map_metadata', '0'];
    for (const [k, v] of meta) args.push('-metadata', `${k}=${v}`);
    args.push('-f', muxer, partPath);
    try {
      await this._runFfmpeg(args, { capture: 'err' });
      // Preserve the original mtime so the next library rescan doesn't treat a
      // tag-only rewrite as a content change and re-read everything.
      const st = await fsp.stat(track.path).catch(() => null);
      await fsp.rename(partPath, track.path);
      if (st) await fsp.utimes(track.path, st.atime, st.mtime).catch(() => {});
      return { tagged: true };
    } catch (err) {
      await fsp.unlink(partPath).catch(() => {});
      return { tagged: false, reason: err.message };
    }
  }

  // opts: { writeTags: bool, force: bool }
  // onProgress({ done, total, file })
  // Returns { ok, cancelled, analyzed, skipped, tagged, failed, failures, results }
  // where results is a map of trackId → measured fields to merge into the library.
  async run(tracks, opts, onProgress) {
    const force = !!opts.force;
    const results = {};
    let analyzed = 0, skipped = 0, tagged = 0, failed = 0;
    const failures = [];

    // Only (re)measure what needs it, but keep every input track for album
    // grouping so album gain reflects the whole album, not just new tracks.
    const measuredById = {};
    const total = tracks.length;
    for (let i = 0; i < tracks.length; i++) {
      if (this.cancelled) break;
      const track = tracks[i];
      onProgress({ done: i, total, file: `${track.artist || ''} — ${track.title || path.basename(track.path)}` });
      if (!force && track.replayGainTrack != null && track.loudnessLufs != null) {
        // already analyzed by us — reuse for album math, don't re-decode
        measuredById[track.id] = {
          loudnessLufs: track.loudnessLufs,
          loudnessRange: track.loudnessRange ?? null,
          truePeakDb: track.truePeakDb ?? null,
          replayGainTrack: track.replayGainTrack,
          rgTrackPeak: track.rgTrackPeak ?? 1,
        };
        skipped++;
        continue;
      }
      try {
        measuredById[track.id] = await this._measure(track);
        analyzed++;
      } catch (err) {
        if (this.cancelled) break;
        failed++;
        failures.push({ title: track.title || path.basename(track.path), error: err.message });
      }
    }

    // Album gain: duration-weighted loudness across an album's measured tracks.
    const albumGroups = new Map(); // albumKey → [track...]
    for (const t of tracks) {
      if (!measuredById[t.id]) continue;
      const k = t.albumKey || `${t.albumArtist || t.artist}::${t.album}`.toLowerCase();
      if (!albumGroups.has(k)) albumGroups.set(k, []);
      albumGroups.get(k).push(t);
    }
    const albumById = {};
    for (const group of albumGroups.values()) {
      // Album gain only makes sense with the album in hand. Analyzing a lone
      // track (context-menu) must not overwrite a good album value with a
      // single-track one — playback falls back to track gain in album mode.
      if (group.length < 2) continue;
      let energy = 0, dur = 0, peak = 0;
      for (const t of group) {
        const m = measuredById[t.id];
        const d = t.duration || 1;
        energy += d * Math.pow(10, m.loudnessLufs / 10);
        dur += d;
        if ((m.rgTrackPeak ?? 0) > peak) peak = m.rgTrackPeak;
      }
      if (dur <= 0 || energy <= 0) continue;
      const albumLufs = 10 * Math.log10(energy / dur);
      const albumGain = round2(RG2_REF_LUFS - albumLufs);
      const albumPeak = round6(peak);
      for (const t of group) {
        albumById[t.id] = { replayGainAlbum: albumGain, rgAlbumPeak: albumPeak };
      }
    }

    // Assemble final per-track results and optionally write tags.
    const analyzedAt = Date.now();
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const m = measuredById[track.id];
      if (!m) continue;
      const merged = { ...m, ...(albumById[track.id] || {}), loudnessAnalyzedAt: analyzedAt };
      results[track.id] = merged;
      if (opts.writeTags && !this.cancelled) {
        onProgress({ done: i, total, file: `Tagging — ${track.title || path.basename(track.path)}` });
        const r = await this._writeTags(track, merged);
        if (r.tagged) { tagged++; merged.rgTagged = true; }
        else if (r.reason) merged.rgTagReason = r.reason;
      }
    }

    onProgress({ done: total, total, file: '' });
    return { ok: !this.cancelled, cancelled: this.cancelled, analyzed, skipped, tagged, failed, failures, results };
  }
}

module.exports = { LoudnessAnalyzer, RG2_REF_LUFS };
