---
project: Auralis
phase: building
health: green
updated: 2026-09-13T23:39:32.415Z
summary: The ReplayGain/EBU R128 loudness scanner and dynamic-range display are built but uncommitted, leaving cue sheet support as the remaining Tier 1 feature. All recent playback, visualizer, and loudness work still needs committing and real-device verification.
---

## Now
- [ ] Add cue sheet support: split single-file albums into tracks <!-- id:t22 -->

## Next
- [ ] Commit and push the playback, visualizer, and loudness work <!-- id:t24 -->
- [ ] Manually verify native gapless and paused-switch fixes on a real device <!-- id:t16 -->

## Blocked
- [ ] Run Electron boot smoke test to catch renderer errors — waits on npm install (no node_modules) <!-- id:t19 -->

## Recently done
- [x] Build ReplayGain / EBU R128 scanner that writes gain tags <!-- id:t21 -->
- [x] Surface dynamic-range (DR/R128) on albums and tracks <!-- id:t23 -->
- [x] Run syntax and static-invariant checks on the fix batch <!-- id:t20 -->
- [x] Make native gapless sample-accurate (drop ~11ms inter-track silence) <!-- id:t9 -->
- [x] Fix UI desync when a gapless join fails on device reopen <!-- id:t10 -->
- [x] Keep playback paused across an engine/output switch instead of auto-resuming <!-- id:t11 -->
- [x] Verify native position clock across pause/resume - found correct, no fix needed <!-- id:t17 -->
- [x] Raise standard-engine spectrum FFT to 8192 to kill visualizer left-edge slant <!-- id:t13 -->
