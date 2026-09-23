'use strict';

// Unit tests for electron/hardening.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const h = require('../electron/hardening');

test('isUncPath flags network and device paths only', () => {
  for (const p of ['\\\\server\\share\\a.flac', '//server/share/a.flac', '\\\\?\\UNC\\srv\\s\\a.flac',
    '\\\\?\\C:\\a.flac', '\\\\.\\pipe\\x', '\\/server/share']) {
    assert.equal(h.isUncPath(p), true, p);
  }
  for (const p of ['C:\\Music\\a.flac', 'D:/Music/a.flac', '/home/u/a.flac', 'a.flac', '', null, undefined, 42]) {
    assert.equal(h.isUncPath(p), false, String(p));
  }
});

test('isAbsolutePath accepts Windows and POSIX absolute paths, rejects relative and NUL', () => {
  assert.equal(h.isAbsolutePath('C:\\Music\\a.flac'), true);
  assert.equal(h.isAbsolutePath('/home/u/a.flac'), true);
  assert.equal(h.isAbsolutePath('Music/a.flac'), false);
  assert.equal(h.isAbsolutePath('C:a.flac'), false);
  assert.equal(h.isAbsolutePath('/a\0.flac'), false);
  assert.equal(h.isAbsolutePath(''), false);
  assert.equal(h.isAbsolutePath(null), false);
});

test('isInsideDir resolves .. and rejects sibling prefixes', () => {
  const dir = path.join(os.tmpdir(), 'art-cache');
  assert.equal(h.isInsideDir(dir, path.join(dir, 'a.jpg')), true);
  assert.equal(h.isInsideDir(dir, path.join(dir, '..', 'settings.json')), false);
  assert.equal(h.isInsideDir(dir, dir + '-x' + path.sep + 'a.jpg'), false);
  assert.equal(h.isInsideDir(dir, dir), false);
});

test('findLibraryTrack / isLibraryPath look up by id and path, and track library swaps', () => {
  const lib = { tracks: [{ id: 'a', path: '/m/a.flac' }, { id: 'b', path: '\\\\nas\\m\\b.flac' }] };
  assert.equal(h.findLibraryTrack(lib, 'a').path, '/m/a.flac');
  assert.equal(h.findLibraryTrack(lib, 'zzz'), null);
  assert.equal(h.findLibraryTrack(lib, { id: 'a' }), null);
  assert.equal(h.findLibraryTrack(null, 'a'), null);
  assert.equal(h.isLibraryPath(lib, '\\\\nas\\m\\b.flac'), true);
  assert.equal(h.isLibraryPath(lib, '\\\\evil\\x\\b.flac'), false);
  const lib2 = { tracks: [{ id: 'c', path: '/m/c.flac' }] };
  assert.equal(h.findLibraryTrack(lib2, 'a'), null);
  assert.equal(h.findLibraryTrack(lib2, 'c').path, '/m/c.flac');
});

test('isFresh honours positive and negative TTLs', () => {
  const opts = { ttlMs: 1000, negativeTtlMs: 100, isNegative: (r) => !r.entry };
  const now = 10_000;
  assert.equal(h.isFresh({ entry: 'x', ts: now - 999 }, opts, now), true);
  assert.equal(h.isFresh({ entry: 'x', ts: now - 1000 }, opts, now), false);
  assert.equal(h.isFresh({ entry: null, ts: now - 99 }, opts, now), true);
  assert.equal(h.isFresh({ entry: null, ts: now - 100 }, opts, now), false);
  assert.equal(h.isFresh({ entry: 'x' }, opts, now), false);
  assert.equal(h.isFresh(null, opts, now), false);
});

test('pruneCache drops expired entries, then oldest to fit count', () => {
  const opts = { maxEntries: 3, maxBytes: 1e9, ttlMs: 1000, negativeTtlMs: 1000, isNegative: () => false };
  const now = 5000;
  const index = {
    expired: { ts: now - 2000 },
    a: { ts: now - 500 }, b: { ts: now - 400 }, c: { ts: now - 300 }, d: { ts: now - 200 },
  };
  const removed = h.pruneCache(index, opts, now, 'a');
  assert.deepEqual(Object.keys(index).sort(), ['a', 'c', 'd']);
  assert.deepEqual(removed.map(([k]) => k).sort(), ['b', 'expired']);
});

test('pruneCache enforces the byte budget and keeps the protected key', () => {
  const opts = { maxEntries: 1e6, maxBytes: 2000, ttlMs: 1e9, negativeTtlMs: 1e9, isNegative: () => false };
  const now = 1e6;
  const index = {};
  for (let i = 0; i < 50; i++) index['k' + i] = { ts: now - 1000 + i, text: 'x'.repeat(100) };
  index.big = { ts: 0, text: 'y'.repeat(1500) }; // oldest, but just written
  h.pruneCache(index, opts, now, 'big');
  assert.ok(index.big, 'protected key survives');
  assert.ok(JSON.stringify(index).length <= 2000, 'fits the budget: ' + JSON.stringify(index).length);
  assert.ok(index.k49, 'newest kept');
  assert.ok(!index.k0, 'oldest evicted');
});

test('pruneCache is a no-op under the limits', () => {
  const index = { a: { entry: { text: 'x' }, ts: 100 } };
  const removed = h.pruneCache(index, h.LYRICS_CACHE_LIMITS, 200);
  assert.equal(removed.length, 0);
  assert.deepEqual(index, { a: { entry: { text: 'x' }, ts: 100 } });
});

test('migrateLyricsCache wraps old values: hits as fresh, misses as stale', () => {
  const now = 1e12;
  const c = h.migrateLyricsCache({
    hit: { text: 'la', synced: false }, miss: null, already: { entry: null, ts: 5 },
  }, now);
  assert.deepEqual(c.hit, { entry: { text: 'la', synced: false }, ts: now });
  assert.deepEqual(c.miss, { entry: null, ts: 0 });
  assert.deepEqual(c.already, { entry: null, ts: 5 });
  assert.equal(h.isFresh(c.hit, h.LYRICS_CACHE_LIMITS, now), true);
  assert.equal(h.isFresh(c.miss, h.LYRICS_CACHE_LIMITS, now), false);
});

test('splitLastfmSettings moves credentials out and keeps the rest', () => {
  const { settings, secrets } = h.splitLastfmSettings({
    volume: 0.5,
    lastfm: { enabled: true, apiKey: 'K', apiSecret: 'S', sessionKey: 'SK', username: 'u', connected: true },
  });
  assert.deepEqual(settings, { volume: 0.5, lastfm: { enabled: true } });
  assert.deepEqual(secrets, { apiKey: 'K', apiSecret: 'S', sessionKey: 'SK', username: 'u' });
  assert.equal(JSON.stringify(settings).includes('S'), false);

  const clean = h.splitLastfmSettings({ lastfm: { enabled: false } });
  assert.equal(clean.secrets, null);
  assert.equal(h.splitLastfmSettings({ volume: 1 }).secrets, null);
  assert.equal(h.splitLastfmSettings(null).secrets, null);
});

test('secret records round-trip through safeStorage and never hold plaintext', () => {
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
    decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString('utf8'),
  };
  const creds = { apiKey: 'KEY123', apiSecret: 'SECRET456', sessionKey: 'SESS789' };
  const rec = h.encodeSecretRecord(creds, fake);
  assert.equal(rec.enc, 'safeStorage');
  const onDisk = JSON.stringify(rec);
  for (const v of Object.values(creds)) assert.equal(onDisk.includes(v), false);
  assert.equal(Buffer.from(rec.data, 'base64').toString('utf8').includes('SECRET456'), false);
  assert.deepEqual(h.decodeSecretRecord(rec, fake), creds);
});

test('secret records fall back to plain when encryption is unavailable, and fail closed', () => {
  const none = { isEncryptionAvailable: () => false };
  const rec = h.encodeSecretRecord({ apiKey: 'k' }, none);
  assert.equal(rec.enc, 'plain');
  assert.deepEqual(h.decodeSecretRecord(rec, none), { apiKey: 'k' });
  const broken = { decryptString: () => { throw new Error('other user'); } };
  assert.deepEqual(h.decodeSecretRecord({ v: 1, enc: 'safeStorage', data: 'AAAA' }, broken), {});
  assert.deepEqual(h.decodeSecretRecord(null, none), {});
  assert.deepEqual(h.decodeSecretRecord({ enc: 'plain', data: 'bm90IGpzb24=' }, none), {});
});
