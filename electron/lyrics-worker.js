'use strict';

// Parses embedded tags for the lyrics lookup off the main thread (see
// parseTagsInWorker in main.js). Receives { path } via workerData and posts
// back { ok, lyrics } — only the field getLyrics reads (common.lyrics).

const { parentPort, workerData } = require('worker_threads');

(async () => {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(workerData.path, { skipCovers: true, duration: false });
    parentPort.postMessage({ ok: true, lyrics: meta?.common?.lyrics || [] });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
})();
