// ═══════════════════════════════════════════════════════════════════════
// Renderer proxy for the native output engine (main-process RtAudio path).
// Duck-types the AudioEngine surface used by app.js and the visualizers.
// ═══════════════════════════════════════════════════════════════════════

export class NativeEngineProxy {
  constructor() {
    this.currentTrack = null;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.8;
    this.gapless = true;
    this.eqEnabled = false;
    this.eqGains = new Array(10).fill(0);
    this.replayGainMode = 'off';
    this.bitPerfect = false;

    // visualizer-compatible stubs
    this.analyser = { frequencyBinCount: 512, fftSize: 1024 };
    this._spectrum = new Uint8Array(512);
    this._levels = [0, 0];

    this.onTimeUpdate = null;
    this.onTrackEnd = null;
    this.onTrackStarted = null;
    this.onError = null;
    this.peekNext = null;

    this._offs = [
      window.auralis.native.on('native:progress', (p) => {
        this.currentTime = p.time;
        this.duration = p.duration;
        this.onTimeUpdate?.(p.time, p.duration);
        this._syncNext();
      }),
      window.auralis.native.on('native:track-ended', (p) => {
        if (!p.advancedTo) {
          const next = this.onTrackEnd?.();
          // onTrackEnd advances app queue state; if it returns a track the
          // main side didn't have preloaded, start it explicitly.
          if (next) this.play(next);
          else this.paused = true;
        } else {
          // main advanced gapless-style; keep app queue in sync
          this.onTrackEnd?.();
        }
      }),
      window.auralis.native.on('native:track-changed', () => {
        const track = this._pendingNext;
        if (track) {
          this.currentTrack = track;
          this._pendingNext = null;
          this.onTrackStarted?.(track);
        }
      }),
      window.auralis.native.on('native:state', (s) => { this.paused = !s.playing; }),
      window.auralis.native.on('native:error', (e) =>
        this.onError?.(this.currentTrack, e.message)),
      window.auralis.native.on('native:viz', (v) => {
        this._levels = v.levels;
        this._spectrum.set(v.spectrum.slice(0, 512));
      }),
      window.auralis.native.on('native:signal-path', (p) => {
        this._signalPath = p;
        this.onSignalPath?.(p);
      }),
    ];
    this._signalPath = null;
    this.onSignalPath = null;
    this._pendingNext = null;
    this._lastSyncedNextId = null;
  }

  destroy() {
    this._offs.forEach((off) => off());
    window.auralis.native.stop();
  }

  get buffered() { return 0; }

  async play(track) {
    this.currentTrack = track;
    this.duration = track.duration || 0;
    this.currentTime = 0;
    this._lastSyncedNextId = null;
    const res = await window.auralis.native.play(this._slim(track), 0);
    if (!res.ok) {
      this.onError?.(track, res.error || 'Native playback failed');
      return false;
    }
    this.paused = false;
    return true;
  }

  _slim(t) {
    return {
      id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album,
      duration: t.duration, sampleRate: t.sampleRate, channels: t.channels,
      dsd: t.dsd, replayGainTrack: t.replayGainTrack, replayGainAlbum: t.replayGainAlbum,
    };
  }

  _syncNext() {
    const next = this.peekNext?.();
    const id = next?.id || null;
    if (id === this._lastSyncedNextId) return;
    this._lastSyncedNextId = id;
    this._pendingNext = next || null;
    window.auralis.native.setNext(next ? this._slim(next) : null);
  }

  async toggle() {
    if (!this.currentTrack) return false;
    if (this.paused) { await window.auralis.native.resume(); this.paused = false; }
    else { await window.auralis.native.pause(); this.paused = true; }
    return !this.paused;
  }

  pause() { window.auralis.native.pause(); this.paused = true; }
  seek(time) { if (isFinite(time)) { this.currentTime = time; window.auralis.native.seek(time); } }

  setVolume(v) { this.volume = v; window.auralis.native.config({ volume: v }); }
  setEqGain(band, db) { this.eqGains[band] = db; this._pushDsp(); }
  setEqEnabled(on) { this.eqEnabled = on; this._pushDsp(); }
  applyEqGains(gains) { this.eqGains = [...gains]; this._pushDsp(); }
  setReplayGainMode(mode) { this.replayGainMode = mode; window.auralis.native.config({ replayGain: mode }); }
  setSpeakerCorrection(cfg) { window.auralis.native.config({ correction: cfg }); }
  _pushDsp() {
    window.auralis.native.config({ eqEnabled: this.eqEnabled, eqGains: [...this.eqGains] });
  }

  async setOutputDevice() { /* device chosen via native output settings */ }
  async listOutputDevices() { return []; }

  getSpectrum(buffer) {
    buffer.set(this._spectrum.subarray(0, buffer.length));
    return buffer;
  }

  getVuLevels() { return this._levels; }

  getSignalPath() { return this._signalPath; }
}
