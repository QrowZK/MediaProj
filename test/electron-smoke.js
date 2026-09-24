'use strict';

// End-to-end check of the main-process hardening inside the real app.
// Boots Auralis against a throwaway profile, drives the preload API from the
// page, and exits non-zero on any failure. No network access is needed.
//
//   npm run test:electron            (Windows / desktop)
//   xvfb-run -a npx electron --no-sandbox test/electron-smoke.js   (Linux CI)

const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'auralis-smoke-'));
app.setPath('userData', profile);

// Fixture library: one local track with a side-file .lrc, one on a "NAS".
const music = path.join(profile, 'music');
fs.mkdirSync(music);
const localTrack = path.join(music, 'song.wav');
fs.writeFileSync(localTrack, Buffer.alloc(64));
fs.writeFileSync(path.join(music, 'song.lrc'), '[00:01.00]side file lyric\n');
const nasTrack = '\\\\nas\\music\\disc.flac';
const b64 = (p) => Buffer.from(p, 'utf8').toString('base64url');
const trackBase = { artist: 'A', albumArtist: 'A', album: 'B', albumKey: 'a::b', duration: 60 };
const library = {
  folders: [music],
  tracks: [
    { ...trackBase, id: 't1', path: localTrack, url: 'auralis://media/' + b64(localTrack), title: 'Song' },
    { ...trackBase, id: 't2', path: path.join(music, 'gone.flac'), title: 'Cached' },
    { ...trackBase, id: 't3', path: nasTrack, url: 'auralis://media/' + b64(nasTrack), title: 'On NAS' },
  ],
};
const write = (name, data) => fs.writeFileSync(path.join(profile, name), JSON.stringify(data));
write('library.json', library);
// An older build's settings.json, with the Last.fm credentials in the clear.
write('settings.json', {
  volume: 0.7,
  lastfm: { enabled: true, apiKey: 'KEY-123', apiSecret: 'SECRET-456', sessionKey: 'SESSION-789', username: 'sam' },
});
// Old-format lyrics cache (bare values, no timestamps).
write('lyrics-cache.json', { 'a::cached': { text: 'cached lyric', synced: false }, 'a::miss': null });
write('artist-info.json', { 'fresh artist': { bio: 'bio', url: null, imgFile: null, ts: Date.now() } });

// Record what reaches the OS shell and the native engine.
const shown = [];
shell.showItemInFolder = (p) => { shown.push(p); };
const { NativeAudioEngine } = require('../electron/native-engine');
const configs = [];
const origSetConfig = NativeAudioEngine.prototype.setConfig;
NativeAudioEngine.prototype.setConfig = function (partial) {
  configs.push(JSON.parse(JSON.stringify(partial)));
  return origSetConfig.call(this, partial);
};
const played = [];
NativeAudioEngine.prototype.play = async function (track) { played.push(track); };

require('../electron/main.js');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) console.log('     [page] ' + e.message);
  });
  win.webContents.once('did-finish-load', () => setTimeout(() => run(win).catch((err) => {
    check('harness ran without throwing', false, err.stack);
    finish();
  }), 1000));
});

async function run(win) {
  const page = (js) => win.webContents.executeJavaScript(js, true);

  // ── Last.fm credentials ──
  const settings = await page('window.auralis.settings.get()');
  check('settings:get returns no Last.fm secrets', !/SECRET|SESSION|KEY-123/.test(JSON.stringify(settings)), settings);
  check('non-secret settings survive the migration', settings.volume === 0.7 && settings.lastfm?.enabled === true, settings);
  const onDisk = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8');
  check('settings.json no longer holds the secrets', !/SECRET|SESSION/.test(onDisk), onDisk);
  const credsFile = fs.readFileSync(path.join(profile, 'lastfm-credentials.json'), 'utf8');
  const enc = JSON.parse(credsFile).enc;
  console.log(`     (credential store encryption: ${enc})`);
  check('credential file holds no plaintext secret', !/SECRET-456|SESSION-789/.test(credsFile), credsFile);
  const status = await page('window.auralis.lastfm.status()');
  check('lastfm:status reports connected without leaking the secret',
    status.connected && status.hasSecret && status.username === 'sam' && !('apiSecret' in status) &&
    !JSON.stringify(status).includes('SESSION'), status);
  // The page, as it would after boot, saves its settings; an old page that
  // still carries the secret must not put it back on disk.
  await page(`window.auralis.settings.set({ volume: 0.5, lastfm: { enabled: true, apiSecret: 'SECRET-456' } })`);
  await new Promise((r) => setTimeout(r, 200));
  const afterSet = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8');
  check('settings:set strips secrets sent by the page', !afterSet.includes('SECRET') && afterSet.includes('0.5'), afterSet);
  await page(`document.querySelector('.nav-item[data-view="settings"]').click()`);
  await new Promise((r) => setTimeout(r, 800)); // the settings view renders async
  const uiText = await page(`document.querySelector('#lastfm-status').textContent.trim() +
    '|' + document.querySelector('#lf-key').value + '|' + document.querySelector('#lf-secret').value +
    '|' + document.querySelector('#lf-secret').placeholder`);
  check('settings page shows the connection, not the secret',
    uiText.startsWith('Connected as sam|KEY-123||Shared secret (saved'), uiText);
  await page('window.auralis.lastfm.disconnect()');
  const afterDc = await page('window.auralis.lastfm.status()');
  check('disconnect drops the session but keeps key and secret',
    !afterDc.connected && afterDc.hasSecret && afterDc.apiKey === 'KEY-123', afterDc);
  const scrobble = await page(`window.auralis.lastfm.scrobble({ artist: 'A', title: 'S', timestamp: 1 })`);
  check('scrobble while disconnected queues instead of throwing', scrobble.submitted === 0 && scrobble.queued === 1, scrobble);

  // ── Paths come from the library, by id ──
  const lyr = await page(`window.auralis.lyrics.get({ id: 't1', path: '/etc/passwd' })`);
  check('lyrics:get reads the library track\'s side file', lyr?.source === 'file' && lyr.text.includes('side file'), lyr);
  const lyrBad = await page(`window.auralis.lyrics.get({ id: 'nope', path: ${JSON.stringify(localTrack)} })`);
  check('lyrics:get ignores unknown ids', lyrBad === null, lyrBad);
  const lyrCached = await page(`window.auralis.lyrics.get({ id: 't2' })`);
  check('old-format lyrics cache is still read', lyrCached?.text === 'cached lyric', lyrCached);

  const np = await page(`window.auralis.native.play({ id: 'nope', path: '\\\\\\\\evil\\\\x.flac' }, 0)`);
  check('native:play rejects tracks not in the library', np.ok === false && /not in the library/.test(np.error), np);
  const np2 = await page(`window.auralis.native.play({ id: 't1', path: '\\\\\\\\evil\\\\x.flac' }, 0)`);
  check('native:play uses the library path, not the page\'s',
    np2.ok && played.length === 1 && played[0].path === localTrack, { np2, played });
  await page(`window.auralis.native.config({ correction: { enabled: true, irPath: '\\\\\\\\evil\\\\ir.wav' } })`);
  await page(`window.auralis.native.config({ correction: { enabled: true, irPath: ${JSON.stringify(localTrack)} } })`);
  check('native:config drops a network impulse response, keeps a local .wav',
    configs.at(-2)?.correction?.irPath === null && configs.at(-1)?.correction?.irPath === localTrack, configs.slice(-2));

  await page(`window.auralis.shell.showTrack('t1')`);
  await page(`window.auralis.shell.showTrack('nope')`);
  await page(`window.auralis.shell.showFolder(${JSON.stringify(os.homedir())})`);
  check('show-in-folder only opens library tracks', shown.length === 1 && shown[0] === localTrack, shown);

  const exp = await page(`window.auralis.library.export({ trackIds: ['t1'], destDir: ${JSON.stringify(profile)}, format: 'copy' })`);
  check('export refuses a folder not picked in the dialog', exp.ok === false, exp);

  // ── auralis:// protocol ──
  const fetchStatus = (p) => page(`fetch('auralis://media/${b64(p)}').then((r) => r.status, () => -1)`);
  check('protocol serves a library track', (await fetchStatus(localTrack)) === 200);
  check('protocol refuses a network path outside the library', (await fetchStatus('\\\\evil\\share\\x.flac')) === 403);
  check('protocol refuses //host paths', (await fetchStatus('//evil/share/x.flac')) === 403);
  check('protocol allows the library\'s own network path through the check',
    (await fetchStatus(nasTrack)) !== 403); // 400 here: no such share on this machine
  check('protocol refuses art-cache traversal',
    (await fetchStatus(path.join(profile, 'art-cache', '..', 'settings.json'))) === 403);
  check('protocol refuses relative paths', (await fetchStatus('music/song.wav')) === 403);

  // ── Artist cache (fresh entries are served without the network) ──
  const artist = await page(`window.auralis.artist.info('Fresh Artist')`);
  check('fresh artist-info entries are served from cache', artist?.bio === 'bio', artist);

  // ── Scan: a network folder the user never picked is dropped ──
  const scanned = await page(`window.auralis.library.scan([${JSON.stringify(music)}, '\\\\\\\\evil\\\\share'])`);
  check('scan drops unpicked network folders', JSON.stringify(scanned?.folders) === JSON.stringify([music]), scanned?.folders);

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(failed || !results.length ? 1 : 0);
}

setTimeout(() => { console.log('FAIL timed out'); app.exit(2); }, 60000);
