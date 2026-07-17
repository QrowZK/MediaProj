// ═══════════════════════════════════════════════════════════════════════
// Auralis — application shell
// ═══════════════════════════════════════════════════════════════════════

import { AudioEngine, EQ_FREQUENCIES, EQ_PRESETS } from './player.js';
import { NativeEngineProxy } from './native-player.js';
import { SpectrumVisualizer, VuMeter } from './visualizer.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── State ────────────────────────────────────────────────────────────────

const state = {
  library: { folders: [], tracks: [] },
  playlists: [],
  settings: {},
  stats: { plays: {}, lastPlayed: {} },
  artistCache: {},
  view: 'albums',
  viewArg: null,
  search: '',
  queue: [],
  queueIndex: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
  sortKey: 'artist',
  sortDir: 1,
};

const webEngine = new AudioEngine();
let nativeEngine = null;
let engine = webEngine;
const spectrum = new SpectrumVisualizer($('#np-spectrum'), engine);
const vu = new VuMeter($('#vu-meter'), engine);
vu.start();

function attachEngineCallbacks(e) {
  e.peekNext = enginePeekNext;
  e.onTrackEnd = engineOnTrackEnd;
  e.onTrackStarted = (track) => onTrackStarted(track);
  e.onError = engineOnError;
  e.onTimeUpdate = engineOnTimeUpdate;
}

async function switchEngine(useNative) {
  const playingTrack = engine.currentTrack;
  const pos = engine.currentTime;
  engine.pause();
  if (useNative) {
    if (!nativeEngine) nativeEngine = new NativeEngineProxy();
    engine = nativeEngine;
  } else {
    engine = webEngine;
  }
  attachEngineCallbacks(engine);
  spectrum.engine = engine;
  spectrum.buffer = new Uint8Array(engine.analyser.frequencyBinCount);
  vu.engine = engine;
  // carry DSP state over
  engine.setVolume(webEngine.volume);
  engine.applyEqGains([...webEngine.eqGains]);
  engine.setEqEnabled(webEngine.eqEnabled);
  engine.setReplayGainMode(webEngine.replayGainMode);
  engine.setSpeakerCorrection?.(correctionConfig());
  if (playingTrack) {
    const ok = await engine.play(playingTrack);
    if (ok) {
      onTrackStarted(playingTrack);
      if (pos > 1) engine.seek(pos);
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────────────

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLongTime(sec) {
  if (sec < 60) return `${Math.round(sec)} sec`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function qualityLabel(t) {
  if (!t) return '';
  if (t.dsd) {
    const rate = t.sampleRate ? `DSD${Math.round(t.sampleRate / 44100)}` : 'DSD';
    return rate;
  }
  const codec = (t.codec || '').split(' ')[0].toUpperCase().replace('MPEG', 'MP3');
  if (t.lossless && t.sampleRate) {
    const bits = t.bitsPerSample ? `${t.bitsPerSample}-bit ` : '';
    return `${codec} · ${bits}${(t.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz`;
  }
  return t.bitrate ? `${codec} · ${t.bitrate} kbps` : codec;
}

function qualityBadgeClass(t) {
  if (t.dsd) return 'dsd';
  if (t.lossless && (t.sampleRate > 48000 || (t.bitsPerSample || 16) > 16)) return 'hires';
  if (t.lossless) return 'lossless';
  return '';
}

function shortFmt(t) {
  if (t.dsd) return 'DSD';
  const codec = (t.codec || '').split(' ')[0].toUpperCase().replace('MPEG', 'MP3');
  if (t.lossless && t.sampleRate) {
    return `${codec} ${t.bitsPerSample || 16}/${Math.round(t.sampleRate / 1000)}`;
  }
  return codec || '—';
}

function toast(msg, isError = false, action = null) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.fn(); el.remove(); });
    el.appendChild(btn);
  }
  $('#toasts').appendChild(el);
  if (!action) {
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 3400);
  }
  return el;
}

// ── Library derived data ─────────────────────────────────────────────────

function filteredTracks() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.library.tracks;
  return state.library.tracks.filter((t) =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q) ||
    (t.genre || '').toLowerCase().includes(q));
}

function groupAlbums(tracks) {
  const map = new Map();
  for (const t of tracks) {
    let a = map.get(t.albumKey);
    if (!a) {
      a = { key: t.albumKey, album: t.album, artist: t.albumArtist, year: t.year,
            artUrl: t.artUrl, tracks: [] };
      map.set(t.albumKey, a);
    }
    if (!a.artUrl && t.artUrl) a.artUrl = t.artUrl;
    if (!a.year && t.year) a.year = t.year;
    a.tracks.push(t);
  }
  const albums = [...map.values()];
  for (const a of albums) {
    a.tracks.sort((x, y) => (x.discNo || 1) - (y.discNo || 1) || (x.trackNo || 0) - (y.trackNo || 0));
    a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    a.best = a.tracks.reduce((best, t) =>
      (t.sampleRate || 0) > (best.sampleRate || 0) ? t : best, a.tracks[0]);
  }
  albums.sort((x, y) => x.artist.localeCompare(y.artist) || (x.year || 0) - (y.year || 0));
  return albums;
}

function libraryStats() {
  const tracks = state.library.tracks;
  const lossless = tracks.filter((t) => t.lossless).length;
  const hires = tracks.filter((t) => t.lossless && (t.sampleRate > 48000 || (t.bitsPerSample || 16) > 16)).length;
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const size = tracks.reduce((s, t) => s + (t.fileSize || 0), 0);
  return { total: tracks.length, lossless, hires, dur, size };
}

// ── Rendering ────────────────────────────────────────────────────────────

const content = $('#content');

function render() {
  $$('.nav-item[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view && !String(state.view).startsWith('playlist')));
  const views = {
    albums: renderAlbums, album: renderAlbumDetail, artists: renderArtists,
    artist: renderArtistDetail, tracks: renderTracksView, genres: renderGenres,
    genre: renderGenreDetail, playlist: renderPlaylist, settings: renderSettings,
    mostplayed: renderMostPlayed,
  };
  (views[state.view] || renderAlbums)();
  renderSidebarPlaylists();
  renderLibraryStats();
}

function go(view, arg = null) {
  state.view = view;
  state.viewArg = arg;
  render();
  content.scrollTop = 0;
}

function renderLibraryStats() {
  const s = libraryStats();
  $('#library-stats').innerHTML = s.total
    ? `${s.total.toLocaleString()} tracks · ${fmtLongTime(s.dur)}<br>` +
      `${s.lossless.toLocaleString()} lossless · ${s.hires.toLocaleString()} hi-res<br>` +
      `${(s.size / 1e9).toFixed(1)} GB`
    : '';
}

function emptyLibraryMarkup() {
  return `
    <div class="empty-state">
      <div class="glyph">
        <svg viewBox="0 0 24 24" width="38" height="38"><path d="M9 18V5.5L20 3v12.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.6" cy="18.2" r="2.6" fill="currentColor"/><circle cx="17.6" cy="15.4" r="2.6" fill="currentColor"/></svg>
      </div>
      <h2>Your library awaits</h2>
      <p>Point Auralis at your music collection. FLAC, WAV, AIFF, DSD, APE, WavPack,
         MP3, AAC, OGG and more — metadata, artwork and quality info are indexed automatically.</p>
      <button class="btn primary" id="add-folder-cta">Add Music Folder</button>
    </div>`;
}

function bindEmptyCta() {
  $('#add-folder-cta')?.addEventListener('click', addFolders);
}

// ── Albums grid ──

function renderAlbums() {
  const albums = groupAlbums(filteredTracks());
  if (!state.library.tracks.length) {
    content.innerHTML = emptyLibraryMarkup();
    bindEmptyCta();
    return;
  }
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">Albums</span>
      <span class="view-sub">${albums.length} albums</span>
      <span class="spacer"></span>
      <button class="btn" id="rescan-btn">Rescan</button>
      <button class="btn primary" id="add-folder-btn">Add Folder</button>
    </div>
    <div class="album-grid">
      ${albums.map((a, i) => `
        <div class="album-card" data-key="${esc(a.key)}">
          <div class="album-art">
            ${a.artUrl
              ? `<img src="${esc(a.artUrl)}" loading="lazy" alt="" />`
              : `<div class="art-placeholder"><svg viewBox="0 0 24 24" width="42" height="42"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg></div>`}
            <button class="play-fab" data-play="${esc(a.key)}" title="Play album">
              <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
            </button>
          </div>
          <div class="album-title" title="${esc(a.album)}">${esc(a.album)}</div>
          <div class="album-artist">${esc(a.artist)}${a.year ? ` · ${a.year}` : ''}</div>
          <div class="album-badges">
            ${qualityBadgeClass(a.best) ? `<span class="badge ${qualityBadgeClass(a.best)}">${esc(shortFmt(a.best))}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
  $('#add-folder-btn').addEventListener('click', addFolders);
  $('#rescan-btn').addEventListener('click', rescan);
  content.querySelectorAll('.album-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.play-fab')) return;
      go('album', card.dataset.key);
    });
  });
  content.querySelectorAll('.play-fab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const album = albums.find((a) => a.key === btn.dataset.play);
      if (album) playTracks(album.tracks, 0);
    });
  });
}

// ── Album detail ──

function renderAlbumDetail() {
  const albums = groupAlbums(state.library.tracks);
  const album = albums.find((a) => a.key === state.viewArg);
  if (!album) return go('albums');
  content.innerHTML = `
    <button class="back-link" id="back-btn">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Albums
    </button>
    <div class="album-hero">
      <div class="hero-art">${album.artUrl ? `<img src="${esc(album.artUrl)}" alt=""/>` : ''}</div>
      <div class="hero-meta">
        <div class="hero-kicker">Album${album.year ? ` · ${album.year}` : ''}</div>
        <div class="hero-title">${esc(album.album)}</div>
        <div class="hero-sub"><b>${esc(album.artist)}</b> · ${album.tracks.length} tracks · ${fmtLongTime(album.duration)}</div>
        <div class="hero-actions">
          <button class="btn primary" id="hero-play">
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
            Play
          </button>
          <button class="btn" id="hero-shuffle">Shuffle</button>
          ${qualityBadgeClass(album.best) ? `<span class="badge ${qualityBadgeClass(album.best)}">${esc(qualityLabel(album.best))}</span>` : ''}
        </div>
      </div>
    </div>
    ${trackTable(album.tracks, { numbers: true })}`;
  $('#back-btn').addEventListener('click', () => go('albums'));
  $('#hero-play').addEventListener('click', () => playTracks(album.tracks, 0));
  $('#hero-shuffle').addEventListener('click', () => {
    state.shuffle = true;
    updateTransportUi();
    playTracks(album.tracks, Math.floor(Math.random() * album.tracks.length));
  });
  bindTrackTable(album.tracks);
}

// ── Track table (shared) ──

function trackTable(tracks, opts = {}) {
  const currentId = engine.currentTrack?.id;
  return `
    <table class="tracks">
      <thead><tr>
        <th class="t-num">#</th>
        <th ${opts.sortable ? 'data-sort="title"' : ''}>Title${sortArrow('title', opts)}</th>
        <th ${opts.sortable ? 'data-sort="artist"' : ''}>Artist${sortArrow('artist', opts)}</th>
        <th ${opts.sortable ? 'data-sort="album"' : ''}>Album${sortArrow('album', opts)}</th>
        <th class="t-rating" ${opts.sortable ? 'data-sort="rating"' : ''}>Rating${sortArrow('rating', opts)}</th>
        ${opts.extraCol ? `<th class="t-dur">${esc(opts.extraCol.header)}</th>` : ''}
        <th class="t-fmt" ${opts.sortable ? 'data-sort="quality"' : ''}>Quality${sortArrow('quality', opts)}</th>
        <th class="t-dur" ${opts.sortable ? 'data-sort="duration"' : ''}>⏱${sortArrow('duration', opts)}</th>
      </tr></thead>
      <tbody>
        ${tracks.map((t, i) => `
          <tr data-idx="${i}" data-id="${t.id}" class="${t.id === currentId ? 'playing' : ''}">
            <td class="t-num" data-num="${opts.numbers ? (t.trackNo ?? i + 1) : i + 1}">${t.id === currentId
              ? '<span class="eq-bars"><i></i><i></i><i></i></span>'
              : (opts.numbers ? (t.trackNo ?? i + 1) : i + 1)}</td>
            <td class="t-title">${esc(t.title)}</td>
            <td>${esc(t.artist)}</td>
            <td>${esc(t.album)}</td>
            <td class="t-rating">${starMarkup(t.id)}</td>
            ${opts.extraCol ? `<td class="t-dur">${esc(String(opts.extraCol.value(t)))}</td>` : ''}
            <td class="t-fmt"><span class="badge ${qualityBadgeClass(t)}">${esc(shortFmt(t))}</span></td>
            <td class="t-dur">${fmtTime(t.duration)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function sortArrow(key, opts) {
  if (!opts.sortable || state.sortKey !== key) return '';
  return `<span class="sort-arrow">${state.sortDir > 0 ? '▲' : '▼'}</span>`;
}

// ── Ratings ──

function starMarkup(trackId) {
  const r = state.stats.ratings?.[trackId] || 0;
  let html = `<span class="stars" data-id="${trackId}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star ${i <= r ? 'on' : ''}" data-v="${i}">★</span>`;
  }
  return html + '</span>';
}

function setRating(trackId, value) {
  if (!state.stats.ratings) state.stats.ratings = {};
  // clicking the current rating clears it
  const next = state.stats.ratings[trackId] === value ? 0 : value;
  if (next === 0) delete state.stats.ratings[trackId];
  else state.stats.ratings[trackId] = next;
  window.auralis.stats.set(state.stats);
  content.querySelectorAll(`.stars[data-id="${trackId}"]`).forEach((el) => {
    el.querySelectorAll('.star').forEach((s) =>
      s.classList.toggle('on', Number(s.dataset.v) <= (state.stats.ratings[trackId] || 0)));
  });
}

function bindStars(root) {
  root.querySelectorAll('.stars .star').forEach((star) =>
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = star.closest('.stars');
      setRating(wrap.dataset.id, Number(star.dataset.v));
    }));
}

function bindTrackTable(tracks) {
  content.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.stars')) return;
      playTracks(tracks, Number(row.dataset.idx));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTrackMenu(e, tracks, Number(row.dataset.idx));
    });
  });
  bindStars(content);
  content.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      render();
    });
  });
}

// ── All tracks view ──

function sortTracks(tracks) {
  const key = state.sortKey, dir = state.sortDir;
  const val = (t) => {
    switch (key) {
      case 'title': return t.title.toLowerCase();
      case 'artist': return t.artist.toLowerCase();
      case 'album': return t.album.toLowerCase();
      case 'duration': return t.duration || 0;
      case 'rating': return state.stats.ratings?.[t.id] || 0;
      case 'quality': return (t.sampleRate || 0) * ((t.bitsPerSample || 16));
      default: return t.title.toLowerCase();
    }
  };
  return [...tracks].sort((a, b) => {
    const va = val(a), vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

function renderTracksView() {
  if (!state.library.tracks.length) {
    content.innerHTML = emptyLibraryMarkup();
    bindEmptyCta();
    return;
  }
  const tracks = sortTracks(filteredTracks());
  const shown = tracks.slice(0, 2000);
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">Tracks</span>
      <span class="view-sub">${tracks.length.toLocaleString()} tracks${tracks.length > 2000 ? ' · showing first 2,000 — refine with search' : ''}</span>
      <span class="spacer"></span>
      <button class="btn" id="play-all-btn">Play All</button>
    </div>
    ${trackTable(shown, { sortable: true })}`;
  $('#play-all-btn').addEventListener('click', () => playTracks(tracks, 0));
  bindTrackTable(shown);
}

// ── Most Played ──

const MOST_PLAYED_LIMIT = 25;

function renderMostPlayed() {
  const plays = state.stats.plays || {};
  const ranked = state.library.tracks
    .filter((t) => plays[t.id] > 0)
    .sort((a, b) => (plays[b.id] || 0) - (plays[a.id] || 0) ||
                    (state.stats.lastPlayed?.[b.id] || 0) - (state.stats.lastPlayed?.[a.id] || 0))
    .slice(0, MOST_PLAYED_LIMIT);
  if (!ranked.length) {
    content.innerHTML = `
      <div class="view-header">
        <span class="view-title">Most Played</span>
        <span class="view-sub">your top ${MOST_PLAYED_LIMIT}</span>
      </div>
      <div class="empty-state" style="height:60%">
        <div class="glyph">
          <svg viewBox="0 0 24 24" width="38" height="38"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <h2>Nothing here yet</h2>
        <p>Auralis counts a play once you're halfway through a track (or four minutes in).
           Your ${MOST_PLAYED_LIMIT} most-played tracks will gather here automatically.</p>
      </div>`;
    return;
  }
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">Most Played</span>
      <span class="view-sub">your top ${ranked.length}</span>
      <span class="spacer"></span>
      <button class="btn primary" id="mp-play">Play</button>
    </div>
    ${trackTable(ranked, { extraCol: { header: 'Plays', value: (t) => plays[t.id] || 0 } })}`;
  $('#mp-play').addEventListener('click', () => playTracks(ranked, 0));
  bindTrackTable(ranked);
}

// ── Artists ──

async function renderArtists() {
  if (!state.library.tracks.length) {
    content.innerHTML = emptyLibraryMarkup(); bindEmptyCta(); return;
  }
  state.artistCache = await window.auralis.artist.cachedMap().catch(() => state.artistCache);
  const map = new Map();
  for (const t of filteredTracks()) {
    const key = t.albumArtist;
    if (!map.has(key)) map.set(key, { name: key, tracks: [], albums: new Set(), art: null });
    const a = map.get(key);
    a.tracks.push(t);
    a.albums.add(t.albumKey);
    if (!a.art && t.artUrl) a.art = t.artUrl;
  }
  const artists = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">Artists</span>
      <span class="view-sub">${artists.length} artists</span>
    </div>
    ${artists.map((a) => {
      const photo = state.artistCache[a.name.toLowerCase()]?.img || a.art;
      return `
      <div class="artist-row" data-name="${esc(a.name)}">
        <div class="artist-avatar">${photo ? `<img src="${esc(photo)}" loading="lazy" alt=""/>` : esc(a.name.charAt(0).toUpperCase())}</div>
        <div class="meta">
          <div class="name">${esc(a.name)}</div>
          <div class="sub">${a.albums.size} album${a.albums.size !== 1 ? 's' : ''} · ${a.tracks.length} tracks</div>
        </div>
      </div>`;
    }).join('')}`;
  content.querySelectorAll('.artist-row').forEach((row) =>
    row.addEventListener('click', () => go('artist', row.dataset.name)));
}

function renderArtistDetail() {
  const name = state.viewArg;
  const tracks = state.library.tracks.filter((t) => t.albumArtist === name);
  if (!tracks.length) return go('artists');
  const albums = groupAlbums(tracks);
  content.innerHTML = `
    <button class="back-link" id="back-btn">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Artists
    </button>
    <div class="artist-hero" id="artist-hero">
      <div class="artist-portrait" id="artist-portrait">${esc(name.charAt(0).toUpperCase())}</div>
      <div class="artist-hero-meta">
        <div class="hero-kicker">Artist</div>
        <div class="hero-title">${esc(name)}</div>
        <div class="hero-sub">${albums.length} album${albums.length !== 1 ? 's' : ''} · ${tracks.length} tracks · ${fmtLongTime(tracks.reduce((s, t) => s + (t.duration || 0), 0))}</div>
        <div class="artist-bio" id="artist-bio"></div>
        <div class="hero-actions" style="margin-top:14px">
          <button class="btn primary" id="artist-play">
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
            Play All
          </button>
        </div>
      </div>
    </div>
    <div class="album-grid">
      ${albums.map((a) => `
        <div class="album-card" data-key="${esc(a.key)}">
          <div class="album-art">
            ${a.artUrl ? `<img src="${esc(a.artUrl)}" loading="lazy" alt=""/>` : `<div class="art-placeholder"><svg viewBox="0 0 24 24" width="42" height="42"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg></div>`}
            <button class="play-fab" data-play="${esc(a.key)}"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>
          </div>
          <div class="album-title">${esc(a.album)}</div>
          <div class="album-artist">${a.year || ''}</div>
        </div>`).join('')}
    </div>`;
  $('#back-btn').addEventListener('click', () => go('artists'));
  $('#artist-play').addEventListener('click', () => playTracks(tracks, 0));
  content.querySelectorAll('.album-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.play-fab')) return;
      go('album', card.dataset.key);
    });
  });
  content.querySelectorAll('.play-fab').forEach((btn) =>
    btn.addEventListener('click', () => {
      const album = albums.find((a) => a.key === btn.dataset.play);
      if (album) playTracks(album.tracks, 0);
    }));

  loadArtistProfile(name);
}

// Fetch photo + biography (Deezer / Wikipedia) and hydrate the artist hero.
async function loadArtistProfile(name) {
  if (state.settings.onlineArtistInfo === false) return;
  const bioEl = $('#artist-bio');
  if (bioEl) bioEl.innerHTML = '<span class="bio-loading">Looking up artist…</span>';
  let info = null;
  try {
    info = await window.auralis.artist.info(name);
  } catch { /* offline */ }
  // View may have changed while we were fetching
  if (state.view !== 'artist' || state.viewArg !== name) return;
  const portrait = $('#artist-portrait');
  const bio = $('#artist-bio');
  if (!portrait || !bio) return;
  if (info?.img) {
    portrait.innerHTML = `<img src="${esc(info.img)}" alt=""/>`;
    portrait.classList.add('has-photo');
  }
  if (info?.bio) {
    const full = info.bio;
    const short = full.length > 340 ? full.slice(0, 340).replace(/\s+\S*$/, '') + '…' : full;
    bio.innerHTML = `
      <p id="bio-text">${esc(short)}</p>
      ${full.length > short.length ? '<button class="bio-more" id="bio-more">Read more</button>' : ''}
      ${info.url ? `<span class="bio-source">Wikipedia</span>` : ''}`;
    let expanded = false;
    $('#bio-more')?.addEventListener('click', () => {
      expanded = !expanded;
      $('#bio-text').textContent = expanded ? full : short;
      $('#bio-more').textContent = expanded ? 'Show less' : 'Read more';
    });
  } else {
    bio.innerHTML = '';
  }
}

// ── Genres ──

function renderGenres() {
  if (!state.library.tracks.length) {
    content.innerHTML = emptyLibraryMarkup(); bindEmptyCta(); return;
  }
  const map = new Map();
  for (const t of filteredTracks()) {
    const g = t.genre || 'Unknown';
    map.set(g, (map.get(g) || 0) + 1);
  }
  const genres = [...map.entries()].sort((a, b) => b[1] - a[1]);
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">Genres</span>
      <span class="view-sub">${genres.length} genres</span>
    </div>
    <div class="pill-grid">
      ${genres.map(([g, n]) => `
        <button class="pill-item" data-genre="${esc(g)}">${esc(g)}<span class="cnt">${n}</span></button>`).join('')}
    </div>`;
  content.querySelectorAll('.pill-item').forEach((p) =>
    p.addEventListener('click', () => go('genre', p.dataset.genre)));
}

function renderGenreDetail() {
  const genre = state.viewArg;
  const tracks = state.library.tracks.filter((t) => (t.genre || 'Unknown') === genre);
  if (!tracks.length) return go('genres');
  content.innerHTML = `
    <button class="back-link" id="back-btn">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Genres
    </button>
    <div class="view-header">
      <span class="view-title">${esc(genre)}</span>
      <span class="view-sub">${tracks.length} tracks</span>
      <span class="spacer"></span>
      <button class="btn primary" id="genre-play">Play All</button>
    </div>
    ${trackTable(tracks.slice(0, 2000))}`;
  $('#back-btn').addEventListener('click', () => go('genres'));
  $('#genre-play').addEventListener('click', () => playTracks(tracks, 0));
  bindTrackTable(tracks.slice(0, 2000));
}

// ── Playlists ──

function renderSidebarPlaylists() {
  $('#playlist-nav').innerHTML = state.playlists.map((p) => `
    <button class="nav-item ${state.view === 'playlist' && state.viewArg === p.id ? 'active' : ''}" data-pl="${esc(p.id)}">
      ${p.smart
        ? '<svg viewBox="0 0 24 24"><path d="M13 3L5 13.5h5L10 21l8-10.5h-5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h10M4 16h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17 13v7M17 20l3.5-2.2L17 15.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
      <span class="pl-count">${p.smart ? evaluateSmartPlaylist(p).length : p.trackIds.length}</span>
    </button>`).join('');
  $('#playlist-nav').querySelectorAll('[data-pl]').forEach((b) =>
    b.addEventListener('click', () => go('playlist', b.dataset.pl)));
}

function playlistTracks(p) {
  if (p.smart) return evaluateSmartPlaylist(p);
  const byId = new Map(state.library.tracks.map((t) => [t.id, t]));
  return p.trackIds.map((id) => byId.get(id)).filter(Boolean);
}

// ── Smart playlists ──

const SMART_FIELDS = {
  title:    { label: 'Title', type: 'text', get: (t) => t.title },
  artist:   { label: 'Artist', type: 'text', get: (t) => t.artist },
  album:    { label: 'Album', type: 'text', get: (t) => t.album },
  genre:    { label: 'Genre', type: 'text', get: (t) => t.genre || '' },
  year:     { label: 'Year', type: 'number', get: (t) => t.year || 0 },
  rating:   { label: 'Rating', type: 'number', get: (t) => state.stats.ratings?.[t.id] || 0 },
  plays:    { label: 'Play count', type: 'number', get: (t) => state.stats.plays?.[t.id] || 0 },
  lastPlayedDays: { label: 'Days since played', type: 'number',
    get: (t) => state.stats.lastPlayed?.[t.id] ? (Date.now() - state.stats.lastPlayed[t.id]) / 86400000 : Infinity },
  addedDays: { label: 'Days since added', type: 'number',
    get: (t) => t.added ? (Date.now() - t.added) / 86400000 : Infinity },
  sampleRate: { label: 'Sample rate (kHz)', type: 'number', get: (t) => (t.sampleRate || 0) / 1000 },
  duration: { label: 'Length (seconds)', type: 'number', get: (t) => t.duration || 0 },
  lossless: { label: 'Lossless', type: 'bool', get: (t) => !!(t.lossless || t.dsd) },
};

const SMART_OPS = {
  text:   [['contains', 'contains'], ['ncontains', "doesn't contain"], ['is', 'is'], ['isnot', 'is not']],
  number: [['gte', '≥'], ['lte', '≤'], ['is', '=']],
  bool:   [['is', 'is']],
};

function smartConditionMatch(track, cond) {
  const field = SMART_FIELDS[cond.field];
  if (!field) return true;
  const v = field.get(track);
  if (field.type === 'text') {
    const a = String(v).toLowerCase();
    const b = String(cond.value ?? '').toLowerCase();
    switch (cond.op) {
      case 'contains': return a.includes(b);
      case 'ncontains': return !a.includes(b);
      case 'is': return a === b;
      case 'isnot': return a !== b;
      default: return true;
    }
  }
  if (field.type === 'bool') {
    return v === (cond.value === true || cond.value === 'true');
  }
  const n = Number(cond.value) || 0;
  switch (cond.op) {
    case 'gte': return v >= n;
    case 'lte': return v <= n;
    case 'is': return v === n;
    default: return true;
  }
}

function evaluateSmartPlaylist(p) {
  const rules = p.rules || {};
  const conds = (rules.conditions || []).filter((c) => c.field);
  let tracks = state.library.tracks.filter((t) =>
    conds.length === 0 ||
    (rules.match === 'any' ? conds.some((c) => smartConditionMatch(t, c))
                           : conds.every((c) => smartConditionMatch(t, c))));
  const sort = rules.sort || { key: 'artist', dir: 1 };
  const field = SMART_FIELDS[sort.key];
  if (field) {
    tracks = [...tracks].sort((a, b) => {
      const va = field.get(a), vb = field.get(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.dir || 1);
    });
  }
  if (rules.limit > 0) tracks = tracks.slice(0, rules.limit);
  return tracks;
}

function openSmartPlaylistBuilder(existing = null) {
  const root = $('#modal-root');
  const rules = existing?.rules
    ? JSON.parse(JSON.stringify(existing.rules))
    : { match: 'all', conditions: [{ field: 'genre', op: 'contains', value: '' }], sort: { key: 'artist', dir: 1 }, limit: 0 };

  let nameDraft = existing?.name || '';
  const draw = () => {
    root.innerHTML = `
      <div class="modal" style="width:560px">
        <h3>${existing ? 'Edit Smart Playlist' : 'New Smart Playlist'}</h3>
        <input type="text" id="sp-name" placeholder="Playlist name…" value="${esc(nameDraft)}" />
        <div class="sp-rules">
          <div class="sp-match">Match
            <select class="styled" id="sp-match" style="width:90px">
              <option value="all" ${rules.match === 'all' ? 'selected' : ''}>all</option>
              <option value="any" ${rules.match === 'any' ? 'selected' : ''}>any</option>
            </select>
            of the following:
          </div>
          <div id="sp-conds">
            ${rules.conditions.map((c, i) => {
              const type = SMART_FIELDS[c.field]?.type || 'text';
              return `
              <div class="sp-cond" data-i="${i}">
                <select class="styled sp-field">
                  ${Object.entries(SMART_FIELDS).map(([k, f]) => `<option value="${k}" ${c.field === k ? 'selected' : ''}>${f.label}</option>`).join('')}
                </select>
                <select class="styled sp-op">
                  ${SMART_OPS[type].map(([v, l]) => `<option value="${v}" ${c.op === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                ${type === 'bool'
                  ? `<select class="styled sp-val"><option value="true" ${String(c.value) !== 'false' ? 'selected' : ''}>yes</option><option value="false" ${String(c.value) === 'false' ? 'selected' : ''}>no</option></select>`
                  : `<input type="${type === 'number' ? 'number' : 'text'}" class="lf-input sp-val" value="${esc(String(c.value ?? ''))}" />`}
                <button class="corr-band-rm sp-rm" title="Remove">✕</button>
              </div>`;
            }).join('')}
          </div>
          <button class="btn" id="sp-add" style="margin-top:4px">+ condition</button>
          <div class="sp-match" style="margin-top:14px">
            Sort by
            <select class="styled" id="sp-sort" style="width:170px">
              ${Object.entries(SMART_FIELDS).map(([k, f]) => `<option value="${k}" ${rules.sort?.key === k ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
            <select class="styled" id="sp-dir" style="width:120px">
              <option value="1" ${(rules.sort?.dir || 1) === 1 ? 'selected' : ''}>ascending</option>
              <option value="-1" ${rules.sort?.dir === -1 ? 'selected' : ''}>descending</option>
            </select>
            · limit <input type="number" class="lf-input" id="sp-limit" style="width:80px" min="0" value="${rules.limit || 0}" /> (0 = none)
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="sp-cancel">Cancel</button>
          <button class="btn primary" id="sp-save">${existing ? 'Save' : 'Create'}</button>
        </div>
      </div>`;
    root.classList.remove('hidden');

    $('#sp-name').addEventListener('input', (e) => { nameDraft = e.target.value; });

    const syncConds = () => {
      root.querySelectorAll('.sp-cond').forEach((row) => {
        const i = Number(row.dataset.i);
        rules.conditions[i] = {
          field: row.querySelector('.sp-field').value,
          op: row.querySelector('.sp-op').value,
          value: row.querySelector('.sp-val').value,
        };
      });
    };
    root.querySelectorAll('.sp-field').forEach((sel) =>
      sel.addEventListener('change', () => {
        syncConds();
        const i = Number(sel.closest('.sp-cond').dataset.i);
        rules.conditions[i].op = SMART_OPS[SMART_FIELDS[rules.conditions[i].field].type][0][0];
        rules.conditions[i].value = '';
        draw();
      }));
    root.querySelectorAll('.sp-rm').forEach((btn) =>
      btn.addEventListener('click', () => {
        syncConds();
        rules.conditions.splice(Number(btn.closest('.sp-cond').dataset.i), 1);
        if (!rules.conditions.length) rules.conditions.push({ field: 'genre', op: 'contains', value: '' });
        draw();
      }));
    $('#sp-add').addEventListener('click', () => {
      syncConds();
      rules.conditions.push({ field: 'artist', op: 'contains', value: '' });
      draw();
    });
    $('#sp-cancel').addEventListener('click', () => { root.classList.add('hidden'); root.innerHTML = ''; });
    $('#sp-save').addEventListener('click', async () => {
      const name = $('#sp-name').value.trim();
      if (!name) return toast('Give the playlist a name', true);
      syncConds();
      rules.match = $('#sp-match').value;
      rules.sort = { key: $('#sp-sort').value, dir: Number($('#sp-dir').value) };
      rules.limit = Math.max(0, Number($('#sp-limit').value) || 0);
      if (existing) {
        existing.name = name;
        existing.rules = rules;
      } else {
        state.playlists.push({
          id: 'sp_' + Math.random().toString(36).slice(2, 10),
          name, smart: true, trackIds: [], rules,
        });
      }
      await savePlaylists();
      root.classList.add('hidden');
      root.innerHTML = '';
      render();
      toast(`${existing ? 'Updated' : 'Created'} smart playlist “${name}”`);
    });
  };
  draw();
}

function renderPlaylist() {
  const p = state.playlists.find((x) => x.id === state.viewArg);
  if (!p) return go('albums');
  const tracks = playlistTracks(p);
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">${p.smart ? '⚡ ' : ''}${esc(p.name)}</span>
      <span class="view-sub">${tracks.length} tracks · ${fmtLongTime(tracks.reduce((s, t) => s + t.duration, 0))}${p.smart ? ' · auto-updating' : ''}</span>
      <span class="spacer"></span>
      <button class="btn primary" id="pl-play">Play</button>
      ${p.smart ? '<button class="btn" id="pl-edit">Edit Rules</button>' : ''}
      <button class="btn danger" id="pl-delete">Delete</button>
    </div>
    ${tracks.length ? trackTable(tracks) : `<p style="color:var(--text-3)">${p.smart ? 'No tracks match these rules yet.' : 'Right-click any track → “Add to Playlist”.'}</p>`}`;
  $('#pl-play').addEventListener('click', () => tracks.length && playTracks(tracks, 0));
  $('#pl-edit')?.addEventListener('click', () => openSmartPlaylistBuilder(p));
  $('#pl-delete').addEventListener('click', async () => {
    state.playlists = state.playlists.filter((x) => x.id !== p.id);
    await savePlaylists();
    go('albums');
    toast(`Deleted playlist “${p.name}”`);
  });
  content.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.stars')) return;
      playTracks(tracks, Number(row.dataset.idx));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTrackMenu(e, tracks, Number(row.dataset.idx), p.smart ? null : p);
    });
  });
  bindStars(content);
}

async function savePlaylists() {
  await window.auralis.playlists.set({ playlists: state.playlists });
  renderSidebarPlaylists();
}

function promptModal(title, placeholder, onSubmit) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal">
      <h3>${esc(title)}</h3>
      <input type="text" id="modal-input" placeholder="${esc(placeholder)}" />
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn primary" id="modal-ok">Create</button>
      </div>
    </div>`;
  root.classList.remove('hidden');
  const input = $('#modal-input');
  input.focus();
  const close = () => { root.classList.add('hidden'); root.innerHTML = ''; };
  $('#modal-cancel').addEventListener('click', close);
  $('#modal-ok').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') close();
  });
  function submit() {
    const v = input.value.trim();
    if (v) onSubmit(v);
    close();
  }
}

$('#new-smart-btn').addEventListener('click', () => openSmartPlaylistBuilder());

$('#new-playlist-btn').addEventListener('click', () => {
  promptModal('New Playlist', 'Playlist name…', async (name) => {
    state.playlists.push({ id: 'pl_' + Math.random().toString(36).slice(2, 10), name, trackIds: [] });
    await savePlaylists();
    toast(`Created playlist “${name}”`);
  });
});

// ── Settings & DSP ──

async function renderSettings() {
  const devices = await engine.listOutputDevices();
  const s = state.settings;
  content.innerHTML = `
    <div class="view-header"><span class="view-title">Settings &amp; DSP</span></div>
    <div class="settings-grid">

      <div class="settings-card">
        <h3>Music Folders</h3>
        <div class="desc">Folders Auralis scans for audio files. Rescanning re-reads changed files only.</div>
        <div id="folder-list">
          ${state.library.folders.map((f) => `
            <div class="folder-row"><span>${esc(f)}</span><button class="rm" data-folder="${esc(f)}">Remove</button></div>`).join('')
            || '<div class="desc">No folders yet.</div>'}
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn primary" id="settings-add-folder">Add Folder</button>
          <button class="btn" id="settings-rescan">Rescan Library</button>
        </div>
      </div>

      <div class="settings-card">
        <h3>Audio Output</h3>
        <div class="desc">Route playback to a specific DAC or interface. Auralis resamples nothing in software — the Web Audio pipeline runs at the device's shared-mode rate.</div>
        <select class="styled" id="output-device">
          <option value="default">System Default</option>
          ${devices.map((d) => `<option value="${esc(d.deviceId)}" ${s.outputDevice === d.deviceId ? 'selected' : ''}>${esc(d.label || 'Audio Device')}</option>`).join('')}
        </select>
        <div class="setting-row" style="margin-top:8px">
          <div><div class="lbl">Gapless playback</div>
            <div class="hint">Pre-buffers the next track and hands off without silence — essential for live and concept albums.</div></div>
          <button class="toggle ${engine.gapless ? 'on' : ''}" id="toggle-gapless"></button>
        </div>
        <div class="setting-row">
          <div><div class="lbl">Online artist info</div>
            <div class="hint">Fetches artist photos (Deezer) and biographies (Wikipedia) for artist pages. Results are cached locally.</div></div>
          <button class="toggle ${state.settings.onlineArtistInfo !== false ? 'on' : ''}" id="toggle-artistinfo"></button>
        </div>
        <div class="setting-row">
          <div><div class="lbl">ReplayGain</div>
            <div class="hint">Volume-matches tracks using ReplayGain tags in your files.</div></div>
          <select class="styled" style="width:160px" id="rg-mode">
            <option value="off" ${engine.replayGainMode === 'off' ? 'selected' : ''}>Off</option>
            <option value="track" ${engine.replayGainMode === 'track' ? 'selected' : ''}>Track gain</option>
            <option value="album" ${engine.replayGainMode === 'album' ? 'selected' : ''}>Album gain</option>
          </select>
        </div>
      </div>

      <div class="settings-card">
        <h3>Now Playing</h3>
        <div class="setting-row" style="padding-top:0">
          <div><div class="lbl">Display lyrics</div>
            <div class="hint">Shows lyrics beside the artwork on the Now Playing screen — from .lrc/.txt files next to your audio, embedded tags, or LRCLIB lookup (cached). Time-synced lyrics follow the music; click a line to jump there.</div></div>
          <button class="toggle ${state.settings.showLyrics !== false ? 'on' : ''}" id="toggle-lyrics"></button>
        </div>
      </div>

      <div class="settings-card">
        <h3>Last.fm Scrobbling
          <button class="toggle ${state.settings.lastfm?.enabled ? 'on' : ''}" id="toggle-lastfm" style="margin-left:auto"></button>
        </h3>
        <div class="desc">
          Scrobbles follow the standard rule: half the track or four minutes. Auralis uses your own
          (free) Last.fm API account — create one at last.fm/api/account/create, then paste the key
          and shared secret here and connect. Failed scrobbles queue offline and submit later.
        </div>
        <div id="lastfm-status" style="margin-bottom:12px;font-size:12.5px;color:${state.settings.lastfm?.sessionKey ? 'var(--lossless)' : 'var(--text-3)'}">
          ${state.settings.lastfm?.sessionKey
            ? `Connected as ${esc(state.settings.lastfm.username || 'Last.fm user')}`
            : 'Not connected'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <input type="text" class="lf-input" id="lf-key" placeholder="API key" spellcheck="false"
                 value="${esc(state.settings.lastfm?.apiKey || '')}" />
          <input type="text" class="lf-input" id="lf-secret" placeholder="Shared secret" spellcheck="false"
                 value="${esc(state.settings.lastfm?.apiSecret || '')}" />
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn primary" id="lf-connect">${state.settings.lastfm?.sessionKey ? 'Reconnect' : 'Connect to Last.fm'}</button>
          ${state.settings.lastfm?.sessionKey ? '<button class="btn danger" id="lf-disconnect">Disconnect</button>' : ''}
        </div>
      </div>

      <div class="settings-card">
        <h3>Parametric Equalizer
          <button class="toggle ${engine.eqEnabled ? 'on' : ''}" id="toggle-eq" style="margin-left:auto"></button>
        </h3>
        <div class="desc">10-band EQ with shelving ends and auto pre-amp headroom compensation. Applied in the 32-bit float DSP domain.</div>
        <div class="eq-panel">
          <div class="eq-top">
            <select class="styled" style="width:200px" id="eq-preset">
              ${Object.keys(EQ_PRESETS).map((p) => `<option>${p}</option>`).join('')}
              <option>Custom</option>
            </select>
            <button class="btn" id="eq-reset">Reset</button>
          </div>
          <div class="eq-bands">
            ${EQ_FREQUENCIES.map((f, i) => `
              <div class="eq-band">
                <span class="db" id="eq-db-${i}">${engine.eqGains[i] > 0 ? '+' : ''}${engine.eqGains[i]}</span>
                <input type="range" min="-12" max="12" step="0.5" value="${engine.eqGains[i]}" data-band="${i}" />
                <span class="freq">${f >= 1000 ? (f / 1000) + 'k' : f}</span>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3>Output Engine</h3>
        <div class="desc">
          <b>Standard</b> plays through the Chromium/Web Audio pipeline (32-bit float DSP).
          <b>Native Direct Output</b> decodes with the bundled FFmpeg and streams straight to a
          host audio API — <b>ASIO</b> (direct DAC communication, bypasses the Windows mixer),
          <b>WASAPI</b>, or <b>DirectSound</b> — with a 64-bit float DSP chain, or a
          <b>bit-perfect</b> path that bypasses all DSP and software volume entirely.
        </div>
        <div class="setting-row" style="padding-top:0">
          <div><div class="lbl">Engine</div></div>
          <select class="styled" style="width:280px" id="out-engine">
            <option value="standard" ${!state.settings.nativeOutput?.enabled ? 'selected' : ''}>Standard (Web Audio)</option>
            <option value="native" ${state.settings.nativeOutput?.enabled ? 'selected' : ''}>Native Direct Output</option>
          </select>
        </div>
        <div id="native-rows" class="${state.settings.nativeOutput?.enabled ? '' : 'hidden'}">
          <div class="setting-row">
            <div><div class="lbl">Host API</div><div class="hint">ASIO appears when a device driver provides it.</div></div>
            <select class="styled" style="width:280px" id="native-api"><option value="default">System default</option></select>
          </div>
          <div class="setting-row">
            <div><div class="lbl">Device</div></div>
            <select class="styled" style="width:280px" id="native-device"><option value="-1">Default output</option></select>
          </div>
          <div class="setting-row">
            <div><div class="lbl">Bit-perfect mode</div>
              <div class="hint">Source samples go to the driver untouched: no EQ, no ReplayGain, no correction, no software volume. Use your DAC's volume control.</div></div>
            <button class="toggle ${state.settings.nativeOutput?.bitPerfect ? 'on' : ''}" id="toggle-bitperfect"></button>
          </div>
          <div class="setting-row" id="wex-row">
            <div><div class="lbl">WASAPI Exclusive mode</div>
              <div class="hint">Direct exclusive-mode access to the DAC — bypasses the Windows mixer and session volume entirely. Integer output only; falls back to the shared path if the device refuses the format.</div></div>
            <button class="toggle ${state.settings.nativeOutput?.wasapiExclusive ? 'on' : ''}" id="toggle-wex"></button>
          </div>
          <div class="setting-row">
            <div><div class="lbl">Output format</div>
              <div class="hint">Sample format handed to the driver on the DSP path. Integer formats engage the dither stage below.</div></div>
            <select class="styled" style="width:200px" id="native-format">
              ${[['f32', '32-bit float'], ['s32', '32-bit integer'], ['s24', '24-bit integer'], ['s16', '16-bit integer']]
                .map(([v, l]) => `<option value="${v}" ${(state.settings.nativeOutput?.outputFormat || 'f32') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="setting-row">
            <div><div class="lbl">DSD playback</div>
              <div class="hint">DoP wraps the untouched 1-bit DSD stream in PCM frames for DoP-aware DACs (DSF files; needs a 176.4 kHz-capable integer path). PCM conversion plays everywhere.</div></div>
            <select class="styled" style="width:200px" id="native-dsd">
              <option value="pcm" ${(state.settings.nativeOutput?.dsdMode || 'pcm') === 'pcm' ? 'selected' : ''}>Convert to PCM 176.4 kHz</option>
              <option value="dop" ${state.settings.nativeOutput?.dsdMode === 'dop' ? 'selected' : ''}>Native DSD over PCM (DoP)</option>
            </select>
          </div>
          <div class="setting-row">
            <div><div class="lbl">Buffer size</div><div class="hint">Frames per buffer. Smaller = lower latency, larger = safer.</div></div>
            <select class="styled" style="width:160px" id="native-buffer">
              ${[128, 256, 512, 1024, 2048].map((b) => `<option value="${b}" ${(state.settings.nativeOutput?.bufferSize || 512) === b ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </div>
          <div class="hint" id="native-status" style="padding-top:8px"></div>
        </div>
      </div>

      <div class="settings-card">
        <h3>Resampling &amp; Dither</h3>
        <div class="desc">
          Sample-rate conversion runs through the <b>SoX resampler</b> (soxr) inside the native
          engine's decode pipeline — the same engine JRiver and HQPlayer users know. Dither is
          applied once, at the final quantization to integer output: TPDF at ±1 LSB, optionally
          with 2nd-order noise shaping that pushes quantization noise above the audible band.
        </div>
        <div class="setting-row" style="padding-top:0">
          <div><div class="lbl">Sample-rate conversion</div></div>
          <select class="styled" style="width:200px" id="rs-mode">
            <option value="off" ${(state.settings.resample?.mode || 'off') === 'off' ? 'selected' : ''}>Off — source rate</option>
            <option value="rate" ${state.settings.resample?.mode === 'rate' ? 'selected' : ''}>Fixed output rate</option>
          </select>
        </div>
        <div class="setting-row ${(state.settings.resample?.mode || 'off') === 'off' ? 'hidden' : ''}" id="rs-rate-row">
          <div><div class="lbl">Output rate</div></div>
          <select class="styled" style="width:200px" id="rs-rate">
            ${[44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000]
              .map((r) => `<option value="${r}" ${(state.settings.resample?.rate || 96000) === r ? 'selected' : ''}>${(r / 1000).toFixed(1).replace('.0', '')} kHz</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="lbl">SoX precision</div><div class="hint">28-bit is transparent; 33-bit is bit-exact overkill for the paranoid.</div></div>
          <select class="styled" style="width:200px" id="rs-precision">
            ${[[20, 'Quick (20-bit)'], [28, 'High quality (28-bit)'], [33, 'Very high (33-bit)']]
              .map(([v, l]) => `<option value="${v}" ${(state.settings.resample?.precision || 28) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="lbl">Dither</div><div class="hint">Active when the output format is integer. Noise shaping keeps the audible band ~20 dB cleaner.</div></div>
          <select class="styled" style="width:240px" id="rs-dither">
            <option value="off" ${(state.settings.dither || 'off') === 'off' ? 'selected' : ''}>Off (truncate)</option>
            <option value="tpdf" ${state.settings.dither === 'tpdf' ? 'selected' : ''}>TPDF dither</option>
            <option value="ns" ${state.settings.dither === 'ns' ? 'selected' : ''}>TPDF + noise shaping</option>
          </select>
        </div>
      </div>

      <div class="settings-card">
        <h3>Speaker Correction
          <button class="toggle ${state.settings.speakerCorrection?.enabled ? 'on' : ''}" id="toggle-correction" style="margin-left:auto"></button>
        </h3>
        <div class="desc">
          JRiver-style room correction: per-channel level trim, distance delay, polarity, and a
          parametric EQ bank per speaker — plus full <b>FIR convolution</b> from a measured
          impulse response (REW, Acourate, Audiolense exports). Applied in the active engine's
          DSP chain (64-bit float + ffmpeg <code>afir</code> on the native path).
          Disabled automatically in bit-perfect mode.
        </div>
        <div class="setting-row" style="padding-top:0">
          <div><div class="lbl">Impulse response (convolution)</div>
            <div class="hint" id="ir-name">${state.settings.speakerCorrection?.irName
              ? esc(state.settings.speakerCorrection.irName)
              : 'No impulse response loaded.'}</div></div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="ir-load">Load IR…</button>
            ${state.settings.speakerCorrection?.irPath ? '<button class="btn danger" id="ir-clear">Clear</button>' : ''}
          </div>
        </div>
        <div id="correction-editor"></div>
      </div>

      <div class="settings-card">
        <h3>About &amp; Updates</h3>
        <div class="desc" id="about-version">
          Auralis — a lossless-first library and player for people who hear the difference.
        </div>
        <div class="setting-row">
          <div><div class="lbl">Automatic updates</div>
            <div class="hint">Checks GitHub Releases on startup, downloads in the background, and offers a one-click restart. Declined updates install on next quit.</div></div>
          <button class="toggle ${state.settings.autoUpdate !== false ? 'on' : ''}" id="toggle-autoupdate"></button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <button class="btn" id="update-check">Check for updates</button>
          <span id="update-status" style="font-size:12px;color:var(--text-3)"></span>
        </div>
        <div class="desc" style="margin-top:16px;margin-bottom:0">
          Decoding is handled by the Chromium media engine: FLAC, WAV, AIFF, MP3, AAC and OGG/Opus
          play natively. DSD (.dsf/.dff), APE, WavPack and ALAC files are indexed and catalogued
          with full quality metadata; native decode for these formats is on the roadmap.
        </div>
      </div>
    </div>`;

  window.auralis.updates.version().then((v) => {
    const el = $('#about-version');
    if (el) el.innerHTML = `Auralis <b>${esc(v)}</b> — a lossless-first library and player for people who hear the difference.`;
  });

  $('#toggle-autoupdate').addEventListener('click', (e) => {
    const on = state.settings.autoUpdate === false;
    state.settings.autoUpdate = on;
    e.target.classList.toggle('on', on);
    saveSettings();
  });

  $('#update-check').addEventListener('click', async () => {
    const status = $('#update-status');
    status.textContent = 'Checking…';
    const res = await window.auralis.updates.check();
    if (!res.supported) status.textContent = 'Updates apply to the installed app (not dev mode).';
    else if (res.error) status.textContent = 'Check failed: ' + res.error;
    else if (res.available) status.textContent = `Version ${res.version} found — downloading in the background…`;
    else status.textContent = 'You’re up to date.';
  });

  // ── Output engine ──

  const no = () => state.settings.nativeOutput || (state.settings.nativeOutput = {
    enabled: false, api: 'default', deviceId: -1, bitPerfect: false, bufferSize: 512,
  });

  async function populateNativeSelectors() {
    const available = await window.auralis.native.available();
    const statusEl = $('#native-status');
    if (!available) {
      statusEl.textContent = 'Native backend not available on this install.';
      return;
    }
    const apis = await window.auralis.native.apis();
    // a saved API that no longer exists on this machine snaps back to default
    if (no().api !== 'default' && !apis.some((a) => String(a.id) === String(no().api))) {
      no().api = 'default';
      no().deviceId = -1;
      saveSettings();
    }
    const apiSel = $('#native-api');
    apiSel.innerHTML = '<option value="default">System default</option>' +
      apis.map((a) => `<option value="${a.id}" ${String(no().api) === String(a.id) ? 'selected' : ''}>${esc(a.label)}</option>`).join('');
    await populateNativeDevices();
    statusEl.textContent = apis.length
      ? `Available APIs: ${apis.map((a) => a.label).join(' · ')}`
      : 'No output devices found for any host API.';
  }

  async function populateNativeDevices() {
    const apiId = no().api === 'default' ? undefined : Number(no().api);
    const devices = await window.auralis.native.devices(apiId);
    $('#native-device').innerHTML = '<option value="-1">Default output</option>' +
      devices.map((d) => `<option value="${d.id}" ${no().deviceId === d.id ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (default)' : ''}</option>`).join('');
  }

  async function pushNativeOutputConfig() {
    await window.auralis.native.config(nativeConfigPayload());
  }

  if (state.settings.nativeOutput?.enabled) populateNativeSelectors();

  // hide the exclusive toggle when the addon isn't present on this install
  window.auralis.native.capabilities().then((caps) => {
    if (!caps.wasapiExclusive) {
      const row = $('#wex-row');
      if (row) {
        row.querySelector('.hint').textContent =
          'Not available on this install (Windows only; requires the exclusive-mode addon).';
        row.querySelector('.toggle').classList.add('disabled');
      }
    }
  }).catch(() => {});

  $('#out-engine').addEventListener('change', async (e) => {
    const useNative = e.target.value === 'native';
    if (useNative && !(await window.auralis.native.available())) {
      toast('Native output backend is not available on this install', true);
      e.target.value = 'standard';
      return;
    }
    no().enabled = useNative;
    saveSettings();
    $('#native-rows').classList.toggle('hidden', !useNative);
    if (useNative) {
      await populateNativeSelectors();
      await pushNativeOutputConfig();
    }
    await switchEngine(useNative);
    toast(useNative ? 'Native direct output engaged' : 'Standard engine engaged');
  });

  $('#native-api').addEventListener('change', async (e) => {
    no().api = e.target.value;
    no().deviceId = -1;
    saveSettings();
    await populateNativeDevices();
    await pushNativeOutputConfig();
  });

  $('#native-device').addEventListener('change', async (e) => {
    no().deviceId = Number(e.target.value);
    saveSettings();
    await pushNativeOutputConfig();
  });

  $('#toggle-bitperfect').addEventListener('click', async (e) => {
    no().bitPerfect = !no().bitPerfect;
    e.target.classList.toggle('on', no().bitPerfect);
    saveSettings();
    await pushNativeOutputConfig();
    toast(no().bitPerfect
      ? 'Bit-perfect: DSP and software volume bypassed'
      : 'Bit-perfect off — DSP chain active');
  });

  $('#native-buffer').addEventListener('change', async (e) => {
    no().bufferSize = Number(e.target.value);
    saveSettings();
    await pushNativeOutputConfig();
  });

  $('#toggle-wex').addEventListener('click', async (e) => {
    if (e.target.classList.contains('disabled')) return;
    no().wasapiExclusive = !no().wasapiExclusive;
    e.target.classList.toggle('on', no().wasapiExclusive);
    saveSettings();
    await pushNativeOutputConfig();
    toast(no().wasapiExclusive
      ? 'WASAPI Exclusive engaged — device is now Auralis-only'
      : 'WASAPI Exclusive off — shared output path');
  });

  $('#native-format').addEventListener('change', async (e) => {
    no().outputFormat = e.target.value;
    saveSettings();
    await pushNativeOutputConfig();
  });

  $('#native-dsd').addEventListener('change', async (e) => {
    no().dsdMode = e.target.value;
    saveSettings();
    await pushNativeOutputConfig();
  });

  // ── Resampling & dither ──

  const rs = () => state.settings.resample || (state.settings.resample = { mode: 'off', rate: 96000, precision: 28 });

  $('#rs-mode').addEventListener('change', async (e) => {
    rs().mode = e.target.value;
    $('#rs-rate-row').classList.toggle('hidden', rs().mode === 'off');
    saveSettings();
    await pushNativeOutputConfig();
  });
  $('#rs-rate').addEventListener('change', async (e) => {
    rs().rate = Number(e.target.value);
    saveSettings();
    await pushNativeOutputConfig();
  });
  $('#rs-precision').addEventListener('change', async (e) => {
    rs().precision = Number(e.target.value);
    saveSettings();
    await pushNativeOutputConfig();
  });
  $('#rs-dither').addEventListener('change', async (e) => {
    state.settings.dither = e.target.value;
    saveSettings();
    await pushNativeOutputConfig();
  });

  // ── Impulse response ──

  $('#ir-load').addEventListener('click', async () => {
    const ir = await window.auralis.dsp.chooseIr();
    if (!ir) return;
    const sc = correctionSettings();
    sc.irPath = ir.path;
    sc.irUrl = ir.url;
    sc.irName = ir.name;
    if (!sc.enabled) { sc.enabled = true; $('#toggle-correction')?.classList.add('on'); }
    saveSettings();
    applyCorrection();
    await pushNativeOutputConfig();
    toast(`Impulse response loaded: ${ir.name}`);
    render();
  });

  $('#ir-clear')?.addEventListener('click', async () => {
    const sc = correctionSettings();
    sc.irPath = null; sc.irUrl = null; sc.irName = null;
    saveSettings();
    applyCorrection();
    await pushNativeOutputConfig();
    render();
  });

  // ── Speaker correction ──

  $('#toggle-correction').addEventListener('click', (e) => {
    const sc = correctionSettings();
    sc.enabled = !sc.enabled;
    e.target.classList.toggle('on', sc.enabled);
    saveSettings();
    applyCorrection();
    renderCorrectionEditor();
  });

  renderCorrectionEditor();

  $('#settings-add-folder').addEventListener('click', addFolders);
  $('#settings-rescan').addEventListener('click', rescan);
  content.querySelectorAll('.rm[data-folder]').forEach((b) =>
    b.addEventListener('click', async () => {
      const folders = state.library.folders.filter((f) => f !== b.dataset.folder);
      await runScan(folders);
    }));

  $('#output-device').addEventListener('change', async (e) => {
    try {
      await engine.setOutputDevice(e.target.value);
      state.settings.outputDevice = e.target.value;
      saveSettings();
      toast('Output device switched');
    } catch {
      toast('Could not switch output device', true);
    }
  });

  $('#toggle-lyrics').addEventListener('click', (e) => {
    const on = state.settings.showLyrics === false;
    state.settings.showLyrics = on;
    e.target.classList.toggle('on', on);
    saveSettings();
    if (engine.currentTrack && !$('#now-playing').classList.contains('hidden')) {
      refreshLyrics(on ? engine.currentTrack : null);
    }
  });

  $('#toggle-lastfm').addEventListener('click', (e) => {
    state.settings.lastfm = state.settings.lastfm || {};
    state.settings.lastfm.enabled = !state.settings.lastfm.enabled;
    e.target.classList.toggle('on', state.settings.lastfm.enabled);
    saveSettings();
  });

  let lfAwaitingAuth = false;
  $('#lf-connect').addEventListener('click', async () => {
    const apiKey = $('#lf-key').value.trim();
    const apiSecret = $('#lf-secret').value.trim();
    if (!apiKey || !apiSecret) return toast('Enter your Last.fm API key and shared secret first', true);
    state.settings.lastfm = { ...(state.settings.lastfm || {}), apiKey, apiSecret };
    saveSettings();
    try {
      if (!lfAwaitingAuth) {
        await window.auralis.lastfm.startAuth({ apiKey, apiSecret });
        lfAwaitingAuth = true;
        $('#lf-connect').textContent = 'I’ve authorized — finish connecting';
        $('#lastfm-status').textContent = 'Authorize Auralis in the browser window, then click the button again.';
        toast('Approve Auralis in your browser, then finish connecting');
      } else {
        const session = await window.auralis.lastfm.completeAuth({ apiKey, apiSecret });
        lfAwaitingAuth = false;
        state.settings.lastfm = {
          ...state.settings.lastfm,
          sessionKey: session.sessionKey, username: session.username, enabled: true,
        };
        saveSettings();
        toast(`Connected to Last.fm as ${session.username}`);
        render();
      }
    } catch (err) {
      lfAwaitingAuth = false;
      $('#lf-connect').textContent = 'Connect to Last.fm';
      toast('Last.fm: ' + err.message, true);
    }
  });

  $('#lf-disconnect')?.addEventListener('click', () => {
    state.settings.lastfm = {
      ...state.settings.lastfm, sessionKey: null, username: null, enabled: false,
    };
    saveSettings();
    render();
    toast('Disconnected from Last.fm');
  });

  $('#toggle-artistinfo').addEventListener('click', (e) => {
    const on = state.settings.onlineArtistInfo === false;
    state.settings.onlineArtistInfo = on;
    e.target.classList.toggle('on', on);
    saveSettings();
  });

  $('#toggle-gapless').addEventListener('click', (e) => {
    engine.gapless = !engine.gapless;
    e.target.classList.toggle('on', engine.gapless);
    state.settings.gapless = engine.gapless;
    saveSettings();
  });

  $('#rg-mode').addEventListener('change', (e) => {
    engine.setReplayGainMode(e.target.value);
    state.settings.replayGain = e.target.value;
    saveSettings();
  });

  $('#toggle-eq').addEventListener('click', (e) => {
    engine.setEqEnabled(!engine.eqEnabled);
    e.target.classList.toggle('on', engine.eqEnabled);
    state.settings.eqEnabled = engine.eqEnabled;
    saveSettings();
    updateEqButton();
  });

  const applyPresetToUi = () => {
    content.querySelectorAll('.eq-band input').forEach((slider) => {
      const i = Number(slider.dataset.band);
      slider.value = engine.eqGains[i];
      $(`#eq-db-${i}`).textContent = (engine.eqGains[i] > 0 ? '+' : '') + engine.eqGains[i];
    });
  };

  $('#eq-preset').value = state.settings.eqPreset || 'Flat';
  $('#eq-preset').addEventListener('change', (e) => {
    const preset = EQ_PRESETS[e.target.value];
    if (preset) {
      engine.applyEqGains([...preset]);
      applyPresetToUi();
      state.settings.eqPreset = e.target.value;
      state.settings.eqGains = [...engine.eqGains];
      saveSettings();
    }
  });

  $('#eq-reset').addEventListener('click', () => {
    engine.applyEqGains([...EQ_PRESETS.Flat]);
    applyPresetToUi();
    $('#eq-preset').value = 'Flat';
    state.settings.eqPreset = 'Flat';
    state.settings.eqGains = [...engine.eqGains];
    saveSettings();
  });

  content.querySelectorAll('.eq-band input').forEach((slider) => {
    slider.addEventListener('input', () => {
      const i = Number(slider.dataset.band);
      const db = Number(slider.value);
      engine.setEqGain(i, db);
      engine.setEqEnabled(engine.eqEnabled); // refresh headroom
      $(`#eq-db-${i}`).textContent = (db > 0 ? '+' : '') + db;
      $('#eq-preset').value = 'Custom';
      state.settings.eqPreset = 'Custom';
      state.settings.eqGains = [...engine.eqGains];
      saveSettingsDebounced();
    });
  });
}

// ── Speaker correction config ──

function correctionSettings() {
  if (!state.settings.speakerCorrection) {
    state.settings.speakerCorrection = {
      enabled: false,
      channels: [
        { gain: 0, delayMs: 0, invert: false, peq: [] },
        { gain: 0, delayMs: 0, invert: false, peq: [] },
      ],
    };
  }
  return state.settings.speakerCorrection;
}

function correctionConfig() {
  const sc = correctionSettings();
  return {
    enabled: sc.enabled, channels: sc.channels,
    irPath: sc.irPath || null, irUrl: sc.irUrl || null,
  };
}

function nativeConfigPayload() {
  const no = state.settings.nativeOutput || {};
  return {
    api: no.api ?? 'default',
    deviceId: no.deviceId ?? -1,
    bitPerfect: !!no.bitPerfect,
    bufferSize: no.bufferSize || 512,
    outputFormat: no.outputFormat || 'f32',
    dsdMode: no.dsdMode || 'pcm',
    wasapiExclusive: !!no.wasapiExclusive,
    resample: state.settings.resample || { mode: 'off', rate: 96000, precision: 28 },
    dither: state.settings.dither || 'off',
    correction: correctionConfig(),
  };
}

let correctionApplyTimer = null;
function applyCorrection() {
  clearTimeout(correctionApplyTimer);
  correctionApplyTimer = setTimeout(() => {
    engine.setSpeakerCorrection?.(correctionConfig());
    if (engine !== webEngine) webEngine.setSpeakerCorrection(correctionConfig());
  }, 150);
}

function renderCorrectionEditor() {
  const root = $('#correction-editor');
  if (!root) return;
  const sc = correctionSettings();
  if (!sc.enabled) { root.innerHTML = ''; return; }
  const names = ['Left', 'Right'];
  root.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      ${sc.channels.map((ch, i) => `
        <div class="corr-ch" data-ch="${i}">
          <div class="corr-title">${names[i]}
            <button class="corr-invert ${ch.invert ? 'on' : ''}" data-ch="${i}" title="Polarity">Ø</button>
          </div>
          <label class="corr-row">Level <input type="number" class="lf-input corr-in" data-ch="${i}" data-k="gain" min="-24" max="24" step="0.5" value="${ch.gain || 0}" /> dB</label>
          <label class="corr-row">Delay <input type="number" class="lf-input corr-in" data-ch="${i}" data-k="delayMs" min="0" max="100" step="0.01" value="${ch.delayMs || 0}" /> ms</label>
          <div class="corr-peq">
            ${(ch.peq || []).map((b, bi) => `
              <div class="corr-band" data-ch="${i}" data-band="${bi}">
                <input type="number" class="lf-input corr-band-in" data-k="freq" placeholder="Hz" min="10" max="24000" value="${b.freq || ''}" />
                <input type="number" class="lf-input corr-band-in" data-k="gain" placeholder="dB" min="-18" max="18" step="0.5" value="${b.gain || 0}" />
                <input type="number" class="lf-input corr-band-in" data-k="q" placeholder="Q" min="0.1" max="20" step="0.1" value="${b.q || 1}" />
                <button class="corr-band-rm" title="Remove band">✕</button>
              </div>`).join('')}
            <button class="btn corr-add" data-ch="${i}" ${(ch.peq || []).length >= 8 ? 'disabled' : ''}>+ PEQ band</button>
          </div>
        </div>`).join('')}
    </div>`;

  root.querySelectorAll('.corr-invert').forEach((b) =>
    b.addEventListener('click', () => {
      const ch = sc.channels[Number(b.dataset.ch)];
      ch.invert = !ch.invert;
      b.classList.toggle('on', ch.invert);
      saveSettingsDebounced();
      applyCorrection();
    }));

  root.querySelectorAll('.corr-in').forEach((inp) =>
    inp.addEventListener('input', () => {
      sc.channels[Number(inp.dataset.ch)][inp.dataset.k] = Number(inp.value) || 0;
      saveSettingsDebounced();
      applyCorrection();
    }));

  root.querySelectorAll('.corr-band-in').forEach((inp) =>
    inp.addEventListener('input', () => {
      const wrap = inp.closest('.corr-band');
      const band = sc.channels[Number(wrap.dataset.ch)].peq[Number(wrap.dataset.band)];
      band[inp.dataset.k] = Number(inp.value) || 0;
      saveSettingsDebounced();
      applyCorrection();
    }));

  root.querySelectorAll('.corr-band-rm').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.corr-band');
      sc.channels[Number(wrap.dataset.ch)].peq.splice(Number(wrap.dataset.band), 1);
      saveSettingsDebounced();
      applyCorrection();
      renderCorrectionEditor();
    }));

  root.querySelectorAll('.corr-add').forEach((btn) =>
    btn.addEventListener('click', () => {
      const ch = sc.channels[Number(btn.dataset.ch)];
      ch.peq = ch.peq || [];
      ch.peq.push({ freq: 1000, gain: 0, q: 1.4 });
      saveSettingsDebounced();
      applyCorrection();
      renderCorrectionEditor();
    }));
}

let settingsSaveTimer = null;
function saveSettingsDebounced() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveSettings, 400);
}
function saveSettings() {
  window.auralis.settings.set({ ...state.settings, volume: engine.volume });
}

// ── Library scanning ─────────────────────────────────────────────────────

async function addFolders() {
  const picked = await window.auralis.library.chooseFolder();
  if (!picked.length) return;
  const folders = [...new Set([...state.library.folders, ...picked])];
  await runScan(folders);
}

async function rescan() {
  if (!state.library.folders.length) return addFolders();
  await runScan(state.library.folders);
}

let scanStrip = null;
function showScanStrip(text, pct) {
  if (!scanStrip) {
    scanStrip = document.createElement('div');
    scanStrip.id = 'scan-strip';
    document.body.appendChild(scanStrip);
  }
  scanStrip.innerHTML = `<div class="spin"></div><span>${esc(text)}</span>${pct != null ? `<span class="pct">${pct}%</span>` : ''}`;
}
function hideScanStrip() {
  scanStrip?.remove();
  scanStrip = null;
}

async function runScan(folders) {
  showScanStrip('Scanning…');
  try {
    const lib = await window.auralis.library.scan(folders);
    if (lib) {
      state.library = lib;
      toast(`Library updated — ${lib.tracks.length.toLocaleString()} tracks`);
      render();
    }
  } catch (err) {
    toast('Scan failed: ' + err.message, true);
  } finally {
    hideScanStrip();
  }
}

window.auralis.library.onScanProgress((p) => {
  if (p.phase === 'discover') {
    showScanStrip(`Discovering files… ${p.found.toLocaleString()}`);
  } else {
    showScanStrip(`Reading metadata — ${p.file}`, Math.round((p.done / p.total) * 100));
  }
});

// ── Queue & transport ────────────────────────────────────────────────────

function playTracks(tracks, startIdx) {
  state.queue = [...tracks];
  state.queueIndex = startIdx;
  if (state.shuffle) {
    // Keep chosen track first, shuffle the rest
    const chosen = state.queue.splice(startIdx, 1)[0];
    shuffleArray(state.queue);
    state.queue.unshift(chosen);
    state.queueIndex = 0;
  }
  startTrack(state.queue[state.queueIndex]);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function startTrack(track) {
  const ok = await engine.play(track);
  if (ok) onTrackStarted(track);
}

function nextIndex(forEnd = false) {
  if (!state.queue.length) return -1;
  if (state.repeat === 'one' && forEnd) return state.queueIndex;
  const next = state.queueIndex + 1;
  if (next >= state.queue.length) {
    return state.repeat === 'all' ? 0 : -1;
  }
  return next;
}

function enginePeekNext() {
  const idx = nextIndex(true);
  return idx >= 0 ? state.queue[idx] : null;
}

function engineOnTrackEnd() {
  const idx = nextIndex(true);
  if (idx < 0) { updatePlayButton(false); return null; }
  state.queueIndex = idx;
  return state.queue[idx];
}

let lastErrorToast = { msg: '', at: 0 };

function engineOnError(track, msg) {
  // identical errors within a short window collapse into one toast
  const now = Date.now();
  if (msg !== lastErrorToast.msg || now - lastErrorToast.at > 8000) {
    toast(`${track ? `“${track.title}” — ` : ''}${msg}`, true);
  }
  lastErrorToast = { msg, at: now };
  // auto-advance past undecodable file
  const idx = nextIndex();
  if (idx >= 0 && idx !== state.queueIndex) {
    state.queueIndex = idx;
    startTrack(state.queue[idx]);
  }
}

function onTrackStarted(track) {
  playCountedFor = null;
  trackStartedAt = Math.floor(Date.now() / 1000);
  updatePlayButton(true);
  updateMiniUi(track);
  if (!$('#now-playing').classList.contains('hidden')) refreshLyrics(track);
  sendNowPlaying(track);
  $('#pb-title').textContent = track.title;
  $('#pb-artist').textContent = `${track.artist} — ${track.album}`;
  $('#pb-art').style.backgroundImage = track.artUrl ? `url("${track.artUrl}")` : 'none';
  $('#pb-quality').textContent = qualityLabel(track);
  $('#time-total').textContent = fmtTime(track.duration);
  document.title = `${track.title} — ${track.artist} · Auralis`;

  // Now playing overlay
  $('#np-title').textContent = track.title;
  $('#np-artist').textContent = track.artist;
  $('#np-album').textContent = `${track.album}${track.year ? ` · ${track.year}` : ''}`;
  $('#np-art').style.backgroundImage = track.artUrl ? `url("${track.artUrl}")` : 'none';
  $('#np-backdrop').style.backgroundImage = track.artUrl ? `url("${track.artUrl}")` : 'none';
  const badges = [];
  badges.push(`<span class="badge ${qualityBadgeClass(track) || ''}">${esc(qualityLabel(track))}</span>`);
  if (track.channels) badges.push(`<span class="badge">${track.channels === 2 ? 'STEREO' : track.channels + ' CH'}</span>`);
  if (track.bitrate && track.lossless) badges.push(`<span class="badge">${track.bitrate} kbps</span>`);
  if (track.genre) badges.push(`<span class="badge">${esc(track.genre.toUpperCase())}</span>`);
  $('#np-quality').innerHTML = badges.join('');

  // MediaSession (OS media keys / overlay)
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.artUrl ? [{ src: track.artUrl, sizes: '512x512' }] : [],
    });
  }

  renderQueue();
  // refresh playing-row highlight without full rerender
  content.querySelectorAll('tr.playing').forEach((r) => {
    r.classList.remove('playing');
    const num = r.querySelector('.t-num');
    if (num?.dataset.num) num.textContent = num.dataset.num;
  });
  const row = content.querySelector(`tr[data-id="${track.id}"]`);
  if (row) {
    row.classList.add('playing');
    const num = row.querySelector('.t-num');
    if (num) num.innerHTML = '<span class="eq-bars"><i></i><i></i><i></i></span>';
  }
}

function updatePlayButton(playing) {
  $('#icon-play').classList.toggle('hidden', playing);
  $('#icon-pause').classList.toggle('hidden', !playing);
  $('#mini-icon-play').classList.toggle('hidden', playing);
  $('#mini-icon-pause').classList.toggle('hidden', !playing);
  document.body.classList.toggle('paused', !playing);
}

function updateTransportUi() {
  $('#btn-shuffle').classList.toggle('active', state.shuffle);
  $('#btn-repeat').classList.toggle('active', state.repeat !== 'off');
  $('#repeat-one').classList.toggle('hidden', state.repeat !== 'one');
}

function updateEqButton() {
  $('#btn-eq').classList.toggle('active', engine.eqEnabled &&
    engine.eqGains.some((g) => g !== 0));
}

// transport buttons
$('#btn-play').addEventListener('click', async () => {
  if (!engine.currentTrack && state.library.tracks.length) {
    playTracks(sortTracks(state.library.tracks), 0);
    return;
  }
  updatePlayButton(await engine.toggle());
});

$('#btn-next').addEventListener('click', () => {
  const idx = nextIndex();
  if (idx >= 0) { state.queueIndex = idx; startTrack(state.queue[idx]); }
});

$('#btn-prev').addEventListener('click', () => {
  if (engine.currentTime > 3 || state.queueIndex <= 0) {
    engine.seek(0);
    return;
  }
  state.queueIndex -= 1;
  startTrack(state.queue[state.queueIndex]);
});

$('#btn-shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  if (state.shuffle && state.queue.length > 1) {
    const current = state.queue[state.queueIndex];
    const rest = state.queue.filter((_, i) => i !== state.queueIndex);
    shuffleArray(rest);
    state.queue = [current, ...rest];
    state.queueIndex = 0;
    renderQueue();
  }
  updateTransportUi();
});

$('#btn-repeat').addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  updateTransportUi();
});

// media keys
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => engine.toggle().then(updatePlayButton));
  navigator.mediaSession.setActionHandler('pause', () => engine.toggle().then(updatePlayButton));
  navigator.mediaSession.setActionHandler('nexttrack', () => $('#btn-next').click());
  navigator.mediaSession.setActionHandler('previoustrack', () => $('#btn-prev').click());
}

// ── Seek bar ──

const seekBar = $('#seek-bar');
let seeking = false;

// ── Play counting (a play = half the track, or 4 minutes, whichever first) ──
let playCountedFor = null;
let statsSaveTimer = null;
let trackStartedAt = 0;

function countPlayIfEligible(time, duration) {
  const track = engine.currentTrack;
  if (!track || playCountedFor === track.id || !duration) return;
  if (time < Math.min(duration * 0.5, 240)) return;
  playCountedFor = track.id;
  state.stats.plays[track.id] = (state.stats.plays[track.id] || 0) + 1;
  state.stats.lastPlayed[track.id] = Date.now();
  clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(() => window.auralis.stats.set(state.stats), 800);
  sendScrobble(track);
}

// ── Last.fm scrobbling ──

function lastfmCreds() {
  const lf = state.settings.lastfm || {};
  return lf.enabled && lf.apiKey && lf.apiSecret && lf.sessionKey ? lf : null;
}

async function sendNowPlaying(track) {
  const creds = lastfmCreds();
  if (!creds) return;
  window.auralis.lastfm.nowPlaying(creds, {
    artist: track.artist, title: track.title, album: track.album, duration: track.duration,
  }).catch(() => {});
}

async function sendScrobble(track) {
  const creds = lastfmCreds();
  // Last.fm ignores tracks shorter than 30 seconds
  if (!creds || (track.duration && track.duration < 30)) return;
  try {
    const res = await window.auralis.lastfm.scrobble(creds, {
      artist: track.artist, title: track.title, album: track.album,
      duration: track.duration, timestamp: trackStartedAt,
    });
    if (res?.error && res.queued === 1) {
      // first failure — surface once, later failures queue silently
      toast('Last.fm unreachable — scrobble queued', true);
    }
  } catch { /* queued in main */ }
}

function engineOnTimeUpdate(time, duration) {
  countPlayIfEligible(time, duration);
  syncLyrics(time);
  updateMiniProgress(time, duration);
  if (seeking) return;
  const pct = duration ? (time / duration) * 100 : 0;
  $('#seek-fill').style.width = pct + '%';
  $('#seek-thumb').style.left = pct + '%';
  $('#seek-buffer').style.width = (engine.buffered * 100) + '%';
  $('#time-elapsed').textContent = fmtTime(time);
  if (duration) $('#time-total').textContent = fmtTime(duration);
}

attachEngineCallbacks(engine);

function seekFromEvent(e) {
  const rect = seekBar.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return frac;
}

seekBar.addEventListener('pointerdown', (e) => {
  if (!engine.duration) return;
  seeking = true;
  try { seekBar.setPointerCapture(e.pointerId); } catch { /* stale pointer id */ }
  const update = (ev) => {
    const frac = seekFromEvent(ev);
    $('#seek-fill').style.width = frac * 100 + '%';
    $('#seek-thumb').style.left = frac * 100 + '%';
    $('#time-elapsed').textContent = fmtTime(frac * engine.duration);
  };
  update(e);
  const move = (ev) => update(ev);
  const up = (ev) => {
    engine.seek(seekFromEvent(ev) * engine.duration);
    seeking = false;
    seekBar.removeEventListener('pointermove', move);
    seekBar.removeEventListener('pointerup', up);
  };
  seekBar.addEventListener('pointermove', move);
  seekBar.addEventListener('pointerup', up);
});

// ── Volume ──

const volSlider = $('#volume-slider');
volSlider.addEventListener('input', () => {
  const v = Number(volSlider.value) / 100;
  engine.setVolume(v);
  volSlider.style.setProperty('--vol', volSlider.value + '%');
  saveSettingsDebounced();
});

// ── Queue panel ──

$('#btn-queue').addEventListener('click', () => {
  $('#queue-panel').classList.toggle('hidden');
  renderQueue();
});
$('#queue-clear').addEventListener('click', () => {
  state.queue = engine.currentTrack ? [engine.currentTrack] : [];
  state.queueIndex = state.queue.length ? 0 : -1;
  renderQueue();
});

function renderQueue() {
  const panel = $('#queue-panel');
  if (panel.classList.contains('hidden')) return;
  $('#queue-list').innerHTML = state.queue.map((t, i) => `
    <div class="queue-item ${i === state.queueIndex ? 'current' : ''}" data-idx="${i}">
      <div class="qi-art" style="${t.artUrl ? `background-image:url('${t.artUrl}')` : ''}"></div>
      <div class="qi-meta">
        <div class="qi-title">${esc(t.title)}</div>
        <div class="qi-artist">${esc(t.artist)}</div>
      </div>
      <span class="qi-dur">${fmtTime(t.duration)}</span>
    </div>`).join('');
  $('#queue-list').querySelectorAll('.queue-item').forEach((item) =>
    item.addEventListener('dblclick', () => {
      state.queueIndex = Number(item.dataset.idx);
      startTrack(state.queue[state.queueIndex]);
    }));
}

// ── Lyrics ──

const lyricsState = { trackId: null, lines: [], synced: false, activeIdx: -1 };

function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) continue;
    for (const m of stamps) {
      const cs = (m[3] || '0').padEnd(3, '0').slice(0, 3);
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + Number(cs) / 1000, text: content });
    }
  }
  return lines.filter((l) => l.text).sort((a, b) => a.time - b.time);
}

async function refreshLyrics(track) {
  const np = $('#now-playing');
  const scroll = $('#np-lyrics-scroll');
  const sourceEl = $('#np-lyrics-source');
  lyricsState.trackId = track?.id ?? null;
  lyricsState.lines = [];
  lyricsState.activeIdx = -1;

  if (!track || state.settings.showLyrics === false) {
    np.classList.remove('with-lyrics');
    scroll.innerHTML = '';
    sourceEl.textContent = '';
    return;
  }

  // Clear stale lyrics right away; keep the panel open during the lookup so
  // the layout doesn't bounce when consecutive tracks both have lyrics.
  scroll.innerHTML = '';
  sourceEl.textContent = 'Looking for lyrics…';

  let lyr = null;
  try {
    lyr = await window.auralis.lyrics.get({
      id: track.id, path: track.path, artist: track.artist,
      title: track.title, album: track.album, duration: track.duration,
    });
  } catch { /* offline */ }
  // Track may have changed while fetching
  if (lyricsState.trackId !== track.id) return;

  if (!lyr || !lyr.text?.trim()) {
    np.classList.remove('with-lyrics');
    scroll.innerHTML = '';
    sourceEl.textContent = '';
    return;
  }

  lyricsState.synced = !!lyr.synced;
  if (lyr.synced) {
    lyricsState.lines = parseLrc(lyr.text);
  }
  if (lyricsState.synced && lyricsState.lines.length) {
    scroll.innerHTML = lyricsState.lines.map((l, i) =>
      `<div class="lyric-line synced" data-i="${i}">${esc(l.text)}</div>`).join('');
    scroll.querySelectorAll('.lyric-line').forEach((el) =>
      el.addEventListener('click', () => {
        engine.seek(lyricsState.lines[Number(el.dataset.i)].time);
      }));
  } else {
    lyricsState.synced = false;
    scroll.innerHTML = lyr.text.split(/\r?\n/).map((l) =>
      `<div class="lyric-line plain">${esc(l) || '&nbsp;'}</div>`).join('');
  }
  scroll.scrollTop = 0;
  sourceEl.textContent = { file: 'Lyrics · local file', embedded: 'Lyrics · embedded tag', lrclib: 'Lyrics · LRCLIB' }[lyr.source] || 'Lyrics';
  np.classList.add('with-lyrics');
}

function syncLyrics(time) {
  if (!lyricsState.synced || !lyricsState.lines.length) return;
  if ($('#now-playing').classList.contains('hidden')) return;
  let idx = lyricsState.lines.findIndex((l) => l.time > time) - 1;
  if (idx === -2) idx = lyricsState.lines.length - 1; // past the last stamp
  if (idx === lyricsState.activeIdx || idx < 0) return;
  lyricsState.activeIdx = idx;
  const scroll = $('#np-lyrics-scroll');
  scroll.querySelector('.lyric-line.active')?.classList.remove('active');
  const el = scroll.querySelector(`.lyric-line[data-i="${idx}"]`);
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ── Now Playing overlay ──

function toggleNowPlaying(show) {
  const np = $('#now-playing');
  const shouldShow = show ?? np.classList.contains('hidden');
  np.classList.toggle('hidden', !shouldShow);
  if (shouldShow) {
    spectrum.start();
    if (engine.currentTrack && lyricsState.trackId !== engine.currentTrack.id) {
      refreshLyrics(engine.currentTrack);
    }
  } else {
    spectrum.stop();
  }
}
$('#pb-art').addEventListener('click', () => engine.currentTrack && toggleNowPlaying(true));
$('#pb-favorite').addEventListener('click', () => engine.currentTrack && toggleNowPlaying(true));
$('#np-collapse').addEventListener('click', () => toggleNowPlaying(false));

// EQ shortcut button → settings
$('#btn-eq').addEventListener('click', () => { toggleNowPlaying(false); go('settings'); });

// ── Context menu ──

const ctxMenu = $('#context-menu');

function openTrackMenu(e, tracks, idx, playlistCtx = null) {
  const track = tracks[idx];
  const items = [
    { label: '▶ Play', fn: () => playTracks(tracks, idx) },
    { label: 'Play Next', fn: () => {
        if (!state.queue.length) return playTracks([track], 0);
        state.queue.splice(state.queueIndex + 1, 0, track);
        engine.preloadedTrack = null;
        renderQueue();
        toast('Playing next');
      } },
    { label: 'Add to Queue', fn: () => {
        if (!state.queue.length) return playTracks([track], 0);
        state.queue.push(track);
        renderQueue();
        toast('Added to queue');
      } },
    { sep: true },
    { label: 'Add to Playlist…', fn: () => choosePlaylist(track) },
    ...(playlistCtx ? [{ label: 'Remove from Playlist', fn: async () => {
        playlistCtx.trackIds.splice(idx, 1);
        await savePlaylists();
        render();
      } }] : []),
    { sep: true },
    { label: 'Show in File Explorer', fn: () => window.auralis.shell.showItem(track.path) },
  ];
  ctxMenu.innerHTML = items.map((it, i) =>
    it.sep ? '<div class="cm-sep"></div>'
           : `<button class="cm-item" data-i="${i}">${esc(it.label)}</button>`).join('');
  ctxMenu.querySelectorAll('.cm-item').forEach((b) =>
    b.addEventListener('click', () => { items[Number(b.dataset.i)].fn(); closeMenu(); }));
  ctxMenu.classList.remove('hidden');
  const { innerWidth: w, innerHeight: h } = window;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(e.clientX, w - rect.width - 8) + 'px';
  ctxMenu.style.top = Math.min(e.clientY, h - rect.height - 8) + 'px';
}

function closeMenu() { ctxMenu.classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) closeMenu();
});

function choosePlaylist(track) {
  if (!state.playlists.length) {
    promptModal('New Playlist', 'Playlist name…', async (name) => {
      state.playlists.push({
        id: 'pl_' + Math.random().toString(36).slice(2, 10), name, trackIds: [track.id],
      });
      await savePlaylists();
      toast(`Added to “${name}”`);
    });
    return;
  }
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal">
      <h3>Add to Playlist</h3>
      ${state.playlists.map((p) => `<button class="pl-choice" data-id="${esc(p.id)}">${esc(p.name)} <span style="color:var(--text-3)">· ${p.trackIds.length}</span></button>`).join('')}
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn" id="modal-cancel">Cancel</button>
      </div>
    </div>`;
  root.classList.remove('hidden');
  const close = () => { root.classList.add('hidden'); root.innerHTML = ''; };
  $('#modal-cancel').addEventListener('click', close);
  root.querySelectorAll('.pl-choice').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = state.playlists.find((x) => x.id === b.dataset.id);
      if (p && !p.trackIds.includes(track.id)) {
        p.trackIds.push(track.id);
        await savePlaylists();
      }
      toast(`Added to “${p.name}”`);
      close();
    }));
}

// ── Signal path indicator ──

function renderSignalPath() {
  const panel = $('#signal-path');
  const sp = engine.getSignalPath?.();
  if (!sp) {
    panel.innerHTML = '<div class="sp-empty">Nothing playing — start a track to inspect the signal path.</div>';
    return;
  }
  const dot = (q) => `<span class="sp-dot ${q}"></span>`;
  const overallLabel = { bitperfect: 'BIT-PERFECT', lossless: 'LOSSLESS', enhanced: 'ENHANCED', lossy: 'LOSSY SOURCE' }[sp.overall] || '';
  panel.innerHTML = `
    <div class="sp-header">
      ${dot(sp.overall)}
      <span class="sp-overall">${overallLabel}</span>
      <span class="sp-engine">${sp.engine === 'native' ? 'Native engine' : 'Standard engine'}</span>
    </div>
    ${sp.stages.map((st) => `
      <div class="sp-stage">
        ${dot(st.quality)}
        <div class="sp-meta">
          <div class="sp-label">${esc(st.label)}</div>
          <div class="sp-detail">${esc(st.detail || '')}</div>
        </div>
      </div>`).join('')}`;
}

function updateQualityDot() {
  const sp = engine.getSignalPath?.();
  const el = $('#pb-quality');
  el.classList.remove('q-bitperfect', 'q-lossless', 'q-lossy');
  if (sp) el.classList.add(sp.overall === 'bitperfect' ? 'q-bitperfect' : sp.overall === 'lossy' ? 'q-lossy' : 'q-lossless');
}

$('#pb-quality').addEventListener('click', () => {
  const panel = $('#signal-path');
  const show = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) renderSignalPath();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#signal-path') && !e.target.closest('#pb-quality')) {
    $('#signal-path')?.classList.add('hidden');
  }
});

setInterval(() => {
  updateQualityDot();
  if (!$('#signal-path').classList.contains('hidden')) renderSignalPath();
}, 2000);

// ── Auto-update ──

window.auralis.updates.onReady((info) => {
  toast(`Auralis ${info.version} is ready to install`, false, {
    label: 'Restart now',
    fn: () => window.auralis.updates.install(),
  });
});

// ── Search ──

let searchTimer = null;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    if (['albums', 'artists', 'tracks', 'genres'].includes(state.view)) render();
    else go('tracks');
  }, 180);
});

// ── Keyboard shortcuts ──

document.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search-input').focus();
    return;
  }
  if (typing) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      $('#btn-play').click();
      break;
    case 'ArrowRight': if (e.ctrlKey) $('#btn-next').click(); else engine.seek(engine.currentTime + 5); break;
    case 'ArrowLeft': if (e.ctrlKey) $('#btn-prev').click(); else engine.seek(engine.currentTime - 5); break;
    case 'Escape': toggleNowPlaying(false); $('#queue-panel').classList.add('hidden'); break;
  }
});

// ── Mini player ──

function setMini(on) {
  document.body.classList.toggle('mini', on);
  $('#mini-player').classList.toggle('hidden', !on);
  if (on) {
    toggleNowPlaying(false);
    $('#queue-panel').classList.add('hidden');
    updateMiniUi(engine.currentTrack);
  }
  window.auralis.win.mini(on);
}

function updateMiniUi(track) {
  if (!track) return;
  $('#mini-title').textContent = track.title;
  $('#mini-artist').textContent = `${track.artist} — ${track.album}`;
  $('#mini-art').style.backgroundImage = track.artUrl ? `url("${track.artUrl}")` : 'none';
  $('#mini-dur').textContent = fmtTime(track.duration);
}

function updateMiniProgress(time, duration) {
  if (!document.body.classList.contains('mini')) return;
  const d = duration || engine.currentTrack?.duration || 0;
  $('#mini-seek-fill').style.width = (d ? Math.min(100, (time / d) * 100) : 0) + '%';
  $('#mini-time').textContent = fmtTime(time);
  $('#mini-dur').textContent = fmtTime(d);
}

$('#btn-mini').addEventListener('click', () => setMini(true));
$('#mini-restore').addEventListener('click', () => setMini(false));
$('#mini-close').addEventListener('click', () => window.auralis.win.close());
$('#mini-play').addEventListener('click', () => $('#btn-play').click());
$('#mini-prev').addEventListener('click', () => $('#btn-prev').click());
$('#mini-next').addEventListener('click', () => $('#btn-next').click());
$('#mini-seek').addEventListener('pointerdown', (e) => {
  if (!engine.duration) return;
  const rect = $('#mini-seek').getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  engine.seek(frac * engine.duration);
});

// ── Window controls ──

$('#win-min').addEventListener('click', () => window.auralis.win.minimize());
$('#win-max').addEventListener('click', () => window.auralis.win.maximize());
$('#win-close').addEventListener('click', () => window.auralis.win.close());

// ── Navigation ──

$$('.nav-item[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => go(btn.dataset.view)));

// ── Boot ────────────────────────────────────────────────────────────────

(async function boot() {
  const [lib, pls, settings, stats] = await Promise.all([
    window.auralis.library.get(),
    window.auralis.playlists.get(),
    window.auralis.settings.get(),
    window.auralis.stats.get(),
  ]);
  state.library = lib;
  state.playlists = pls.playlists || [];
  state.settings = settings || {};
  state.stats = { plays: {}, lastPlayed: {}, ratings: {}, ...stats };

  // restore settings
  if (settings.volume != null) {
    engine.setVolume(settings.volume);
    volSlider.value = Math.round(settings.volume * 100);
    volSlider.style.setProperty('--vol', volSlider.value + '%');
  }
  if (settings.eqGains) engine.applyEqGains(settings.eqGains);
  if (settings.eqEnabled != null) engine.setEqEnabled(settings.eqEnabled);
  if (settings.gapless != null) engine.gapless = settings.gapless;
  if (settings.replayGain) engine.setReplayGainMode(settings.replayGain);
  if (settings.outputDevice) {
    engine.setOutputDevice(settings.outputDevice).catch(() => {});
  }
  engine.setSpeakerCorrection?.(correctionConfig());
  if (settings.nativeOutput?.enabled) {
    const available = await window.auralis.native.available().catch(() => false);
    if (available) {
      await window.auralis.native.config(nativeConfigPayload());
      await switchEngine(true);
    }
  }
  updateEqButton();
  updateTransportUi();
  render();
})();
