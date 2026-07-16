# Auralis

**A lossless-first music player and library manager for people who hear the difference.**

Auralis is a desktop audio player in the spirit of MusicBee, redesigned from the ground up
with an audiophile's priorities: your library's *quality* is a first-class citizen — sample
rates, bit depths, codecs, and dynamics are surfaced everywhere — wrapped in a dark,
brass-accented interface built for long listening sessions.

![Auralis](assets/icon.png)

## Features

### Library
- **Deep format support for indexing** — FLAC, WAV, AIFF, ALAC, APE, WavPack, DSD (.dsf/.dff),
  MP3, AAC, OGG, Opus, WMA. Full metadata, embedded artwork, ReplayGain tags.
- **Quality-aware everywhere** — hi-res (`24/96`, `24/192`), lossless, and DSD badges on albums
  and tracks; per-track codec / bit depth / sample rate / bitrate readouts.
- **Fast incremental scans** — only changed files are re-read on rescan.
- **Albums · Artists · Tracks · Genres** views, global search (`Ctrl F`), sortable columns,
  playlists, play queue with drag-free "Play Next / Add to Queue".
- **Most Played** — a built-in smart collection of your top 25 tracks. A play is counted
  once you're halfway through a track (or four minutes in), scrobble-style.
- **Artist profiles** — artist pages show a photo (Deezer) and a biography snippet
  (Wikipedia) with a Read-more expander, fetched on demand and cached locally.
  Toggle off under Settings → Audio Output → "Online artist info" if you prefer
  a fully offline player.

### Playback engine
- **Gapless playback** — the next track is pre-buffered and handed off without silence.
- **10-band parametric EQ** — shelving ends, peaking mids, automatic pre-amp headroom
  compensation so boosts never clip. Presets included (Warm Tube, V-Shape, Vocal, …),
  processed in the 32-bit float DSP domain.
- **ReplayGain** — track or album mode, read from your files' tags.
- **Output device selection** — route playback straight to your DAC.
- **Live spectrum analyzer** (log-frequency, peak-hold) and **stereo VU meters**.
- **Lyrics on the Now Playing screen** — from `.lrc`/`.txt` side files, embedded tags, or
  LRCLIB lookup (cached). Time-synced lyrics follow the music with the active line
  highlighted; click a line to seek. The artwork slides over gracefully when lyrics are
  present and recenters when they're not. Toggle in Settings.
- **Last.fm scrobbling** — standard half-track/four-minute rule, now-playing updates,
  and an offline queue that retries failed scrobbles. Bring your own free API key
  (last.fm/api/account/create), connect once in the browser, done.
- **Mini player** — a compact always-on-top window (art, transport, seek) in the spirit
  of MusicBee's mini mode. Toggle from the player bar; pop back to full size anytime.
- **OS media key support** via MediaSession.

### Honest notes for the discerning ear
Decoding is performed by the Chromium media engine (FLAC / WAV / AIFF / MP3 / AAC /
OGG / Opus natively). DSD, APE, and WavPack files are fully indexed and catalogued;
native decode for those formats — and WASAPI exclusive / bit-perfect output — is on
the roadmap and would come via a native decode backend. The Web Audio pipeline runs
at the output device's shared-mode rate.

## Install (Windows)

Grab `Auralis-Setup-<version>.exe` from the releases page (or build it yourself, below),
run it, and pick an install directory. The installer creates Start Menu and desktop
shortcuts. No telemetry, no accounts, no nonsense.

### Auto-updates

The installed app checks GitHub Releases on startup (toggle under Settings →
About & Updates), downloads new versions in the background using differential
blockmap updates, and offers a one-click restart — declined updates install on
the next quit. Publishing an update is just pushing a tag:

```bash
git tag v1.3.1 && git push origin v1.3.1
```

The CI workflow builds the installer and publishes the release (including the
`latest.yml` update manifest) automatically.

## Build from source

```bash
npm install
npm start            # run in development
npm run dist:win     # build the Windows NSIS installer → release/Auralis-Setup-*.exe
```

Building the Windows installer works on Windows and on Linux (electron-builder
cross-builds NSIS). If your network blocks GitHub release downloads, set:

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

A GitHub Actions workflow (`.github/workflows/build.yml`) builds the installer on every
tag push (`v*`) and attaches it to a GitHub Release — or run it manually from the
Actions tab (workflow_dispatch) and download the artifact.

## Architecture

```
electron/main.js      Main process — window, library scanner (music-metadata),
                      JSON persistence, `auralis://` streaming protocol (Range-capable)
electron/preload.js   contextBridge IPC surface (no nodeIntegration in the renderer)
src/index.html        App shell
src/css/styles.css    Design system
src/js/player.js      AudioEngine — dual-element gapless graph, EQ, ReplayGain, sinks
src/js/visualizer.js  Spectrum analyzer + stereo VU meters
src/js/app.js         Views, queue, playlists, settings, keyboard shortcuts
```

## License

MIT
