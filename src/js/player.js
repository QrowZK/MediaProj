// ═══════════════════════════════════════════════════════════════════════
// Auralis audio engine
// Dual-element gapless playback → per-source gain (ReplayGain) →
// 10-band parametric EQ → preamp → analysers (spectrum + stereo VU) →
// master gain → selected output device.
// ═══════════════════════════════════════════════════════════════════════

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS = {
  Flat:        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Warm Tube': [2.5, 2, 1, 0.5, 0, -0.5, -1, -0.5, 0.5, 1],
  'Bass Lift': [4.5, 3.5, 2.5, 1, 0, 0, 0, 0, 0, 0],
  'Treble Air':[0, 0, 0, 0, 0, 0.5, 1, 2, 3, 4],
  'V-Shape':   [3.5, 2.5, 1, -0.5, -1.5, -1.5, -0.5, 1, 2.5, 3.5],
  Vocal:       [-1, -0.5, 0, 1.5, 2.5, 2.5, 1.5, 0.5, 0, -0.5],
  'Loudness':  [4, 3, 1.5, 0, -0.5, -0.5, 0, 1, 2.5, 3.5],
};

const PRELOAD_AHEAD_SECONDS = 20;

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });

    // Two media elements for gapless handoff
    this.elements = [new Audio(), new Audio()];
    this.sources = this.elements.map((el) => {
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      return this.ctx.createMediaElementSource(el);
    });
    this.sourceGains = this.elements.map(() => this.ctx.createGain());
    this.active = 0; // index of live element

    // EQ chain
    this.eqNodes = EQ_FREQUENCIES.map((freq, i) => {
      const node = this.ctx.createBiquadFilter();
      if (i === 0) node.type = 'lowshelf';
      else if (i === EQ_FREQUENCIES.length - 1) node.type = 'highshelf';
      else { node.type = 'peaking'; node.Q.value = 1.1; }
      node.frequency.value = freq;
      node.gain.value = 0;
      return node;
    });

    this.preamp = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.82;
    // Web Audio's default display window is -100..-30 dB — music's bass/mid
    // bins sit above -30 dBFS nearly all the time, so they peg at 255 and the
    // spectrum reads as a maxed-out, left-heavy plateau. Match the native
    // engine's -90..0 window so both engines draw alike.
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = 0;

    // stereo VU
    this.splitter = this.ctx.createChannelSplitter(2);
    this.vuAnalysers = [this.ctx.createAnalyser(), this.ctx.createAnalyser()];
    this.vuAnalysers.forEach((a) => { a.fftSize = 1024; a.smoothingTimeConstant = 0.5; });

    this.masterGain = this.ctx.createGain();

    // wire graph
    const eqInput = this.eqNodes[0];
    for (let i = 0; i < this.eqNodes.length - 1; i++) {
      this.eqNodes[i].connect(this.eqNodes[i + 1]);
    }
    this.sources.forEach((src, i) => {
      src.connect(this.sourceGains[i]);
      this.sourceGains[i].connect(eqInput);
    });
    // Speaker correction slot (JRiver-style): rebuilt on config change.
    // Chain: eqOutput → [correction subgraph] → preamp
    this.correctionInput = this.ctx.createGain();
    this.correctionOutput = this.ctx.createGain();
    this.correctionNodes = [];
    this.correction = null; // active config

    const eqOutput = this.eqNodes[this.eqNodes.length - 1];
    eqOutput.connect(this.correctionInput);
    this.correctionInput.connect(this.correctionOutput); // passthrough until configured
    this.correctionOutput.connect(this.preamp);
    this.preamp.connect(this.analyser);
    this.analyser.connect(this.masterGain);
    this.analyser.connect(this.splitter);
    this.splitter.connect(this.vuAnalysers[0], 0);
    this.splitter.connect(this.vuAnalysers[1], 1);
    this.masterGain.connect(this.ctx.destination);

    // state
    this.eqEnabled = true;
    this.eqGains = [...EQ_PRESETS.Flat];
    this.replayGainMode = 'off'; // off | track | album
    this.gapless = true;
    this.volume = 0.8;
    this.currentTrack = null;
    this.preloadedTrack = null;
    this.onTrackEnd = null;      // set by app: () => nextTrack or null
    this.onTimeUpdate = null;
    this.onError = null;

    this.setVolume(this.volume);
    this._bindElementEvents();
  }

  get el() { return this.elements[this.active]; }
  get idleEl() { return this.elements[1 - this.active]; }

  _bindElementEvents() {
    this.elements.forEach((el, idx) => {
      el.addEventListener('ended', () => {
        if (idx !== this.active) return;
        this._handleEnded();
      });
      el.addEventListener('timeupdate', () => {
        if (idx !== this.active) return;
        this.onTimeUpdate?.(el.currentTime, el.duration || 0);
        this._maybePreloadNext();
      });
      el.addEventListener('error', () => {
        if (idx !== this.active || !el.src) return;
        this.onError?.(this.currentTrack,
          'This format cannot be decoded by the playback engine.');
      });
    });
  }

  _applyReplayGain(gainNode, track) {
    let db = 0;
    if (track && this.replayGainMode === 'track' && track.replayGainTrack != null) {
      db = track.replayGainTrack;
    } else if (track && this.replayGainMode === 'album') {
      db = track.replayGainAlbum ?? track.replayGainTrack ?? 0;
    }
    gainNode.gain.value = Math.pow(10, db / 20);
  }

  async play(track) {
    await this.ctx.resume();
    this.preloadedTrack = null;
    this.currentTrack = track;
    const el = this.el;
    this.idleEl.removeAttribute('src');
    this._applyReplayGain(this.sourceGains[this.active], track);
    el.src = track.url;
    try {
      await el.play();
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.onError?.(track, 'Playback failed: ' + err.message);
      }
      return false;
    }
  }

  _maybePreloadNext() {
    if (!this.gapless || this.preloadedTrack) return;
    const el = this.el;
    if (!el.duration || el.duration - el.currentTime > PRELOAD_AHEAD_SECONDS) return;
    const next = this.peekNext?.();
    if (!next) return;
    this.preloadedTrack = next;
    const idle = this.idleEl;
    this._applyReplayGain(this.sourceGains[1 - this.active], next);
    idle.src = next.url;
    idle.load();
  }

  async _handleEnded() {
    const next = this.onTrackEnd?.();
    if (!next) { this.currentTrack = null; return; }
    if (this.gapless && this.preloadedTrack && this.preloadedTrack.id === next.id &&
        this.idleEl.readyState >= 2) {
      // Instant handoff to the preloaded element
      this.active = 1 - this.active;
      this.currentTrack = next;
      this.preloadedTrack = null;
      try {
        await this.el.play();
        this.onTrackStarted?.(next);
      } catch {
        this.onError?.(next, 'Gapless handoff failed.');
      }
    } else {
      const ok = await this.play(next);
      if (ok) this.onTrackStarted?.(next);
    }
  }

  async toggle() {
    await this.ctx.resume();
    if (this.el.paused) {
      try { await this.el.play(); } catch { /* no src */ }
    } else {
      this.el.pause();
    }
    return !this.el.paused;
  }

  pause() { this.el.pause(); }
  get paused() { return this.el.paused; }
  get currentTime() { return this.el.currentTime; }
  get duration() { return this.el.duration || 0; }
  seek(time) { if (isFinite(time)) this.el.currentTime = time; }

  get buffered() {
    const el = this.el;
    try {
      if (el.buffered.length && el.duration) {
        return el.buffered.end(el.buffered.length - 1) / el.duration;
      }
    } catch { /* ignore */ }
    return 0;
  }

  setVolume(v) {
    this.volume = v;
    // Perceptual (power) curve
    this.masterGain.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.015);
  }

  setEqGain(band, db) {
    this.eqGains[band] = db;
    if (this.eqEnabled) {
      this.eqNodes[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
    }
  }

  setEqEnabled(on) {
    this.eqEnabled = on;
    this.eqNodes.forEach((node, i) => {
      node.gain.setTargetAtTime(on ? this.eqGains[i] : 0, this.ctx.currentTime, 0.02);
    });
    // Modest headroom when EQ is hot so boosts don't clip
    const maxBoost = Math.max(0, ...this.eqGains);
    this.preamp.gain.setTargetAtTime(
      on && maxBoost > 0 ? Math.pow(10, -maxBoost / 40) : 1,
      this.ctx.currentTime, 0.02);
  }

  applyEqGains(gains) {
    gains.forEach((db, i) => this.setEqGain(i, db));
    this.setEqEnabled(this.eqEnabled);
  }

  setReplayGainMode(mode) {
    this.replayGainMode = mode;
    if (this.currentTrack) this._applyReplayGain(this.sourceGains[this.active], this.currentTrack);
  }

  // ── Speaker correction (JRiver-style room correction) ──
  // config: { enabled, channels: [{gain, delayMs, invert, peq:[{freq,gain,q}]}, ...],
  //           irUrl: optional impulse-response WAV (auralis:// url) }
  async setSpeakerCorrection(config) {
    this.correction = config;
    // tear down previous subgraph
    this.correctionInput.disconnect();
    this.correctionNodes.forEach((n) => { try { n.disconnect(); } catch { /* already */ } });
    this.correctionNodes = [];

    if (!config || !config.enabled) {
      this.correctionInput.connect(this.correctionOutput);
      return;
    }

    const ctx = this.ctx;
    const chConfigs = [config.channels?.[0] || {}, config.channels?.[1] || {}];
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    this.correctionNodes.push(splitter, merger);
    this.correctionInput.connect(splitter);

    chConfigs.forEach((ch, i) => {
      let head = null, tail = null;
      const push = (node) => {
        this.correctionNodes.push(node);
        if (tail) tail.connect(node); else head = node;
        tail = node;
      };
      const delay = ctx.createDelay(1);
      delay.delayTime.value = Math.max(0, (ch.delayMs || 0) / 1000);
      push(delay);
      const gain = ctx.createGain();
      const linear = Math.pow(10, (ch.gain || 0) / 20);
      gain.gain.value = ch.invert ? -linear : linear;
      push(gain);
      for (const band of (ch.peq || [])) {
        if (!band.freq) continue;
        const bq = ctx.createBiquadFilter();
        bq.type = 'peaking';
        bq.frequency.value = band.freq;
        bq.gain.value = band.gain || 0;
        bq.Q.value = band.q || 1;
        push(bq);
      }
      splitter.connect(head, i);
      tail.connect(merger, 0, i);
    });

    let output = merger;
    if (config.irUrl) {
      try {
        const res = await fetch(config.irUrl);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        const conv = ctx.createConvolver();
        conv.normalize = true;
        conv.buffer = buf;
        this.correctionNodes.push(conv);
        merger.connect(conv);
        output = conv;
      } catch { /* bad IR file — skip convolution */ }
    }
    output.connect(this.correctionOutput);
  }

  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId === 'function') {
      await this.ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
    }
  }

  async listOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'audiooutput');
    } catch {
      return [];
    }
  }

  getSpectrum(buffer) {
    this.analyser.getByteFrequencyData(buffer);
    return buffer;
  }

  // Signal path descriptor for the UI indicator (standard engine)
  getSignalPath() {
    const t = this.currentTrack;
    if (!t) return null;
    const stages = [];
    stages.push({
      kind: 'source', quality: t.lossless || t.dsd ? 'lossless' : 'lossy',
      label: t.codec || 'PCM',
      detail: `${t.bitsPerSample || 16}-bit / ${((t.sampleRate || 44100) / 1000)} kHz` +
              (t.lossless ? '' : ` · ${t.bitrate || '?'} kbps lossy`),
    });
    stages.push({ kind: 'decode', quality: 'lossless', label: 'Chromium decode', detail: '32-bit float' });
    if (this.replayGainMode !== 'off') {
      stages.push({ kind: 'dsp', quality: 'enhanced', label: 'ReplayGain', detail: this.replayGainMode + ' gain' });
    }
    if (this.eqEnabled && this.eqGains.some((g) => g !== 0)) {
      stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Parametric EQ',
        detail: `${this.eqGains.filter((g) => g !== 0).length} bands · 32-bit float` });
    }
    if (this.correction?.enabled) {
      const parts = ['level/delay/PEQ'];
      if (this.correction.irUrl) parts.push('convolution');
      stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Speaker correction', detail: parts.join(' + ') });
    }
    stages.push({ kind: 'dsp', quality: 'enhanced', label: 'Volume', detail: `${Math.round(this.volume * 100)}%` });
    stages.push({
      kind: 'output', quality: 'lossless', label: 'System output (shared)',
      detail: `32-bit float @ ${(this.ctx.sampleRate / 1000)} kHz · OS mixer`,
    });
    const overall = stages.some((s) => s.quality === 'lossy') ? 'lossy' : 'lossless';
    return { stages, overall, engine: 'standard' };
  }

  getVuLevels() {
    const levels = [0, 0];
    const buf = new Float32Array(this.vuAnalysers[0].fftSize);
    for (let ch = 0; ch < 2; ch++) {
      this.vuAnalysers[ch].getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      levels[ch] = Math.sqrt(sum / buf.length); // RMS
    }
    return levels;
  }
}
