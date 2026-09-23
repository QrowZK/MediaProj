'use strict';

// Loudness analysis + ReplayGain tagging.
//
// Runs ffmpeg's `ebur128` filter once per track to measure integrated loudness
// (I, LUFS), loudness range (LRA, LU), and true peak (dBTP), then derives
// ReplayGain 2.0 values against the -18 LUFS reference. Album gain gates over
// every 400 ms block of every track on the album together, as BS.1770 / rsgain
// do — the same pass logs each block's loudness, so nothing is decoded twice
// (averaging the tracks' already-gated loudness, the old shortcut, drifts on
// albums with quiet tracks or long fades). Album peak is the loudest track's.
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

// BS.1770 gating: blocks under -70 LUFS are dropped outright, then blocks more
// than 10 LU below the loudness of what's left.
const ABS_GATE_LUFS = -70;
const REL_GATE_LU = -10;

// ebur128 logs one line per 100 ms whose M: is the loudness of the 400 ms
// block ending there — exactly the overlapping gating blocks of BS.1770.
// Before the first block fills it prints -120.7, which the absolute gate drops.
// Blocks are kept as a histogram of their 0.1 LU log values (bin → count).
function addBlockFromLine(line, hist) {
  const m = /\bM:\s*(-?[\d.]+|-?inf)/.exec(line);
  if (!m || !/\bt:\s*[\d.]/.test(line)) return;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v < ABS_GATE_LUFS) return;
  const bin = Math.round(v * 10);
  hist.set(bin, (hist.get(bin) || 0) + 1);
}

// Integrated loudness over the union of the given block histograms (one per
// track for an album), or null if every block was gated out.
function gatedLoudness(hists) {
  let e = 0, n = 0;
  for (const h of hists) for (const [bin, count] of h) { e += count * Math.pow(10, bin / 100); n += count; }
  if (!n) return null;
  const relGate = 10 * Math.log10(e / n) + REL_GATE_LU;
  e = 0; n = 0;
  for (const h of hists) {
    for (const [bin, count] of h) {
      if (bin / 10 < relGate) continue;
      e += count * Math.pow(10, bin / 100);
      n += count;
    }
  }
  return n ? 10 * Math.log10(e / n) : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const gainStr = (db) => `${db > 0 ? '+' : ''}${db.toFixed(2)} dB`;
const peakStr = (lin) => lin.toFixed(6);

class LoudnessAnalyzer {
  constructor() {
    this.cancelled = false;
    this.currentChild = null;
    this._blocks = new Map(); // trackId → gating-block histogram (this run only)
  }

  cancel() {
    this.cancelled = true;
    try { this.currentChild?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // onLine, when given, sees every complete stderr line as it arrives.
  _runFfmpeg(args, { capture = 'stderr', onLine = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) return reject(new Error('Bundled ffmpeg is unavailable on this install'));
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.currentChild = child;
      let buf = '';
      let partial = '';
      // ebur128's summary is at the very end; keep a generous tail.
      child.stderr.on('data', (d) => {
        buf = (buf + d).slice(capture === 'stderr' ? -16000 : -4000);
        if (onLine) {
          const lines = (partial + d).split(/\r?\n|\r/);
          partial = lines.pop();
          for (const line of lines) onLine(line);
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        this.currentChild = null;
        if (onLine && partial) onLine(partial);
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
    // End the segment with atrim, which cuts at the exact sample: -t stops at
    // packet granularity, so up to one packet (~90 ms of FLAC) of the next
    // track got measured too — enough to skew a quiet or fading track by dBs.
    let trim = '';
    if (track.cue && track.cueEnd != null) {
      trim = `atrim=duration=${Math.max(0.001, track.cueEnd - (track.cueStart || 0))},`;
    }
    const blocks = new Map();
    const out = await this._runFfmpeg([
      '-nostdin', '-hide_banner', ...pre, '-i', track.path,
      '-map', 'a:0', '-af', `${trim}ebur128=peak=true:framelog=info`, '-f', 'null', '-',
    ], { onLine: (line) => addBlockFromLine(line, blocks) });
    const { integrated, lra, truePeak } = parseEbur128(out);
    if (integrated == null) throw new Error('no loudness measured (silent or undecodable)');
    // kept apart from the returned fields (which go into the library) and
    // dropped once the album math is done
    this._blocks.set(track.id, blocks);
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
    // A cue segment shares one physical file with the whole disc — there's no
    // per-segment tag slot, so the values live in Auralis's library only.
    if (track.cue) return { tagged: false, reason: 'cue segment — stored in library' };
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
      // Nothing on this album was measured this run: its stored album values
      // stand (and can't be recomputed without the blocks).
      if (!group.some((t) => this._blocks.has(t.id))) continue;
      // Some tracks were skipped as already analyzed (e.g. one new track
      // added to an album): measure them again for their blocks, or the album
      // figure would cover only part of the album.
      for (const t of group) {
        if (this.cancelled || this._blocks.has(t.id)) continue;
        onProgress({ done: total, total, file: `Album gain — ${t.title || path.basename(t.path)}` });
        try { measuredById[t.id] = await this._measure(t); } catch { /* keep its stored values */ }
      }
      if (this.cancelled) break;
      if (!group.every((t) => this._blocks.has(t.id))) continue;
      let peak = 0;
      for (const t of group) {
        const m = measuredById[t.id];
        if ((m.rgTrackPeak ?? 0) > peak) peak = m.rgTrackPeak;
      }
      const albumLufs = gatedLoudness(group.map((t) => this._blocks.get(t.id)));
      if (albumLufs == null) continue;
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

    this._blocks.clear();
    onProgress({ done: total, total, file: '' });
    return { ok: !this.cancelled, cancelled: this.cancelled, analyzed, skipped, tagged, failed, failures, results };
  }
}

module.exports = { LoudnessAnalyzer, RG2_REF_LUFS, gatedLoudness, addBlockFromLine, parseEbur128 };
