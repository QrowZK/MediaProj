'use strict';

// Pure helpers for main-process hardening: path checks, bounded on-disk caches
// and encrypted credential records. No Electron imports, so they unit-test
// under plain Node (test/hardening.test.js).

const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// \\server\share, //server/share, \\?\…, \\.\pipe\… — anything Windows would
// open over SMB or through a device namespace. Merely opening (or stat-ing)
// \\host\share hands the user's NTLM hash to that host.
function isUncPath(p) {
  return typeof p === 'string' && /^[\\/]{2}/.test(p);
}

function isAbsolutePath(p) {
  return typeof p === 'string' && p.length > 0 &&
    (path.isAbsolute(p) || path.win32.isAbsolute(p)) && !p.includes('\0');
}

// Containment check on the RESOLVED path: a raw startsWith lets
// "<dir>/../x" (and sibling dirs like "<dir>-x") through.
function isInsideDir(dir, p) {
  const rel = path.relative(dir, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Library lookups by id, memoized per library object (scan and analyze swap
// in a new object, which invalidates the index).
const libIndex = new WeakMap();
function indexLibrary(lib) {
  let idx = libIndex.get(lib);
  if (!idx) {
    const byId = new Map();
    const paths = new Set();
    for (const t of lib?.tracks || []) {
      byId.set(t.id, t);
      if (t.path) paths.add(t.path);
    }
    idx = { byId, paths };
    libIndex.set(lib, idx);
  }
  return idx;
}

function findLibraryTrack(lib, id) {
  if (!lib || (typeof id !== 'string' && typeof id !== 'number')) return null;
  return indexLibrary(lib).byId.get(id) || null;
}

function isLibraryPath(lib, p) {
  return !!lib && typeof p === 'string' && indexLibrary(lib).paths.has(p);
}

// ---------------------------------------------------------------------------
// Bounded caches
// ---------------------------------------------------------------------------

// Cache records are { ts, ... }. A record is fresh while younger than its TTL;
// "nothing found" records get a shorter TTL so new lyrics / bios show up.
function isFresh(record, { ttlMs, negativeTtlMs, isNegative }, now = Date.now()) {
  if (!record || typeof record.ts !== 'number') return false;
  const ttl = isNegative(record) ? negativeTtlMs : ttlMs;
  return now - record.ts < ttl;
}

// Drops expired records, then the oldest until both the entry count and the
// serialized size fit. `keep` names a key that is never evicted (the one just
// written). Mutates `index`; returns the removed [key, record] pairs so the
// caller can clean up files they reference.
function pruneCache(index, opts, now = Date.now(), keep = null) {
  const { maxEntries, maxBytes } = opts;
  const removed = [];
  for (const [key, rec] of Object.entries(index)) {
    if (key !== keep && !isFresh(rec, opts, now)) {
      removed.push([key, rec]);
      delete index[key];
    }
  }
  const sizes = new Map();
  let total = 2;
  for (const [key, rec] of Object.entries(index)) {
    const size = JSON.stringify(key).length + JSON.stringify(rec).length + 2;
    sizes.set(key, size);
    total += size;
  }
  let count = sizes.size;
  if (count > maxEntries || total > maxBytes) {
    const oldestFirst = [...sizes.keys()]
      .filter((k) => k !== keep)
      .sort((a, b) => (index[a].ts || 0) - (index[b].ts || 0));
    for (const key of oldestFirst) {
      if (count <= maxEntries && total <= maxBytes) break;
      removed.push([key, index[key]]);
      total -= sizes.get(key);
      count--;
      delete index[key];
    }
  }
  return removed;
}

// Lyrics cache values used to be the bare entry ({ text, synced } or null).
// Old hits count as fetched now; old misses as stale, so they are retried.
function migrateLyricsCache(cache, now = Date.now()) {
  for (const [key, val] of Object.entries(cache)) {
    if (val === null) cache[key] = { entry: null, ts: 0 };
    else if (val && typeof val.ts !== 'number') cache[key] = { entry: val, ts: now };
  }
  return cache;
}

const LYRICS_CACHE_LIMITS = {
  maxEntries: 2000,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 180 * 86400e3,
  negativeTtlMs: 7 * 86400e3,
  isNegative: (r) => !r.entry,
};
// A single lyric bigger than this is served but not cached.
const LYRICS_MAX_ENTRY_CHARS = 64 * 1024;

const ARTIST_CACHE_LIMITS = {
  maxEntries: 500,
  maxBytes: 4 * 1024 * 1024,
  ttlMs: 90 * 86400e3,
  negativeTtlMs: 14 * 86400e3,
  isNegative: (r) => !r.bio && !r.imgFile,
};

// ---------------------------------------------------------------------------
// Last.fm credentials
// ---------------------------------------------------------------------------

const LASTFM_SECRET_FIELDS = ['apiKey', 'apiSecret', 'sessionKey', 'username'];

// Splits settings.lastfm into what may stay in settings.json and the
// credentials that belong in the encrypted store. `secrets` is null when the
// settings carry none.
function splitLastfmSettings(settings) {
  const lf = settings && settings.lastfm;
  if (!lf || typeof lf !== 'object') return { settings, secrets: null };
  const secrets = {};
  const rest = {};
  for (const [k, v] of Object.entries(lf)) {
    if (LASTFM_SECRET_FIELDS.includes(k)) secrets[k] = v;
    else if (k !== 'connected') rest[k] = v;
  }
  const hasSecrets = Object.keys(secrets).length > 0;
  return { settings: { ...settings, lastfm: rest }, secrets: hasSecrets ? secrets : null };
}

// safeStorage is Electron's (DPAPI on Windows). Where the OS offers no
// encryption the record falls back to plain JSON, flagged as such.
function encodeSecretRecord(obj, safeStorage) {
  const json = JSON.stringify(obj || {});
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return { v: 1, enc: 'safeStorage', data: safeStorage.encryptString(json).toString('base64') };
  }
  return { v: 1, enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') };
}

function decodeSecretRecord(record, safeStorage) {
  if (!record || typeof record.data !== 'string') return {};
  try {
    const buf = Buffer.from(record.data, 'base64');
    const json = record.enc === 'safeStorage'
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {}; // unreadable (other user / machine) — behave as not connected
  }
}

module.exports = {
  isUncPath,
  isAbsolutePath,
  isInsideDir,
  findLibraryTrack,
  isLibraryPath,
  isFresh,
  pruneCache,
  migrateLyricsCache,
  LYRICS_CACHE_LIMITS,
  LYRICS_MAX_ENTRY_CHARS,
  ARTIST_CACHE_LIMITS,
  splitLastfmSettings,
  encodeSecretRecord,
  decodeSecretRecord,
};
