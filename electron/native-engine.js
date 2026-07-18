'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Auralis native output engine
// ffmpeg decode → float64 DSP (ReplayGain · EQ · speaker correction) →
// RtAudio stream on the selected host API (ASIO / WASAPI / DirectSound on
// Windows). Bit-perfect mode decodes straight to 32-bit integer PCM and
// bypasses every DSP stage and the software volume.
// ═══════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fsPromises = require('fs').promises;

let audify = null;
let ffmpegPath = null;
try {
  audify = require('audify');
  ffmpegPath = require('ffmpeg-static');
  // In a packaged app these live outside the asar
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch { /* native backend unavailable on this install */ }

// Optional WASAPI-exclusive addon (Windows only, compiled in CI). Loaded
// dynamically; everything degrades to the RtAudio path when absent.
let wasapiEx = null;
if (process.platform === 'win32') {
  try {
    wasapiEx = require('../native-addons/wasapi-exclusive');
    if (wasapiEx && !wasapiEx.available) wasapiEx = null;
  } catch { wasapiEx = null; }
}

const API_LABELS = {
  WINDOWS_ASIO: 'ASIO',
  WINDOWS_WASAPI: 'WASAPI',
  WINDOWS_DS: 'DirectSound',
  MACOSX_CORE: 'CoreAudio',
  LINUX_ALSA: 'ALSA',
  LINUX_PULSE: 'PulseAudio',
  UNIX_JACK: 'JACK',
};

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// RtAudio stream flags. The TS enum is a `const enum` (inlined, no runtime
// object), so use the numeric bit values directly.
const RTAUDIO_FLAGS = {
  NONINTERLEAVED: 0x1,
  MINIMIZE_LATENCY: 0x2,
  HOG_DEVICE: 0x4,
  SCHEDULE_REALTIME: 0x8,
};

// audify's RtAudio constructor does info[0].As<Number>() whenever ANY argument
// is present, so `new RtAudio(undefined)` throws "A number was expected".
// Only pass the api when it is a real number; otherwise call with no arguments
// so the default host API is chosen. If the requested API has no output
// devices (stale saved id, driver removed, API not compiled in), fall back to
// the default host API rather than failing every subsequent call.
function makeRtAudio(api) {
  const n = Number(api);
  const wantSpecific = !(api === undefined || api === null || api === 'default' || Number.isNaN(n));
  if (wantSpecific) {
    try {
      const rt = new audify.RtAudio(n);
      if (rt.getDevices().some((d) => d.outputChannels > 0)) return rt;
    } catch { /* fall through to default */ }
  }
  return new audify.RtAudio();
}

// RtAudio reports warnings (type 0/1) through the same stream error callback
// as real failures — "no open stream to close!", "no compiled support for
// specified API", underrun notices. Those must never surface as user-facing
// errors.
const RTAUDIO_WARNING_TYPES = new Set([0, 1]);

// ── float64 biquad (RBJ cookbook), direct form II transposed ─────────────

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }

  static peaking(fs, f0, dbGain, q) {
    const bq = new Biquad();
    const A = Math.pow(10, dbGain / 40);
    const w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha / A;
    bq.b0 = (1 + alpha * A) / a0;
    bq.b1 = (-2 * cosw) / a0;
    bq.b2 = (1 - alpha * A) / a0;
    bq.a1 = (-2 * cosw) / a0;
    bq.a2 = (1 - alpha / A) / a0;
    return bq;
  }

  static shelf(fs, f0, dbGain, low) {
    const bq = new Biquad();
    const A = Math.pow(10, dbGain / 40);
    const w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / 2 * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    if (low) {
      b0 = A * ((A + 1) - (A - 1) * cosw + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - sq);
      a0 = (A + 1) + (A - 1) * cosw + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - sq;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cosw + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - sq);
      a0 = (A + 1) - (A - 1) * cosw + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - sq;
    }
    bq.b0 = b0 / a0; bq.b1 = b1 / a0; bq.b2 = b2 / a0;
    bq.a1 = a1 / a0; bq.a2 = a2 / a0;
    return bq;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// ── tiny radix-2 FFT for the spectrum feed ───────────────────────────────

function fftMagnitudes(samples) {
  const n = samples.length; // power of two
  const re = Float64Array.from(samples);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mags = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]) / (n / 2);
  return mags;
}

// ── engine ───────────────────────────────────────────────────────────────

const FRAME_QUEUE_TARGET = 6; // frames kept queued in RtAudio

// ── dithered quantization (f64 → integer PCM) ───────────────────────────
// TPDF dither at ±1 LSB, optional 2nd-order noise shaping (error feedback
// with H(z) = 1 - 2z⁻¹ + z⁻², pushing quantization noise out of the audible
// band). State kept per channel.

class Quantizer {
  constructor(bits, channels, dither) {
    this.bits = bits;               // 16, 24, or 32
    this.channels = channels;
    this.dither = dither;           // 'off' | 'tpdf' | 'ns'
    this.scale = Math.pow(2, bits - 1) - 1;
    this.e1 = new Float64Array(channels);
    this.e2 = new Float64Array(channels);
  }

  // quantize interleaved f64 to the wire format:
  // 16-bit → Int16Array; 24/32-bit → Int32Array (24-bit left-justified)
  process(f64) {
    const n = f64.length;
    const out = this.bits === 16 ? new Int16Array(n) : new Int32Array(n);
    const { scale, channels, dither } = this;
    const shift = this.bits === 16 ? 0 : 32 - this.bits;
    for (let i = 0; i < n; i++) {
      const ch = i % channels;
      const xs = f64[i] * scale; // LSB domain
      // noise-shaped target: xs + 2e[n-1] − e[n-2] → noise transfer (1−z⁻¹)²
      const shaped = dither === 'ns' ? xs + 2 * this.e1[ch] - this.e2[ch] : xs;
      const d = (dither === 'tpdf' || dither === 'ns')
        ? (Math.random() - Math.random()) // TPDF, ±1 LSB
        : 0;
      let q = Math.round(shaped + d);
      if (dither === 'ns') {
        this.e2[ch] = this.e1[ch];
        this.e1[ch] = shaped - q; // error feedback (excl. dither → dither stays white)
      }
      if (q > scale) q = scale;
      else if (q < -scale - 1) q = -scale - 1;
      out[i] = shift ? (q << shift) : q;
    }
    return Buffer.from(out.buffer);
  }
}

// ── DSF / DFF readers + DoP packer (native DSD output) ──────────────────
// DoP (DSD-over-PCM) packs 16 DSD bits per channel into 24-bit PCM frames
// with an alternating 0x05/0xFA marker byte; a DoP-aware DAC unwraps the
// original 1-bit stream untouched.

function parseDsfHeader(buf) {
  // DSF layout: 'DSD ' chunk (28 bytes) → 'fmt ' chunk (52) → 'data' header (12)
  if (buf.length < 92 || buf.toString('ascii', 0, 4) !== 'DSD ') return null;
  if (buf.toString('ascii', 28, 32) !== 'fmt ') return null;
  return {
    container: 'dsf',
    channels: buf.readUInt32LE(52),
    sampleRate: buf.readUInt32LE(56),        // DSD bit rate, e.g. 2822400 (DSD64)
    bitsPerSample: buf.readUInt32LE(60),     // 1 = LSB-first (typical), 8 = MSB-first
    sampleCount: Number(buf.readBigUInt64LE(64)),
    blockSize: buf.readUInt32LE(72),         // bytes per channel per block (4096)
    dataStart: 92,
  };
}

const DOP_MARKERS = [0x05, 0xFA];

// Reverse-bit lookup for LSB-first DSF data (DoP wants MSB-first bytes)
const BIT_REVERSE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b);
  BIT_REVERSE[i] = r;
}

// Pack one DSF block pair (per-channel byte arrays, MSB-first) into DoP s32
// frames: sample32 = (marker<<16 | dsdByte0<<8 | dsdByte1) << 8.
function packDop(channelBytes, markerPhase) {
  const channels = channelBytes.length;
  const frames = Math.floor(channelBytes[0].length / 2);
  const out = new Int32Array(frames * channels);
  let phase = markerPhase;
  for (let f = 0; f < frames; f++) {
    const marker = DOP_MARKERS[phase & 1];
    for (let ch = 0; ch < channels; ch++) {
      const b0 = channelBytes[ch][f * 2];
      const b1 = channelBytes[ch][f * 2 + 1];
      out[f * channels + ch] = ((marker << 16) | (b0 << 8) | b1) << 8;
    }
    phase++;
  }
  return { buffer: Buffer.from(out.buffer), markerPhase: phase & 1 };
}

// Benign RtAudio chatter that must never surface as a user-facing error,
// regardless of which path it arrives through.
const BENIGN_ERROR_RE = /no open stream|no compiled support|searching for a working|stream was closed/i;

class NativeAudioEngine {
  constructor(emit) {
    this.rawEmit = emit;
    this.emit = (channel, payload) => {
      if (channel === 'native:error') {
        if (!payload?.message || BENIGN_ERROR_RE.test(payload.message)) return;
        // errors during a config-change restart shouldn't advance the queue
        if (Date.now() < (this.restartUntil || 0)) payload = { ...payload, transient: true };
      }
      this.rawEmit(channel, payload);
    };
    this.restartUntil = 0;
    this._enumCache = new Map(); // key → { at, value }
    this.rt = null;
    this.stream = null;      // { api, deviceId, sampleRate, channels, bitPerfect, frameSize, bytesPerSample }
    this.decoder = null;     // current ffmpeg child
    this.pcmQueue = [];      // Buffers of decoded (and DSP'd) PCM, frame-sized
    this.residual = Buffer.alloc(0);
    this.decodeEnded = false;
    this.playing = false;
    this.currentTrack = null;
    this.nextTrack = null;
    this.startOffset = 0;    // seconds already consumed before streamTime baseline
    this.framesWritten = 0;
    this.config = {
      api: 'default', deviceId: -1, bitPerfect: false, bufferSize: 512,
      volume: 0.8, replayGain: 'off',
      eqEnabled: false, eqGains: new Array(10).fill(0),
      correction: null,           // { enabled, channels[], irPath }
      resample: { mode: 'off', rate: 96000, precision: 28 }, // soxr SRC
      outputFormat: 'f32',        // 'f32' | 's32' | 's24' | 's16' (DSP path)
      dither: 'off',              // 'off' | 'tpdf' | 'ns' (int outputs)
      dsdMode: 'pcm',             // 'pcm' (176.4k convert) | 'dop'
      wasapiExclusive: false,     // route through the exclusive-mode addon
    };
    this.dspState = null;
    this.quantizer = null;
    this.wexHandle = null;       // active WASAPI-exclusive stream handle
    this.wexPump = null;
    this.dop = null;             // active DoP reader state
    this.fftAccum = [];
    this.lastViz = 0;
    this.progressTimer = null;
  }

  get wasapiExclusiveAvailable() { return !!wasapiEx; }

  get available() { return !!(audify && ffmpegPath); }

  // The bundled Windows ffmpeg lacks libsoxr (the Linux build has it), so
  // probe once and fall back to swresample with a large filter when absent.
  async probeSoxr() {
    if (this._soxr !== undefined) return this._soxr;
    this._soxr = await new Promise((resolve) => {
      try {
        const child = spawn(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:d=0.05',
          '-af', 'aresample=44100:resampler=soxr', '-f', 'null', '-'], { stdio: 'ignore' });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
        setTimeout(() => { try { child.kill(); } catch { /* done */ } resolve(false); }, 5000);
      } catch { resolve(false); }
    });
    return this._soxr;
  }

  _resampleFilter(rate) {
    const c = this.config;
    return this._soxr
      ? `aresample=${rate}:resampler=soxr:precision=${c.resample?.precision || 28}`
      : `aresample=${rate}:filter_size=256:cutoff=0.96`;
  }

  _cached(key, compute) {
    const hit = this._enumCache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.value;
    const value = compute();
    this._enumCache.set(key, { at: Date.now(), value });
    return value;
  }

  listApis() {
    if (!this.available) return [];
    // Cached: probing constructs throwaway RtAudio instances whose destructors
    // fire closeStream() warnings — keep the churn to once per 30s.
    return this._cached('apis', () => {
      const apis = [];
      for (const [name, id] of Object.entries(audify.RtAudioApi)) {
        if (name === 'UNSPECIFIED' || name === 'RTAUDIO_DUMMY') continue;
        try {
          const rt = makeRtAudio(id);
          if (rt.getDevices().filter((d) => d.outputChannels > 0).length > 0) {
            apis.push({ id, name, label: API_LABELS[name] || name });
          }
        } catch { /* API not functional on this machine */ }
      }
      return apis;
    });
  }

  listDevices(apiId) {
    if (!this.available) return [];
    return this._cached('devices:' + apiId, () => this._listDevicesUncached(apiId));
  }

  _listDevicesUncached(apiId) {
    try {
      const rt = makeRtAudio(apiId);
      return rt.getDevices()
        .map((d, idx) => ({ ...d, index: d.id ?? idx }))
        .filter((d) => d.outputChannels > 0)
        .map((d) => ({
          id: d.index, name: d.name,
          sampleRates: d.sampleRates, preferredSampleRate: d.preferredSampleRate,
          isDefault: !!d.isDefaultOutput, channels: d.outputChannels,
        }));
    } catch {
      return [];
    }
  }

  _outputKey() {
    const c = this.config;
    return JSON.stringify([c.api, c.deviceId, c.bitPerfect, c.bufferSize,
      c.outputFormat, c.dither, c.resample, c.dsdMode, c.wasapiExclusive,
      c.correction?.enabled ? c.correction.irPath : null]);
  }

  setConfig(partial) {
    const wasOutput = this._outputKey();
    Object.assign(this.config, partial);
    try {
      if (this.rt?.isStreamOpen() && !this.config.bitPerfect) {
        this.rt.outputVolume = Math.pow(this.config.volume, 2);
      }
    } catch { /* stream mid-teardown */ }
    if (wasOutput !== this._outputKey() && this.currentTrack) {
      // output target / pipeline topology changed mid-play: restart in place.
      // Failures inside this window are flagged transient so the UI doesn't
      // advance the queue over a settings tweak.
      this.restartUntil = Date.now() + 2500;
      const pos = this.getPosition();
      const track = this.currentTrack;
      this.play(track, pos).catch((err) => {
        this.emit('native:error', { message: err.message });
      });
    } else if (this.dspState) {
      this._buildDsp(this.dspState.fs, this.dspState.channels);
    }
    this._emitSignalPath();
  }

  setNext(track) { this.nextTrack = track; }

  // ── DSP chain construction ──

  _buildDsp(fs, channels) {
    const c = this.config;
    const state = { fs, channels, chains: [] };
    for (let ch = 0; ch < channels; ch++) {
      const chain = { biquads: [], gain: 1, delaySamples: 0, delayBuf: null, delayIdx: 0 };
      if (c.eqEnabled) {
        EQ_FREQUENCIES.forEach((f, i) => {
          const g = c.eqGains[i] || 0;
          if (g === 0) return;
          if (i === 0) chain.biquads.push(Biquad.shelf(fs, f, g, true));
          else if (i === EQ_FREQUENCIES.length - 1) chain.biquads.push(Biquad.shelf(fs, f, g, false));
          else chain.biquads.push(Biquad.peaking(fs, f, g, 1.1));
        });
        const maxBoost = Math.max(0, ...c.eqGains);
        if (maxBoost > 0) chain.gain *= Math.pow(10, -maxBoost / 40);
      }
      const corr = c.correction?.enabled ? (c.correction.channels?.[ch] || {}) : null;
      if (corr) {
        const linear = Math.pow(10, (corr.gain || 0) / 20);
        chain.gain *= corr.invert ? -linear : linear;
        chain.delaySamples = Math.round((corr.delayMs || 0) / 1000 * fs);
        if (chain.delaySamples > 0) {
          chain.delayBuf = new Float64Array(chain.delaySamples);
        }
        for (const band of (corr.peq || [])) {
          if (band.freq) chain.biquads.push(Biquad.peaking(fs, band.freq, band.gain || 0, band.q || 1));
        }
      }
      state.chains.push(chain);
    }
    this.dspState = state;
  }

  _processBlock(f64) {
    // f64: interleaved Float64Array. Applies ReplayGain + per-channel chains.
    const { channels, chains } = this.dspState;
    let rg = 1;
    const t = this.currentTrack;
    if (t && this.config.replayGain === 'track' && t.replayGainTrack != null) {
      rg = Math.pow(10, t.replayGainTrack / 20);
    } else if (t && this.config.replayGain === 'album') {
      rg = Math.pow(10, (t.replayGainAlbum ?? t.replayGainTrack ?? 0) / 20);
    }
    const frames = f64.length / channels;
    for (let ch = 0; ch < channels; ch++) {
      const chain = chains[ch];
      for (let i = 0; i < frames; i++) {
        let s = f64[i * channels + ch] * rg * chain.gain;
        for (const bq of chain.biquads) s = bq.process(s);
        if (chain.delayBuf) {
          const delayed = chain.delayBuf[chain.delayIdx];
          chain.delayBuf[chain.delayIdx] = s;
          chain.delayIdx = (chain.delayIdx + 1) % chain.delaySamples;
          s = delayed;
        }
        f64[i * channels + ch] = s;
      }
    }
    return f64;
  }

  // ── stream / decode lifecycle ──

  // Decide the concrete output plan for a track under the current config.
  _planFor(track) {
    const c = this.config;
    const channels = Math.min(2, track.channels || 2);
    const srcRate = track.sampleRate || 44100;

    // Native DSD via DoP: DSF only (parsed in-process), bit stream untouched.
    if (track.dsd && c.dsdMode === 'dop' && /\.dsf$/i.test(track.path || '')) {
      return {
        mode: 'dop', channels,
        outRate: Math.round((srcRate || 2822400) / 16),
        format: 's32', // DoP frames ride in the 24-in-32 container
      };
    }
    if (c.bitPerfect && !track.dsd) {
      return { mode: 'bitperfect', channels, outRate: srcRate, format: 's32' };
    }
    // DSP path (DSD converts to high-rate PCM first)
    const decodeRate = track.dsd ? 176400 : srcRate;
    const outRate = (c.resample?.mode === 'rate' && c.resample.rate)
      ? c.resample.rate
      : decodeRate;
    return { mode: 'dsp', channels, outRate, decodeRate, format: c.outputFormat || 'f32' };
  }

  async play(track, startAt = 0) {
    if (!this.available) throw new Error('Native output backend not available');
    this.stopDecoder();
    this.pcmQueue = [];
    this.residual = Buffer.alloc(0);
    this.decodeEnded = false;
    this.currentTrack = track;
    this.framesWritten = 0;
    this.startOffset = startAt;
    this.dop = null;

    const c = this.config;
    const plan = this._planFor(track);
    // WASAPI-exclusive path can only carry integer formats
    const useWex = c.wasapiExclusive && wasapiEx;
    if (useWex && plan.format === 'f32') plan.format = 's32';

    // mode MUST be part of this check: bit-perfect and s32-DSP share a wire
    // format, but the byte parser, quantizer, volume, and viz all branch on
    // mode — reusing the stream across a mode flip feeds f64 bytes into an
    // s32 parser (loud static) and strands the volume/meters.
    const needOpen = !this.stream ||
      this.stream.outRate !== plan.outRate ||
      this.stream.channels !== plan.channels ||
      this.stream.format !== plan.format ||
      this.stream.mode !== plan.mode ||
      this.stream.backend !== (useWex ? 'wasapi-ex' : 'rtaudio');
    if (needOpen) {
      try {
        this._openStream(plan, useWex);
      } catch (err) {
        if (!useWex) throw err;
        // exclusive mode refused (format/rate/device busy) → shared fallback
        this.emit('native:error', {
          message: `Exclusive mode unavailable (${err.message}) — using shared output`,
        });
        if (plan.format !== 'f32' && plan.mode === 'dsp' && (this.config.outputFormat || 'f32') === 'f32') {
          plan.format = 'f32'; // undo the exclusive-only int coercion
        }
        this._openStream(plan, false);
      }
    }

    this._buildDsp(plan.outRate, plan.channels);
    // The exclusive addon may negotiate a different wire format than requested
    const wireFormat = this.stream.wireFormat || plan.format;
    this.quantizer = (wireFormat === 'f32' || plan.mode !== 'dsp')
      ? null
      : new Quantizer({ s16: 16, s24: 24, s32: 32 }[wireFormat], plan.channels, c.dither || 'off');

    await this.probeSoxr();
    if (plan.mode === 'dop') this._startDopReader(track, startAt, plan);
    else this._spawnDecoder(track, startAt, plan);

    this.playing = true;
    this._outStart();
    this._primeQueue();
    this._startProgress();
    this.emit('native:state', { playing: true });
    if (plan.mode !== 'dsp') {
      // no DSP taps on this path — blank the meters instead of freezing them
      this.emit('native:viz', { levels: [0, 0], spectrum: new Array(512).fill(0) });
    }
    this._emitSignalPath();
  }

  // ── output backends: RtAudio (shared/ASIO/DS) or WASAPI-exclusive addon ──

  _openStream(plan, useWex) {
    const c = this.config;
    this._outClose();
    if (useWex) {
      const res = wasapiEx.open({
        deviceId: typeof c.deviceId === 'string' ? c.deviceId : '',
        sampleRate: plan.outRate,
        channels: plan.channels,
        bits: plan.format === 's16' ? 16 : plan.format === 's24' ? 24 : 32,
        // generous device period: exclusive-mode underruns are audible pops
        // and music playback doesn't need sub-50ms latency
        bufferMs: Math.max(50, Math.round((c.bufferSize || 512) / plan.outRate * 1000)),
      });
      this.wexHandle = res.handle;
      this.stream = {
        backend: 'wasapi-ex', outRate: plan.outRate, channels: plan.channels,
        format: plan.format, mode: plan.mode,
        frameSize: res.bufferFrames || c.bufferSize || 512,
        wireFormat: res.format,
      };
      // exclusive mode has no session volume — samples go out untouched
      return;
    }

    this.rt = makeRtAudio(c.api);
    const deviceId = c.deviceId >= 0 ? c.deviceId : this.rt.getDefaultOutputDevice();
    const format = plan.format === 'f32' ? audify.RtAudioFormat.RTAUDIO_FLOAT32
                 : plan.format === 's16' ? audify.RtAudioFormat.RTAUDIO_SINT16
                 : audify.RtAudioFormat.RTAUDIO_SINT32;
    // Stream flags MUST be a number — audify's binding does info[8].As<Number>()
    // unconditionally once an errorCallback follows it, so passing `undefined`
    // throws "A number was expected". Bit-perfect/DoP additionally request
    // HOG_DEVICE (best-effort exclusive access; ignored where unsupported).
    const flags = plan.mode !== 'dsp'
      ? (RTAUDIO_FLAGS.MINIMIZE_LATENCY | RTAUDIO_FLAGS.HOG_DEVICE)
      : RTAUDIO_FLAGS.MINIMIZE_LATENCY;
    const frameSize = this.rt.openStream(
      { deviceId, nChannels: plan.channels, firstChannel: 0 },
      null, format, plan.outRate, c.bufferSize || 512, 'Auralis',
      null,
      () => this._pump(),
      flags,
      (type, msg) => {
        if (RTAUDIO_WARNING_TYPES.has(type)) return; // warnings are not errors
        this.emit('native:error', { message: msg });
      },
    );
    this.rt.outputVolume = plan.mode !== 'dsp' ? 1 : Math.pow(c.volume, 2);
    this.stream = {
      backend: 'rtaudio', outRate: plan.outRate, channels: plan.channels,
      format: plan.format, mode: plan.mode,
      frameSize: frameSize || c.bufferSize || 512,
    };
  }

  _outStart() {
    if (this.stream?.backend === 'wasapi-ex') {
      // Don't start the device on an empty ring — that guarantees an initial
      // burst of underrun pops on every play/seek/format change. The pump
      // starts the clock once the ring is half-primed.
      this.wexStarted = false;
      if (!this.wexPump) {
        this.wexPump = setInterval(() => this._fill(), 10);
      }
      this._fill();
    } else if (this.rt && !this.rt.isStreamRunning()) {
      this.rt.start();
    }
  }

  _outStop() {
    if (this.stream?.backend === 'wasapi-ex') {
      clearInterval(this.wexPump); this.wexPump = null;
      try { wasapiEx.stop(this.wexHandle); } catch { /* fine */ }
    } else if (this.rt) {
      // guard: RtAudio warns "no open stream" through the error callback
      try { if (this.rt.isStreamOpen() && this.rt.isStreamRunning()) this.rt.stop(); } catch { /* fine */ }
    }
  }

  _outClose() {
    this._outStop();
    if (this.wexHandle != null) {
      try { wasapiEx.close(this.wexHandle); } catch { /* fine */ }
      this.wexHandle = null;
    }
    if (this.rt) {
      try { if (this.rt.isStreamOpen()) this.rt.closeStream(); } catch { /* fine */ }
      this.rt = null;
    }
    this.stream = null;
  }

  _outWrite(buf) {
    if (this.stream?.backend === 'wasapi-ex') wasapiEx.write(this.wexHandle, buf);
    else this.rt.write(buf);
  }

  _outQueuedFrames() {
    if (this.stream?.backend === 'wasapi-ex') {
      try { return wasapiEx.queued(this.wexHandle); } catch { return 0; }
    }
    return 0; // RtAudio path uses the frame-callback pull model instead
  }

  _outLatencyFrames() {
    if (this.stream?.backend === 'wasapi-ex') return this._outQueuedFrames();
    return this.rt?.getStreamLatency?.() || 0;
  }

  // ── decode: ffmpeg with SoX resampling + FIR room convolution ──

  _spawnDecoder(track, startAt, plan) {
    const c = this.config;
    const args = ['-v', 'error', '-nostdin'];
    if (startAt > 0.05) args.push('-ss', String(startAt));
    args.push('-i', track.path);

    const irPath = plan.mode === 'dsp' && c.correction?.enabled && c.correction.irPath;
    if (irPath) args.push('-i', c.correction.irPath);

    if (plan.mode === 'bitperfect') {
      args.push('-map', 'a:0', '-ac', String(plan.channels),
        '-f', 's32le', '-acodec', 'pcm_s32le');
    } else {
      // Rate conversion (soxr when available, high-quality swr otherwise) and
      // afir impulse-response convolution, at C speed inside ffmpeg.
      const decodeRate = plan.decodeRate || plan.outRate;
      const needsResample = plan.outRate !== decodeRate;
      const layout = plan.channels === 1 ? 'mono' : 'stereo';
      if (irPath) {
        const main = (needsResample ? this._resampleFilter(plan.outRate) + ',' : '') +
          `aformat=channel_layouts=${layout}:sample_rates=${plan.outRate}`;
        args.push('-filter_complex',
          `[0:a]${main}[a];` +
          `[1:a]aresample=${plan.outRate},aformat=channel_layouts=${layout}[ir];` +
          `[a][ir]afir[out]`,
          '-map', '[out]');
      } else if (needsResample) {
        args.push('-map', 'a:0', '-af', this._resampleFilter(plan.outRate), '-ac', String(plan.channels));
      } else {
        args.push('-map', 'a:0', '-ac', String(plan.channels), '-ar', String(plan.outRate));
      }
      args.push('-f', 'f64le', '-acodec', 'pcm_f64le');
    }
    args.push('-');
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.decoder = child;
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; });
    child.stdout.on('data', (chunk) => this._onPcm(child, chunk));
    child.on('close', (code) => {
      if (child !== this.decoder) return;
      this._flushResidual();
      this.decodeEnded = true;
      if (code !== 0 && errBuf && this.pcmQueue.length === 0 && this.framesWritten === 0) {
        this.emit('native:error', { message: errBuf.split('\n')[0] });
      }
      this._maybeAdvance();
    });
  }

  // The decoder's last chunk almost never lands on a frame boundary, so a
  // sub-frame tail sits in `residual` — pad it to one full frame of silence
  // and queue it, or end-of-track advance stalls behind it forever.
  _flushResidual() {
    const s = this.stream;
    if (!s || this.residual.length === 0) return;
    const bytesPerFrame = s.channels * (s.mode === 'bitperfect' ? 4 : 8);
    const frameBytes = s.frameSize * bytesPerFrame;
    const padded = Buffer.alloc(frameBytes);
    this.residual.copy(padded, 0, 0, Math.min(this.residual.length, frameBytes));
    this.residual = Buffer.alloc(0);
    this.pcmQueue.push(this._prepareFrame(padded));
    this._fill();
  }

  // ── native DSD: stream DSF blocks, pack as DoP ──

  _startDopReader(track, startAt, plan) {
    const engine = this;
    const state = { cancelled: false, markerPhase: 0 };
    this.dop = state;
    (async () => {
      const fh = await fsPromises.open(track.path, 'r');
      try {
        const head = Buffer.alloc(92);
        await fh.read(head, 0, 92, 0);
        const info = parseDsfHeader(head);
        if (!info) throw new Error('Not a DSF file');
        const { blockSize, channels, dataStart } = info;
        const lsbFirst = info.bitsPerSample === 1;
        // seek: bytes per channel per second = dsdRate / 8
        const bytesPerChanSec = info.sampleRate / 8;
        let blockIndex = Math.floor((startAt * bytesPerChanSec) / blockSize);
        let offset = dataStart + blockIndex * blockSize * channels;
        const blockPair = Buffer.alloc(blockSize * channels);
        while (!state.cancelled) {
          const { bytesRead } = await fh.read(blockPair, 0, blockPair.length, offset);
          if (bytesRead < blockPair.length) break; // EOF
          offset += bytesRead;
          const perCh = [];
          for (let ch = 0; ch < channels; ch++) {
            const src = blockPair.subarray(ch * blockSize, (ch + 1) * blockSize);
            const bytes = Buffer.from(src);
            if (lsbFirst) {
              for (let i = 0; i < bytes.length; i++) bytes[i] = BIT_REVERSE[bytes[i]];
            }
            perCh.push(bytes);
          }
          const packed = packDop(perCh, state.markerPhase);
          state.markerPhase = packed.markerPhase;
          // split into stream frames
          const s = engine.stream;
          const frameBytes = s.frameSize * s.channels * 4;
          for (let off = 0; off + frameBytes <= packed.buffer.length; off += frameBytes) {
            engine.pcmQueue.push(Buffer.from(packed.buffer.subarray(off, off + frameBytes)));
          }
          engine._fill();
          // backpressure: keep ~2s decoded
          while (!state.cancelled &&
                 engine.pcmQueue.length * s.frameSize / s.outRate > 2) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      } catch (err) {
        if (!state.cancelled) engine.emit('native:error', { message: 'DSD: ' + err.message });
      } finally {
        await fh.close().catch(() => {});
        if (!state.cancelled) { engine._flushResidual(); engine.decodeEnded = true; engine._maybeAdvance(); }
      }
    })();
  }

  _onPcm(child, chunk) {
    if (child !== this.decoder) return;
    const s = this.stream;
    const bytesPerFrame = s.channels * (s.mode === 'bitperfect' ? 4 : 8); // s32 in / f64 in
    let data = Buffer.concat([this.residual, chunk]);
    const frameBytes = s.frameSize * bytesPerFrame;
    let off = 0;
    while (data.length - off >= frameBytes) {
      const block = data.subarray(off, off + frameBytes);
      off += frameBytes;
      this.pcmQueue.push(this._prepareFrame(block));
    }
    this.residual = Buffer.from(data.subarray(off));
    // Backpressure: pause decoder when we're far ahead (~2s)
    const ahead = this.pcmQueue.length * s.frameSize / s.outRate;
    if (ahead > 2 && this.decoder && !this.decoder.killed) this.decoder.stdout.pause();
    this._fill();
  }

  _prepareFrame(block) {
    const s = this.stream;
    if (s.mode === 'bitperfect') return Buffer.from(block); // untouched s32le

    // f64 in → DSP → quantize to the configured output format
    const f64 = new Float64Array(block.buffer.slice(block.byteOffset, block.byteOffset + block.length));
    this._processBlock(f64);
    this._collectViz(f64, s.channels);
    if (this.quantizer) return this.quantizer.process(f64);
    const f32 = new Float32Array(f64.length);
    for (let i = 0; i < f64.length; i++) {
      const v = f64[i];
      f32[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return Buffer.from(f32.buffer);
  }

  _collectViz(f64, channels) {
    const now = Date.now();
    if (now - this.lastViz < 66) return;
    this.lastViz = now;
    // RMS per channel
    const levels = [0, 0];
    const frames = f64.length / channels;
    for (let ch = 0; ch < Math.min(2, channels); ch++) {
      let sum = 0;
      for (let i = 0; i < frames; i++) { const v = f64[i * channels + ch]; sum += v * v; }
      levels[ch] = Math.sqrt(sum / frames);
    }
    // mono 2048-pt spectrum
    const n = 2048;
    const mono = new Float64Array(n);
    const step = Math.max(1, Math.floor(frames / n));
    for (let i = 0; i < n; i++) {
      const idx = Math.min(frames - 1, i * step) * channels;
      // Hann window
      mono[i] = (f64[idx] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    }
    const mags = fftMagnitudes(mono);
    const bins = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      const m = mags[Math.floor(i * mags.length / 512)];
      const db = 20 * Math.log10(m + 1e-9);
      bins[i] = Math.max(0, Math.min(255, Math.round((db + 90) / 90 * 255)));
    }
    this.emit('native:viz', { levels, spectrum: Array.from(bins) });
  }

  _primeQueue() {
    for (let i = 0; i < FRAME_QUEUE_TARGET; i++) this._fill(true);
  }

  _pump() { this._fill(); }

  _fill(initial = false) {
    if (!this.playing || !this.stream) return;
    if (this.stream.backend === 'wasapi-ex') {
      // interval-driven: keep ~250ms in the addon ring — a JS timer can jitter
      // tens of ms under load, and exclusive-mode underruns are audible pops
      const target = Math.max(this.stream.frameSize * 4, Math.round(this.stream.outRate * 0.25));
      while (this.pcmQueue.length > 0 && this._outQueuedFrames() < target) {
        this._outWrite(this.pcmQueue.shift());
        this.framesWritten++;
      }
      // start the device clock only once half the target is buffered (or the
      // decode already finished and this is all the audio there is)
      if (!this.wexStarted &&
          (this._outQueuedFrames() >= target / 2 || (this.decodeEnded && this.pcmQueue.length === 0))) {
        this.wexStarted = true;
        try { wasapiEx.start(this.wexHandle); } catch { /* already running */ }
      }
    } else {
      if (!this.rt) return;
      while (this.pcmQueue.length > 0) {
        // keep the device queue shallow: write one frame per pump (or prime)
        this._outWrite(this.pcmQueue.shift());
        this.framesWritten++;
        if (!initial) break;
        if (this.framesWritten >= FRAME_QUEUE_TARGET) break;
      }
    }
    if (this.decoder?.stdout?.isPaused() && this.pcmQueue.length * this.stream.frameSize / this.stream.outRate < 1) {
      this.decoder.stdout.resume();
    }
    this._maybeAdvance();
  }

  _maybeAdvance() {
    if (!this.decodeEnded || this.pcmQueue.length > 0 || this.residual.length > 0) return;
    if (!this.playing) return;
    const next = this.nextTrack;
    this.decodeEnded = false;
    if (next) {
      // Gapless continuation: same stream when format matches, else reopen
      const track = next;
      this.nextTrack = null;
      const pos = 0;
      this.emit('native:track-ended', { advancedTo: track.id });
      this.play(track, pos).then(() => {
        this.emit('native:track-changed', { trackId: track.id });
      }).catch((err) => this.emit('native:error', { message: err.message }));
    } else {
      this.playing = false;
      this._stopProgress();
      this.emit('native:track-ended', { advancedTo: null });
      this.emit('native:state', { playing: false });
    }
  }

  getPosition() {
    if (!this.stream) return 0;
    const written = this.framesWritten * this.stream.frameSize / this.stream.outRate;
    const latency = this._outLatencyFrames() / this.stream.outRate;
    // DoP: 16 DSD bits per PCM frame — position maps 1:1 to wall-clock anyway
    return Math.max(0, this.startOffset + written - latency);
  }

  // ── signal path descriptor (for the UI indicator) ──

  getSignalPath() {
    const t = this.currentTrack;
    const s = this.stream;
    const c = this.config;
    if (!t || !s) return null;
    const stages = [];
    const srcBits = t.dsd ? 1 : (t.bitsPerSample || 16);
    stages.push({
      kind: 'source', quality: t.lossless || t.dsd ? 'lossless' : 'lossy',
      label: t.dsd ? `DSD ${(t.sampleRate / 44100 / 64).toFixed(0) * 64 || 64}` : (t.codec || 'PCM'),
      detail: t.dsd
        ? `1-bit / ${(t.sampleRate / 1e6).toFixed(4)} MHz`
        : `${srcBits}-bit / ${((t.sampleRate || 44100) / 1000)} kHz${t.lossless ? '' : ` · ${t.bitrate || '?'} kbps lossy`}`,
    });
    if (s.mode === 'dop') {
      stages.push({ kind: 'decode', quality: 'bitperfect', label: 'DoP encapsulation',
        detail: `DSD bitstream untouched · marker-framed at ${(s.outRate / 1000)} kHz` });
    } else if (s.mode === 'bitperfect') {
      stages.push({ kind: 'decode', quality: 'bitperfect', label: 'FFmpeg decode',
        detail: 'bit-exact unpack to 32-bit integer' });
    } else {
      stages.push({ kind: 'decode', quality: 'lossless', label: 'FFmpeg decode',
        detail: '64-bit float' });
      if (t.dsd) stages.push({ kind: 'dsp', quality: 'lossless', label: 'DSD → PCM', detail: '176.4 kHz' });
      const decodeRate = t.dsd ? 176400 : (t.sampleRate || 44100);
      if (s.outRate !== decodeRate) {
        stages.push({ kind: 'dsp', quality: 'enhanced',
          label: this._soxr ? 'SoX resampler' : 'SWR resampler',
          detail: `${decodeRate / 1000} kHz → ${s.outRate / 1000} kHz · ` +
                  (this._soxr ? `${c.resample?.precision || 28}-bit precision` : 'filter 256') });
      }
      if (c.replayGain !== 'off') {
        stages.push({ kind: 'dsp', quality: 'enhanced', label: 'ReplayGain', detail: c.replayGain + ' gain' });
      }
      const eqActive = c.eqEnabled && c.eqGains.some((g) => g !== 0);
      if (eqActive) {
        stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Parametric EQ',
          detail: `${c.eqGains.filter((g) => g !== 0).length} bands · 64-bit float` });
      }
      if (c.correction?.enabled) {
        const parts = ['level/delay/PEQ'];
        if (c.correction.irPath) parts.push('FIR convolution');
        stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Speaker correction',
          detail: parts.join(' + ') + ' · 64-bit float' });
      }
      const fmt = s.wireFormat || s.format;
      if (fmt === 'f32') {
        stages.push({ kind: 'dsp', quality: 'lossless', label: 'Quantize', detail: '32-bit float' });
      } else {
        const bits = { s16: 16, s24: 24, s32: 32 }[fmt];
        const dl = c.dither === 'ns' ? 'TPDF dither + 2nd-order noise shaping'
                 : c.dither === 'tpdf' ? 'TPDF dither' : 'no dither';
        stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Quantize', detail: `${bits}-bit integer · ${dl}` });
      }
      stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Volume',
        detail: s.backend === 'wasapi-ex' ? 'bypassed (exclusive)' : `${Math.round(c.volume * 100)}%` });
    }
    const backendLabel = s.backend === 'wasapi-ex'
      ? 'WASAPI Exclusive'
      : (API_LABELS[Object.keys(audify.RtAudioApi).find((k) => audify.RtAudioApi[k] === Number(c.api))] ||
         (this.rt ? this.rt.getApi() : 'System'));
    stages.push({
      kind: 'output',
      quality: s.mode !== 'dsp' || s.backend === 'wasapi-ex' ? 'bitperfect' : 'lossless',
      label: backendLabel,
      detail: `${s.wireFormat || s.format} @ ${(s.outRate / 1000)} kHz` +
              (s.mode === 'dop' ? ' · DoP' : s.mode === 'bitperfect' ? ' · bit-perfect' : ''),
    });
    const worst = stages.some((x) => x.quality === 'lossy') ? 'lossy'
      : stages.every((x) => x.quality === 'bitperfect' || x.kind === 'source') && s.mode !== 'dsp' ? 'bitperfect'
      : 'lossless';
    return { stages, overall: worst, engine: 'native' };
  }

  _emitSignalPath() {
    this.emit('native:signal-path', this.getSignalPath());
  }

  _startProgress() {
    this._stopProgress();
    this.progressTimer = setInterval(() => {
      if (!this.playing) return;
      this.emit('native:progress', {
        time: this.getPosition(),
        duration: this.currentTrack?.duration || 0,
      });
    }, 250);
  }

  _stopProgress() {
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  pause() {
    if (!this.stream || !this.playing) return false;
    this.playing = false;
    this._outStop();
    this.emit('native:state', { playing: false });
    return true;
  }

  resume() {
    if (!this.stream || !this.currentTrack) return false;
    this.playing = true;
    this._outStart();
    this._primeQueue();
    this.emit('native:state', { playing: true });
    return true;
  }

  seek(time) {
    if (!this.currentTrack) return;
    const track = this.currentTrack;
    this.play(track, Math.max(0, time)).catch(() => {});
  }

  stopDecoder() {
    if (this.decoder) {
      const d = this.decoder;
      this.decoder = null;
      try { d.kill('SIGKILL'); } catch { /* gone */ }
    }
    if (this.dop) { this.dop.cancelled = true; this.dop = null; }
    if (this.rt) { try { if (this.rt.isStreamOpen()) this.rt.clearOutputQueue(); } catch { /* fine */ } }
    if (this.stream?.backend === 'wasapi-ex' && this.wexHandle != null) {
      try { wasapiEx.clear(this.wexHandle); } catch { /* fine */ }
    }
  }

  stopAll() {
    this.stopDecoder();
    this.playing = false;
    this.currentTrack = null;
    this._stopProgress();
    this._outClose();
  }
}

module.exports = { NativeAudioEngine };
