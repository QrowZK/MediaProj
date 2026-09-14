---
project: Auralis
phase: building
health: green
updated: 2026-09-13T23:57:41.229Z
summary: All three Tier 1 features — the ReplayGain/EBU R128 loudness scanner, the dynamic-range display, and cue sheet support — are now built, with the earlier loudness and playback work already committed. Cue sheet support is the latest addition, still uncommitted and awaiting real-device verification.
---

## Now
- [ ] Commit and push the cue sheet support work <!-- id:t25 -->
- [ ] Manually verify cue sheet playback with real .cue and audio files <!-- id:t26 -->

## Next
- [ ] Manually verify native gapless and paused-switch fixes on a real device <!-- id:t16 -->

## Blocked
- [ ] Run Electron boot smoke test to catch renderer errors — waits on npm install (no node_modules) <!-- id:t19 -->

## Recently done
- [x] Add cue sheet support: split single-file albums into tracks <!-- id:t22 -->
- [x] Make loudness analyzer measure cue segments, not whole files <!-- id:t27 -->
- [x] Commit and push the playback, visualizer, and loudness work <!-- id:t24 -->
- [x] Build ReplayGain / EBU R128 scanner that writes gain tags <!-- id:t21 -->
- [x] Surface dynamic-range (DR/R128) on albums and tracks <!-- id:t23 -->
- [x] Run syntax and static-invariant checks on the fix batch <!-- id:t20 -->
- [x] Make native gapless sample-accurate (drop ~11ms inter-track silence) <!-- id:t9 -->
- [x] Fix UI desync when a gapless join fails on device reopen <!-- id:t10 -->
