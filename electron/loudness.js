'use strict';

// Loudness analysis + ReplayGain.
//
// Runs ffmpeg's `ebur128` filter once per track to measure integrated loudness
// (I, LUFS), loudness range (LRA, LU), and true peak (dBTP), then derives
// ReplayGain 2.0 values against the -18 LUFS reference. Album gain is the
// duration-weighted loudness of the album's measured tracks; album peak is the
// loudest track's peak — the standard single-decode approximation, so no track
// is decoded twice.
//
// The values are stored in Auralis's library only; source files are never
// modified. (Remuxing with ffmpeg to embed tags altered other metadata:
// merged multi-value fields, dropped FLAC/APE/ID3v1 blocks, ID3v2.3 → v2.4.)

const { spawn } = require('child_process');
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

// ffmpeg prints the ebur128 summary to stderr at end-of-stream. Pull the
// integrated loudness, loudness range, and (peak=true) true peak out of it.
function parseEbur128(raw) {
  // ebur128 also logs a running "… I: x LUFS  LRA: y LU" line every 100ms;
  // only the final Summary block holds the measured values. Parsing the whole
  // tail took the first per-frame line — for short tracks the t=0.1s reading
  // of -70 LUFS, i.e. a +52 dB "gain".
  const at = raw.lastIndexOf('Summary:');
  const stderr = at >= 0 ? raw.slice(at) : '';
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

class LoudnessAnalyzer {
  constructor() {
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
      let buf = '';
      // ebur128's summary is at the very end; keep a generous tail.
      child.stderr.on('data', (d) => { buf = (buf + d).slice(-16000); });
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
    // Cue segment: measure only [cueStart, cueEnd) of the shared file, not the
    // whole thing, or every track on the disc reports the same loudness.
    const pre = [];
    if (track.cue) {
      const start = track.cueStart || 0;
      if (start > 0.05) pre.push('-ss', String(start));
    }
    const post = [];
    if (track.cue && track.cueEnd != null) {
      post.push('-t', String(Math.max(0.001, track.cueEnd - (track.cueStart || 0))));
    }
    const out = await this._runFfmpeg([
      '-nostdin', '-hide_banner', ...pre, '-i', track.path,
      '-map', 'a:0', '-af', 'ebur128=peak=true', ...post, '-f', 'null', '-',
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

  // opts: { force: bool }
  // onProgress({ done, total, file })
  // Returns { ok, cancelled, analyzed, skipped, failed, failures, results }
  // where results is a map of trackId → measured fields to merge into the library.
  async run(tracks, opts, onProgress) {
    const force = !!opts.force;
    const results = {};
    let analyzed = 0, skipped = 0, failed = 0;
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

    // Assemble final per-track results for the library.
    const analyzedAt = Date.now();
    for (const track of tracks) {
      const m = measuredById[track.id];
      if (!m) continue;
      results[track.id] = { ...m, ...(albumById[track.id] || {}), loudnessAnalyzedAt: analyzedAt };
    }

    onProgress({ done: total, total, file: '' });
    return { ok: !this.cancelled, cancelled: this.cancelled, analyzed, skipped, failed, failures, results };
  }
}

module.exports = { LoudnessAnalyzer, RG2_REF_LUFS };
