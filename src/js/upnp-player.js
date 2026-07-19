// ═══════════════════════════════════════════════════════════════════════
// Renderer proxy for a network zone (UPnP AV / OpenHome renderer driven by
// the main process; audio pulled from the Auralis media server over HTTP).
// Duck-types the AudioEngine surface used by app.js.
// ═══════════════════════════════════════════════════════════════════════

export class ZoneEngineProxy {
  constructor(zoneInfo) {
    this.zone = zoneInfo; // { name, openhome }
    this.currentTrack = null;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.8;
    this.gapless = true;
    this.eqEnabled = false;
    this.eqGains = new Array(10).fill(0);
    this.replayGainMode = 'off';

    this.analyser = { frequencyBinCount: 512, fftSize: 1024 };

    this.onTimeUpdate = null;
    this.onTrackEnd = null;
    this.onTrackStarted = null;
    this.onError = null;
    this.peekNext = null;

    this._pendingNext = null;
    this._lastSyncedNextId = null;

    this._offs = [
      window.auralis.upnp.on('upnp:progress', (p) => {
        this.currentTime = p.time;
        this.duration = p.duration || this.duration;
        this.onTimeUpdate?.(p.time, this.duration);
        this._syncNext();
      }),
      window.auralis.upnp.on('upnp:track-ended', (p) => {
        if (!p.advancedTo) {
          const next = this.onTrackEnd?.();
          // start it and tell the app — otherwise the UI stays on the
          // finished track when the renderer didn't gapless-advance itself
          if (next) this.play(next).then((ok) => { if (ok) this.onTrackStarted?.(next); });
          else this.paused = true;
        } else {
          this.onTrackEnd?.();
        }
      }),
      window.auralis.upnp.on('upnp:track-changed', () => {
        const track = this._pendingNext;
        if (track) {
          this.currentTrack = track;
          this._pendingNext = null;
          this.onTrackStarted?.(track);
        }
      }),
      window.auralis.upnp.on('upnp:state', (s) => { this.paused = !s.playing; }),
      window.auralis.upnp.on('upnp:error', (e) =>
        this.onError?.(this.currentTrack, e.message)),
    ];
  }

  destroy() {
    this._offs.forEach((off) => off());
    window.auralis.upnp.zoneStop();
  }

  get buffered() { return 0; }

  _slim(t) {
    return {
      id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album,
      duration: t.duration, sampleRate: t.sampleRate, bitsPerSample: t.bitsPerSample,
      channels: t.channels, trackNo: t.trackNo, genre: t.genre,
      artUrl: t.artUrl, fileSize: t.fileSize, lossless: t.lossless, dsd: t.dsd,
      codec: t.codec, bitrate: t.bitrate,
    };
  }

  async play(track) {
    this.currentTrack = track;
    this.duration = track.duration || 0;
    this.currentTime = 0;
    this._lastSyncedNextId = null;
    const res = await window.auralis.upnp.zonePlay(this._slim(track), 0);
    if (!res.ok) {
      this.onError?.(track, res.error || 'Renderer refused playback');
      return false;
    }
    this.paused = false;
    return true;
  }

  _syncNext() {
    const next = this.peekNext?.();
    const id = next?.id || null;
    if (id === this._lastSyncedNextId) return;
    this._lastSyncedNextId = id;
    this._pendingNext = next || null;
    window.auralis.upnp.zoneSetNext(next ? this._slim(next) : null);
  }

  async toggle() {
    if (!this.currentTrack) return false;
    if (this.paused) { await window.auralis.upnp.zoneResume(); this.paused = false; }
    else { await window.auralis.upnp.zonePause(); this.paused = true; }
    return !this.paused;
  }

  pause() { window.auralis.upnp.zonePause(); this.paused = true; }
  seek(time) { if (isFinite(time)) { this.currentTime = time; window.auralis.upnp.zoneSeek(time); } }

  setVolume(v) { this.volume = v; window.auralis.upnp.zoneVolume(Math.round(v * 100)); }

  // DSP happens on the renderer's side of the network — these are no-ops
  setEqGain() {}
  setEqEnabled() {}
  applyEqGains() {}
  setReplayGainMode() {}
  setSpeakerCorrection() {}
  async setOutputDevice() {}
  async listOutputDevices() { return []; }

  getSpectrumNyquist() { return 22050; }
  getSpectrum(buffer) { buffer.fill(0); return buffer; }
  getVuLevels() { return [0, 0]; }

  getSignalPath() {
    const t = this.currentTrack;
    if (!t) return null;
    const stages = [
      {
        kind: 'source', quality: t.lossless || t.dsd ? 'lossless' : 'lossy',
        label: t.codec || 'PCM',
        detail: `${t.bitsPerSample || 16}-bit / ${((t.sampleRate || 44100) / 1000)} kHz`,
      },
      {
        kind: 'dsp', quality: 'bitperfect', label: 'HTTP serve',
        detail: 'original file streamed untouched',
      },
      {
        kind: 'output', quality: 'lossless',
        label: this.zone?.name || 'Network renderer',
        detail: `${this.zone?.openhome ? 'OpenHome' : 'UPnP AV'} · renderer decodes`,
      },
    ];
    return { stages, overall: t.lossless || t.dsd ? 'lossless' : 'lossy', engine: 'zone' };
  }
}
