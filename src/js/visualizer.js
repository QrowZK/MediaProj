// ═══════════════════════════════════════════════════════════════════════
// Visualizers: fullscreen spectrum (Now Playing) + stereo VU (player bar)
// ═══════════════════════════════════════════════════════════════════════

export class SpectrumVisualizer {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.engine = engine;
    this.buffer = new Uint8Array(engine.analyser.frequencyBinCount);
    this.running = false;
    this.bars = 96;
    this.peaks = new Float32Array(this.bars);
    this.peakHold = new Float32Array(this.bars);
    this._resize = this._resize.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._resize();
    window.addEventListener('resize', this._resize);
    this._frame();
  }

  stop() {
    this.running = false;
    window.removeEventListener('resize', this._resize);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
  }

  _frame() {
    if (!this.running) return;
    requestAnimationFrame(() => this._frame());

    const { width: w, height: h } = this.canvas;
    const c = this.ctx2d;
    c.clearRect(0, 0, w, h);
    this.engine.getSpectrum(this.buffer);

    const bins = this.buffer.length;
    const barW = w / this.bars;
    const usableH = h * 0.9;

    // Map bars to REAL frequencies: 30 Hz … 16 kHz log-spaced against the
    // engine's actual Nyquist (differs per engine and per machine). The old
    // mapping spread raw bin INDICES to the full Nyquist — parking the top
    // third of the display in the 10–24 kHz band where music has nothing.
    const ny = this.engine.getSpectrumNyquist?.() || 22050;
    const fMin = 30;
    const fMax = Math.min(16000, ny * 0.95);
    const logSpan = Math.log(fMax / fMin);
    // Spectrum bytes are LINEAR IN dB (both engines map -90..0 dB → 0..255,
    // ~2.83 counts/dB), so pink-noise slope compensation must be ADDITIVE in
    // counts — multiplying a dB-scaled value skews loud bins harder than
    // quiet ones, which is why the old multiplicative tilt barely helped.
    const COUNTS_PER_DB = 255 / 90;
    const TILT_DB_PER_OCTAVE = 3.5;
    const SILENCE_GATE = 6; // ≈ -88 dB: don't tilt the noise floor into fake bars

    const grad = c.createLinearGradient(0, h, 0, h - usableH);
    grad.addColorStop(0, 'rgba(207, 139, 62, 0.75)');
    grad.addColorStop(0.55, 'rgba(232, 180, 90, 0.55)');
    grad.addColorStop(1, 'rgba(240, 214, 160, 0.35)');

    for (let i = 0; i < this.bars; i++) {
      const fLo = fMin * Math.exp(logSpan * (i / this.bars));
      const fHi = fMin * Math.exp(logSpan * ((i + 1) / this.bars));
      // skip bin 0 (DC): sub-bin-width bass bars would otherwise read silence
      const lo = Math.max(1, Math.min(bins - 1, Math.floor(fLo / ny * bins)));
      const hi = Math.max(lo + 1, Math.min(bins, Math.ceil(fHi / ny * bins)));
      let sum = 0;
      for (let b = lo; b < hi; b++) sum += this.buffer[b];
      let avg = sum / (hi - lo);
      if (avg > SILENCE_GATE) {
        const octavesUp = Math.log2(Math.sqrt(fLo * fHi) / fMin);
        // ramp the tilt in over ~8dB above the gate — a hard step makes
        // near-threshold treble (fades, reverb tails) pop a third of the way
        // up the display and strand peak-hold caps there
        const ramp = Math.min(1, (avg - SILENCE_GATE) / 24);
        avg = Math.min(255, avg + TILT_DB_PER_OCTAVE * octavesUp * COUNTS_PER_DB * ramp);
      }
      const v = avg / 255;

      // smooth decay
      this.peaks[i] = Math.max(v, this.peaks[i] * 0.88);
      const barH = Math.pow(this.peaks[i], 1.4) * usableH;

      // peak-hold caps
      if (barH > this.peakHold[i]) this.peakHold[i] = barH;
      else this.peakHold[i] = Math.max(0, this.peakHold[i] - usableH * 0.004);

      const x = i * barW + barW * 0.18;
      const bw = barW * 0.64;
      c.fillStyle = grad;
      const r = Math.min(bw / 2, 4 * (window.devicePixelRatio || 1));
      c.beginPath();
      c.roundRect(x, h - barH, bw, barH, [r, r, 0, 0]);
      c.fill();

      if (this.peakHold[i] > 2) {
        c.fillStyle = 'rgba(240, 214, 160, 0.5)';
        c.fillRect(x, h - this.peakHold[i] - 3, bw, 2);
      }
    }
  }
}

export class VuMeter {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.engine = engine;
    this.running = false;
    this.smooth = [0, 0];
    this.peak = [0, 0];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._frame();
  }

  stop() { this.running = false; }

  _frame() {
    if (!this.running) return;
    requestAnimationFrame(() => this._frame());
    const levels = this.engine.getVuLevels();
    const c = this.ctx2d;
    const { width: w, height: h } = this.canvas;
    c.clearRect(0, 0, w, h);

    const segments = 12;
    const segW = w / segments;
    for (let ch = 0; ch < 2; ch++) {
      // map RMS (0..~0.7) → 0..1 with soft knee
      const target = Math.min(1, Math.pow(levels[ch] * 1.9, 0.6));
      this.smooth[ch] = target > this.smooth[ch]
        ? target
        : Math.max(0, this.smooth[ch] - 0.045);
      if (this.smooth[ch] > this.peak[ch]) this.peak[ch] = this.smooth[ch];
      else this.peak[ch] = Math.max(0, this.peak[ch] - 0.008);

      const y = ch === 0 ? 2 : h / 2 + 2;
      const segH = h / 2 - 5;
      const lit = Math.round(this.smooth[ch] * segments);
      for (let s = 0; s < segments; s++) {
        const frac = s / segments;
        let color;
        if (frac < 0.6) color = s < lit ? '#6fd3a3' : 'rgba(111,211,163,0.13)';
        else if (frac < 0.85) color = s < lit ? '#e8b45a' : 'rgba(232,180,90,0.13)';
        else color = s < lit ? '#e06c6c' : 'rgba(224,108,108,0.13)';
        c.fillStyle = color;
        c.fillRect(s * segW + 0.5, y, segW - 1.5, segH);
      }
      // peak indicator
      const px = Math.min(segments - 1, Math.round(this.peak[ch] * segments)) * segW;
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.fillRect(px + 0.5, y, 1.5, segH);
    }
  }
}
