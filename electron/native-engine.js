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

class NativeAudioEngine {
  constructor(emit) {
    this.emit = emit; // (channel, payload) → webContents.send
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
      correction: null,
    };
    this.dspState = null;
    this.fftAccum = [];
    this.lastViz = 0;
    this.progressTimer = null;
  }

  get available() { return !!(audify && ffmpegPath); }

  listApis() {
    if (!this.available) return [];
    const apis = [];
    for (const [name, id] of Object.entries(audify.RtAudioApi)) {
      if (name === 'UNSPECIFIED' || name === 'RTAUDIO_DUMMY') continue;
      try {
        const rt = new audify.RtAudio(id);
        if (rt.getDevices().filter((d) => d.outputChannels > 0).length > 0) {
          apis.push({ id, name, label: API_LABELS[name] || name });
        }
      } catch { /* API not functional on this machine */ }
    }
    return apis;
  }

  listDevices(apiId) {
    if (!this.available) return [];
    try {
      const rt = new audify.RtAudio(apiId || undefined);
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

  setConfig(partial) {
    const wasOutput = JSON.stringify([this.config.api, this.config.deviceId, this.config.bitPerfect, this.config.bufferSize]);
    Object.assign(this.config, partial);
    if (this.rt && !this.config.bitPerfect) {
      this.rt.outputVolume = Math.pow(this.config.volume, 2);
    }
    const nowOutput = JSON.stringify([this.config.api, this.config.deviceId, this.config.bitPerfect, this.config.bufferSize]);
    if (wasOutput !== nowOutput && this.currentTrack) {
      // output target changed mid-play: restart at current position
      const pos = this.getPosition();
      const track = this.currentTrack;
      this.play(track, pos).catch(() => {});
    } else if (this.dspState) {
      this._buildDsp(this.stream?.sampleRate || 44100, this.stream?.channels || 2);
    }
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

  async play(track, startAt = 0) {
    if (!this.available) throw new Error('Native output backend not available');
    this.stopDecoder();
    this.pcmQueue = [];
    this.residual = Buffer.alloc(0);
    this.decodeEnded = false;
    this.currentTrack = track;
    this.framesWritten = 0;
    this.startOffset = startAt;

    const c = this.config;
    const isDsd = !!track.dsd;
    const sampleRate = isDsd ? 176400 : (track.sampleRate || 44100);
    const channels = Math.min(2, track.channels || 2);

    // (Re)open stream if needed
    const needOpen = !this.stream ||
      this.stream.sampleRate !== sampleRate ||
      this.stream.channels !== channels ||
      this.stream.bitPerfect !== c.bitPerfect;
    if (needOpen) this._openStream(sampleRate, channels);

    this._buildDsp(sampleRate, channels);
    this._spawnDecoder(track, startAt, sampleRate, channels);
    this.playing = true;
    if (!this.rt.isStreamRunning()) this.rt.start();
    this._primeQueue();
    this._startProgress();
    this.emit('native:state', { playing: true });
  }

  _openStream(sampleRate, channels) {
    const c = this.config;
    if (this.rt) { try { this.rt.closeStream(); } catch { /* fine */ } }
    const apiId = c.api === 'default' ? undefined : Number(c.api);
    this.rt = new audify.RtAudio(apiId);
    const deviceId = c.deviceId >= 0 ? c.deviceId : this.rt.getDefaultOutputDevice();
    const format = c.bitPerfect ? audify.RtAudioFormat.RTAUDIO_SINT32
                                : audify.RtAudioFormat.RTAUDIO_FLOAT32;
    const frameSize = this.rt.openStream(
      { deviceId, nChannels: channels, firstChannel: 0 },
      null, format, sampleRate, c.bufferSize || 512, 'Auralis',
      null,
      () => this._pump(),
      undefined,
      (type, msg) => this.emit('native:error', { message: `${type}: ${msg}` }),
    );
    this.rt.outputVolume = c.bitPerfect ? 1 : Math.pow(c.volume, 2);
    this.stream = {
      sampleRate, channels, bitPerfect: c.bitPerfect,
      frameSize: frameSize || c.bufferSize || 512,
      bytesPerSample: c.bitPerfect ? 4 : 4,
    };
  }

  _spawnDecoder(track, startAt, sampleRate, channels) {
    const c = this.config;
    const args = ['-v', 'error', '-nostdin'];
    if (startAt > 0.05) args.push('-ss', String(startAt));
    args.push('-i', track.path, '-map', 'a:0', '-ac', String(channels), '-ar', String(sampleRate));
    if (c.bitPerfect) args.push('-f', 's32le', '-acodec', 'pcm_s32le');
    else args.push('-f', 'f64le', '-acodec', 'pcm_f64le');
    args.push('-');
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.decoder = child;
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; });
    child.stdout.on('data', (chunk) => this._onPcm(child, chunk));
    child.on('close', (code) => {
      if (child !== this.decoder) return;
      this.decodeEnded = true;
      if (code !== 0 && errBuf && this.pcmQueue.length === 0 && this.framesWritten === 0) {
        this.emit('native:error', { message: errBuf.split('\n')[0] });
      }
      this._maybeAdvance();
    });
  }

  _onPcm(child, chunk) {
    if (child !== this.decoder) return;
    const s = this.stream;
    const bytesPerFrame = s.channels * (s.bitPerfect ? 4 : 8); // s32 in / f64 in
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
    const ahead = this.pcmQueue.length * s.frameSize / s.sampleRate;
    if (ahead > 2 && this.decoder && !this.decoder.killed) this.decoder.stdout.pause();
    this._fill();
  }

  _prepareFrame(block) {
    const s = this.stream;
    if (s.bitPerfect) return Buffer.from(block); // untouched s32le

    // f64 in → DSP → f32 out
    const f64 = new Float64Array(block.buffer.slice(block.byteOffset, block.byteOffset + block.length));
    this._processBlock(f64);
    this._collectViz(f64, s.channels);
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
    if (!this.playing || !this.rt) return;
    while (this.pcmQueue.length > 0) {
      // keep the device queue shallow: write one frame per pump (or prime)
      const frame = this.pcmQueue.shift();
      this.rt.write(frame);
      this.framesWritten++;
      if (!initial) break;
      if (this.framesWritten >= FRAME_QUEUE_TARGET) break;
    }
    if (this.decoder?.stdout?.isPaused() && this.pcmQueue.length * this.stream.frameSize / this.stream.sampleRate < 1) {
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
    const queued = this.pcmQueue.length * this.stream.frameSize / this.stream.sampleRate;
    const written = this.framesWritten * this.stream.frameSize / this.stream.sampleRate;
    const latency = (this.rt?.getStreamLatency?.() || 0) / this.stream.sampleRate;
    return Math.max(0, this.startOffset + written - latency);
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
    if (!this.rt || !this.playing) return false;
    this.playing = false;
    try { this.rt.stop(); } catch { /* fine */ }
    this.emit('native:state', { playing: false });
    return true;
  }

  resume() {
    if (!this.rt || !this.currentTrack) return false;
    this.playing = true;
    try { this.rt.start(); } catch { /* fine */ }
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
    if (this.rt) { try { this.rt.clearOutputQueue(); } catch { /* fine */ } }
  }

  stopAll() {
    this.stopDecoder();
    this.playing = false;
    this.currentTrack = null;
    this._stopProgress();
    if (this.rt) {
      try { this.rt.stop(); } catch { /* fine */ }
      try { this.rt.closeStream(); } catch { /* fine */ }
      this.rt = null;
    }
    this.stream = null;
  }
}

module.exports = { NativeAudioEngine };
