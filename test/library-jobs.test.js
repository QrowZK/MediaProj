const test = require('node:test');
const assert = require('node:assert');
const { createJobQueue } = require('../electron/library-jobs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('jobs never overlap and run in request order', async () => {
  const q = createJobQueue();
  let running = 0, maxRunning = 0; const order = [];
  const job = (name, ms) => q.run(name, async () => {
    running++; maxRunning = Math.max(maxRunning, running); order.push('start:' + name);
    await sleep(ms); order.push('end:' + name); running--; return name;
  });
  const res = await Promise.all([job('a', 30), job('b', 5), job('c', 10)]);
  assert.deepStrictEqual(res, ['a', 'b', 'c']);
  assert.strictEqual(maxRunning, 1);
  assert.deepStrictEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.strictEqual(q.busy(), false);
});

test('onWait fires only when something is ahead, naming it', async () => {
  const q = createJobQueue();
  const waits = [];
  const p1 = q.run('scan', () => sleep(10), { onWait: (a) => waits.push(['scan', a]) });
  const p2 = q.run('loudness', () => sleep(1), { onWait: (a) => waits.push(['loudness', a]) });
  assert.deepStrictEqual(waits, [['loudness', 'scan']]);
  assert.strictEqual(q.busy(), true);
  await Promise.all([p1, p2]);
  q.run('scan', () => {}, { onWait: () => waits.push('bad') });
  await sleep(1);
  assert.strictEqual(waits.length, 1);
});

test('a failing job rejects its caller but does not block the next', async () => {
  const q = createJobQueue();
  const p1 = q.run('scan', async () => { throw new Error('boom'); });
  const p2 = q.run('loudness', async () => 'ok');
  await assert.rejects(p1, /boom/);
  assert.strictEqual(await p2, 'ok');
  assert.strictEqual(q.busy(), false);
});

test('a synchronous throw is contained too', async () => {
  const q = createJobQueue();
  const p1 = q.run('x', () => { throw new Error('sync'); });
  const p2 = q.run('y', () => 2);
  await assert.rejects(p1, /sync/);
  assert.strictEqual(await p2, 2);
});

test('abort while waiting: settles at once, fn never runs, order kept', async () => {
  const q = createJobQueue();
  const order = [];
  const ac = new AbortController();
  const p1 = q.run('scan', async () => { order.push('scan'); await sleep(40); order.push('scan-end'); });
  let ran = false;
  const p2 = q.run('loudness', async () => { ran = true; }, { signal: ac.signal, cancelledValue: 'CANCELLED' });
  const p3 = q.run('scan', async () => { order.push('scan2'); });
  await sleep(5);
  ac.abort();
  const t = Date.now();
  assert.strictEqual(await p2, 'CANCELLED');
  assert.ok(Date.now() - t < 20, 'settled promptly');
  await Promise.all([p1, p3]);
  assert.strictEqual(ran, false);
  assert.deepStrictEqual(order, ['scan', 'scan-end', 'scan2']);
  assert.strictEqual(q.busy(), false);
});

test('abort after start is left to fn', async () => {
  const q = createJobQueue();
  const ac = new AbortController();
  const p = q.run('loudness', async () => { await sleep(20); return ac.signal.aborted ? 'fn-saw-abort' : 'x'; },
    { signal: ac.signal, cancelledValue: 'CANCELLED' });
  await sleep(5);
  ac.abort();
  assert.strictEqual(await p, 'fn-saw-abort');
});

test('abort before the first microtask with nothing ahead still skips fn', async () => {
  const q = createJobQueue();
  const ac = new AbortController();
  let ran = false;
  const p = q.run('scan', () => { ran = true; }, { signal: ac.signal, cancelledValue: null });
  ac.abort();
  assert.strictEqual(await p, null);
  assert.strictEqual(ran, false);
});
