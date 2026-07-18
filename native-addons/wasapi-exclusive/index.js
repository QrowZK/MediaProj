'use strict';

// Loader for the WASAPI exclusive-mode addon. On non-Windows platforms (or
// when the binary is missing/failed to build) this exports available:false
// and the engine silently falls back to the RtAudio path.

let native = null;
if (process.platform === 'win32') {
  try {
    native = require('./build/Release/wasapi_exclusive.node');
    if (typeof native.open !== 'function') native = null; // stub build
  } catch {
    native = null;
  }
}

module.exports = native
  ? { available: true, ...wrap(native) }
  : { available: false };

function wrap(n) {
  return {
    listDevices: () => n.listDevices(),
    open: (opts) => {
      const res = n.open(opts);
      return {
        handle: res.handle,
        bufferFrames: res.bufferFrames,
        rate: res.rate,
        // report the format the quantizer should target (valid bits; the
        // addon converts the int32 container to the wire format itself)
        format: res.validBits === 16 ? 's16' : res.validBits === 24 ? 's24' : 's32',
        containerBits: res.containerBits,
      };
    },
    write: (h, buf) => n.write(h, buf),
    queued: (h) => n.queued(h),
    position: (h) => n.position(h),
    start: (h) => n.start(h),
    stop: (h) => n.stop(h),
    clear: (h) => n.clear(h),
    close: (h) => n.close(h),
  };
}
