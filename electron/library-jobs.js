'use strict';

// Library scans and loudness analysis both read library.json, work for a
// while, then write the whole library back. Run side by side, whichever
// finished last silently threw away the other's result. This queue runs such
// jobs strictly one at a time, in the order they were requested.
function createJobQueue() {
  let tail = Promise.resolve();
  let pending = 0;       // jobs queued or running
  let lastName = null;   // the job at the back of the line

  return {
    busy: () => pending > 0,

    // Runs fn() once every earlier job has settled. When the job has to wait,
    // onWait(nameOfJobAhead) fires synchronously so the UI can say so. If
    // `signal` aborts before fn() starts, fn() never runs and the job settles
    // at once with `cancelledValue`; once fn() has started, cancelling is fn's
    // business.
    run(name, fn, { onWait, signal, cancelledValue } = {}) {
      const ahead = pending > 0 ? lastName : null;
      pending++;
      lastName = name;
      let started = false;
      const ran = tail.then(() => {
        if (signal?.aborted) return cancelledValue;
        started = true;
        return fn();
      }).finally(() => {
        if (--pending === 0) lastName = null;
      });
      tail = ran.catch(() => {}); // one failed job must not block the next
      if (ahead) onWait?.(ahead);
      if (!signal) return ran;
      // A skipped job still takes its (empty) turn, so the ones behind it
      // keep their order; only its caller hears back early.
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { if (!started) resolve(cancelledValue); }, { once: true });
        ran.then(resolve, reject);
      });
    },
  };
}

module.exports = { createJobQueue };
