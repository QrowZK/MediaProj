// ═══════════════════════════════════════════════════════════════════════
// Auralis — application shell
// ═══════════════════════════════════════════════════════════════════════

import { AudioEngine, EQ_FREQUENCIES, EQ_PRESETS } from './player.js';
import { SpectrumVisualizer, VuMeter } from './visualizer.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── State ────────────────────────────────────────────────────────────────

const state = {
  library: { folders: [], tracks: [] },
  playlists: [],
  settings: {},
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

const engine = new AudioEngine();
const spectrum = new SpectrumVisualizer($('#np-spectrum'), engine);
const vu = new VuMeter($('#vu-meter'), engine);
vu.start();

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

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 3400);
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
        <th class="t-fmt" ${opts.sortable ? 'data-sort="quality"' : ''}>Quality${sortArrow('quality', opts)}</th>
        <th class="t-dur" ${opts.sortable ? 'data-sort="duration"' : ''}>⏱${sortArrow('duration', opts)}</th>
      </tr></thead>
      <tbody>
        ${tracks.map((t, i) => `
          <tr data-idx="${i}" data-id="${t.id}" class="${t.id === currentId ? 'playing' : ''}">
            <td class="t-num">${t.id === currentId
              ? '<span class="eq-bars"><i></i><i></i><i></i></span>'
              : (opts.numbers ? (t.trackNo ?? i + 1) : i + 1)}</td>
            <td class="t-title">${esc(t.title)}</td>
            <td>${esc(t.artist)}</td>
            <td>${esc(t.album)}</td>
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

function bindTrackTable(tracks) {
  content.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('dblclick', () => playTracks(tracks, Number(row.dataset.idx)));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTrackMenu(e, tracks, Number(row.dataset.idx));
    });
  });
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

// ── Artists ──

function renderArtists() {
  if (!state.library.tracks.length) {
    content.innerHTML = emptyLibraryMarkup(); bindEmptyCta(); return;
  }
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
    ${artists.map((a) => `
      <div class="artist-row" data-name="${esc(a.name)}">
        <div class="artist-avatar">${a.art ? `<img src="${esc(a.art)}" loading="lazy" alt=""/>` : esc(a.name.charAt(0).toUpperCase())}</div>
        <div class="meta">
          <div class="name">${esc(a.name)}</div>
          <div class="sub">${a.albums.size} album${a.albums.size !== 1 ? 's' : ''} · ${a.tracks.length} tracks</div>
        </div>
      </div>`).join('')}`;
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
    <div class="view-header">
      <span class="view-title">${esc(name)}</span>
      <span class="view-sub">${albums.length} albums · ${tracks.length} tracks</span>
      <span class="spacer"></span>
      <button class="btn primary" id="artist-play">Play All</button>
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
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h10M4 16h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17 13v7M17 20l3.5-2.2L17 15.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
      <span class="pl-count">${p.trackIds.length}</span>
    </button>`).join('');
  $('#playlist-nav').querySelectorAll('[data-pl]').forEach((b) =>
    b.addEventListener('click', () => go('playlist', b.dataset.pl)));
}

function playlistTracks(p) {
  const byId = new Map(state.library.tracks.map((t) => [t.id, t]));
  return p.trackIds.map((id) => byId.get(id)).filter(Boolean);
}

function renderPlaylist() {
  const p = state.playlists.find((x) => x.id === state.viewArg);
  if (!p) return go('albums');
  const tracks = playlistTracks(p);
  content.innerHTML = `
    <div class="view-header">
      <span class="view-title">${esc(p.name)}</span>
      <span class="view-sub">${tracks.length} tracks · ${fmtLongTime(tracks.reduce((s, t) => s + t.duration, 0))}</span>
      <span class="spacer"></span>
      <button class="btn primary" id="pl-play">Play</button>
      <button class="btn danger" id="pl-delete">Delete</button>
    </div>
    ${tracks.length ? trackTable(tracks) : '<p style="color:var(--text-3)">Right-click any track → “Add to Playlist”.</p>'}`;
  $('#pl-play').addEventListener('click', () => tracks.length && playTracks(tracks, 0));
  $('#pl-delete').addEventListener('click', async () => {
    state.playlists = state.playlists.filter((x) => x.id !== p.id);
    await savePlaylists();
    go('albums');
    toast(`Deleted playlist “${p.name}”`);
  });
  content.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('dblclick', () => playTracks(tracks, Number(row.dataset.idx)));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTrackMenu(e, tracks, Number(row.dataset.idx), p);
    });
  });
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
        <h3>About</h3>
        <div class="desc">
          Auralis 1.0 — a lossless-first library and player for people who hear the difference.<br><br>
          Decoding is handled by the Chromium media engine: FLAC, WAV, AIFF, ALAC-in-MP4 is not supported,
          MP3, AAC, OGG/Opus play natively. DSD (.dsf/.dff), APE and WavPack files are indexed and
          catalogued with full quality metadata; native decode for these formats is on the roadmap.
        </div>
      </div>
    </div>`;

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

engine.peekNext = () => {
  const idx = nextIndex(true);
  return idx >= 0 ? state.queue[idx] : null;
};

engine.onTrackEnd = () => {
  const idx = nextIndex(true);
  if (idx < 0) { updatePlayButton(false); return null; }
  state.queueIndex = idx;
  return state.queue[idx];
};

engine.onTrackStarted = (track) => onTrackStarted(track);

engine.onError = (track, msg) => {
  toast(`${track ? `“${track.title}” — ` : ''}${msg}`, true);
  // auto-advance past undecodable file
  const idx = nextIndex();
  if (idx >= 0 && idx !== state.queueIndex) {
    state.queueIndex = idx;
    startTrack(state.queue[idx]);
  }
};

function onTrackStarted(track) {
  updatePlayButton(true);
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
  content.querySelectorAll('tr.playing').forEach((r) => r.classList.remove('playing'));
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

engine.onTimeUpdate = (time, duration) => {
  if (seeking) return;
  const pct = duration ? (time / duration) * 100 : 0;
  $('#seek-fill').style.width = pct + '%';
  $('#seek-thumb').style.left = pct + '%';
  $('#seek-buffer').style.width = (engine.buffered * 100) + '%';
  $('#time-elapsed').textContent = fmtTime(time);
  if (duration) $('#time-total').textContent = fmtTime(duration);
};

function seekFromEvent(e) {
  const rect = seekBar.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return frac;
}

seekBar.addEventListener('pointerdown', (e) => {
  if (!engine.duration) return;
  seeking = true;
  seekBar.setPointerCapture(e.pointerId);
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

// ── Now Playing overlay ──

function toggleNowPlaying(show) {
  const np = $('#now-playing');
  const shouldShow = show ?? np.classList.contains('hidden');
  np.classList.toggle('hidden', !shouldShow);
  if (shouldShow) spectrum.start();
  else spectrum.stop();
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

// ── Window controls ──

$('#win-min').addEventListener('click', () => window.auralis.win.minimize());
$('#win-max').addEventListener('click', () => window.auralis.win.maximize());
$('#win-close').addEventListener('click', () => window.auralis.win.close());

// ── Navigation ──

$$('.nav-item[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => go(btn.dataset.view)));

// ── Boot ────────────────────────────────────────────────────────────────

(async function boot() {
  const [lib, pls, settings] = await Promise.all([
    window.auralis.library.get(),
    window.auralis.playlists.get(),
    window.auralis.settings.get(),
  ]);
  state.library = lib;
  state.playlists = pls.playlists || [];
  state.settings = settings || {};

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
  updateEqButton();
  updateTransportUi();
  render();
})();
