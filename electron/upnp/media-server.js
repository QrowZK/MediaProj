'use strict';

// Auralis DLNA/UPnP-AV media server: streamers browse the library over
// ContentDirectory and pull audio over HTTP with Range support. Pure Node —
// no dependencies.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { SsdpAdvertiser, localIPv4 } = require('./ssdp');
const { escapeXml, xmlValue, soapEnvelope, soapFault } = require('./xml');

const MIME = {
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/x-wav', '.aiff': 'audio/x-aiff',
  '.aif': 'audio/x-aiff', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff', '.alac': 'audio/mp4',
};

function mimeFor(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

function hmmss(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000`;
}

function trackItemXml(t, parent, base) {
  const ext = path.extname(t.path).toLowerCase();
  const mime = mimeFor(t.path);
  const url = `${base}/stream/${encodeURIComponent(t.id)}`;
  const art = t.artUrl ? `<upnp:albumArtURI>${escapeXml(`${base}/art/${encodeURIComponent(t.id)}`)}</upnp:albumArtURI>` : '';
  const dlnaOp = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  return `<item id="t:${escapeXml(t.id)}" parentID="${escapeXml(parent)}" restricted="1">` +
    `<dc:title>${escapeXml(t.title)}</dc:title>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<upnp:artist>${escapeXml(t.artist)}</upnp:artist>` +
    `<dc:creator>${escapeXml(t.artist)}</dc:creator>` +
    `<upnp:album>${escapeXml(t.album)}</upnp:album>` +
    (t.genre ? `<upnp:genre>${escapeXml(t.genre)}</upnp:genre>` : '') +
    (t.trackNo ? `<upnp:originalTrackNumber>${t.trackNo}</upnp:originalTrackNumber>` : '') +
    art +
    `<res protocolInfo="http-get:*:${mime}:${dlnaOp}" duration="${hmmss(t.duration)}"` +
    (t.fileSize ? ` size="${t.fileSize}"` : '') +
    (t.sampleRate ? ` sampleFrequency="${t.sampleRate}"` : '') +
    (t.bitsPerSample ? ` bitsPerSample="${t.bitsPerSample}"` : '') +
    (t.channels ? ` nrAudioChannels="${t.channels}"` : '') +
    `>${escapeXml(url)}</res></item>`;
}

class MediaServer {
  // deps: { getLibrary(), getPlaylists(), evaluateSmart(p, tracks), decodeMediaUrl(url) → path }
  constructor(deps) {
    this.deps = deps;
    this.httpServer = null;
    this.ssdp = null;
    this.config = { enabled: false, name: 'Auralis', port: 47700 };
    this.uuid = null;
    this.updateId = 1;
  }

  bumpUpdateId() { this.updateId = (this.updateId % 2000000000) + 1; }

  status() {
    return {
      running: !!this.httpServer,
      address: this.httpServer ? `http://${localIPv4()}:${this.config.port}` : null,
      name: this.config.name,
      port: this.config.port,
    };
  }

  async start(config, uuid) {
    this.stop();
    this.config = { ...this.config, ...config };
    this.uuid = uuid;
    const port = this.config.port || 47700;

    this.httpServer = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error: ' + err.message);
        } catch { /* socket gone */ }
      });
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, '0.0.0.0', resolve);
    });

    this.ssdp = new SsdpAdvertiser({
      uuid,
      location: `http://${localIPv4()}:${port}/device.xml`,
      serverName: this.config.name,
    });
    this.ssdp.start();
    return this.status();
  }

  stop() {
    if (this.ssdp) { this.ssdp.stop(); this.ssdp = null; }
    if (this.httpServer) {
      try { this.httpServer.close(); } catch { /* fine */ }
      this.httpServer = null;
    }
  }

  _baseUrl(req) {
    const host = req.headers.host || `${localIPv4()}:${this.config.port}`;
    return `http://${host}`;
  }

  async _handle(req, res) {
    const url = new URL(req.url, this._baseUrl(req));
    const p = url.pathname;

    if (p === '/device.xml') return this._deviceXml(req, res);
    if (p === '/cds/scpd.xml') return this._scpd(res, CDS_SCPD);
    if (p === '/cms/scpd.xml') return this._scpd(res, CMS_SCPD);
    if (p === '/cds/control' && req.method === 'POST') return this._soap(req, res, 'cds');
    if (p === '/cms/control' && req.method === 'POST') return this._soap(req, res, 'cms');
    if (p.startsWith('/cds/event') || p.startsWith('/cms/event')) {
      // minimal eventing: accept subscriptions, never notify
      res.writeHead(200, { SID: `uuid:${this.uuid}-sub`, TIMEOUT: 'Second-1800' });
      return res.end();
    }
    if (p.startsWith('/stream/')) return this._stream(req, res, decodeURIComponent(p.slice(8)));
    if (p.startsWith('/art/')) return this._art(req, res, decodeURIComponent(p.slice(5)));

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  _deviceXml(req, res) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${escapeXml(this.config.name)}</friendlyName>
    <manufacturer>Auralis</manufacturer>
    <manufacturerURL>https://github.com/QrowZK/MediaProj</manufacturerURL>
    <modelName>Auralis Media Server</modelName>
    <modelNumber>1.6</modelNumber>
    <UDN>uuid:${this.uuid}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/cds/scpd.xml</SCPDURL>
        <controlURL>/cds/control</controlURL>
        <eventSubURL>/cds/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/cms/scpd.xml</SCPDURL>
        <controlURL>/cms/control</controlURL>
        <eventSubURL>/cms/event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(xml);
  }

  _scpd(res, xml) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(xml);
  }

  async _soap(req, res, service) {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => resolve(data));
    });
    const actionMatch = (req.headers.soapaction || '').match(/#(\w+)"?$/) ||
      body.match(/<u:(\w+)[\s>]/);
    const action = actionMatch ? actionMatch[1] : null;

    const reply = (xml) => {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', EXT: '' });
      res.end(xml);
    };

    if (service === 'cms') {
      const cmsType = 'urn:schemas-upnp-org:service:ConnectionManager:1';
      if (action === 'GetProtocolInfo') {
        const protocols = Object.values(MIME).map((m) => `http-get:*:${m}:*`).join(',');
        return reply(soapEnvelope(cmsType, 'GetProtocolInfoResponse',
          `      <Source>${escapeXml(protocols)}</Source>\n      <Sink></Sink>`));
      }
      if (action === 'GetCurrentConnectionIDs') {
        return reply(soapEnvelope(cmsType, 'GetCurrentConnectionIDsResponse',
          '      <ConnectionIDs>0</ConnectionIDs>'));
      }
      if (action === 'GetCurrentConnectionInfo') {
        return reply(soapEnvelope(cmsType, 'GetCurrentConnectionInfoResponse',
          `      <RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo>
      <PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID>
      <Direction>Output</Direction><Status>OK</Status>`));
      }
      return reply(soapFault(401, 'Invalid Action'));
    }

    const cdsType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    if (action === 'GetSearchCapabilities') {
      return reply(soapEnvelope(cdsType, 'GetSearchCapabilitiesResponse', '      <SearchCaps></SearchCaps>'));
    }
    if (action === 'GetSortCapabilities') {
      return reply(soapEnvelope(cdsType, 'GetSortCapabilitiesResponse', '      <SortCaps></SortCaps>'));
    }
    if (action === 'GetSystemUpdateID') {
      return reply(soapEnvelope(cdsType, 'GetSystemUpdateIDResponse', `      <Id>${this.updateId}</Id>`));
    }
    if (action === 'Browse') {
      const objectId = xmlValue(body, 'ObjectID') ?? '0';
      const flag = xmlValue(body, 'BrowseFlag') || 'BrowseDirectChildren';
      const start = Number(xmlValue(body, 'StartingIndex') || 0);
      const count = Number(xmlValue(body, 'RequestedCount') || 0) || 100000;
      try {
        const { items, total } = this._browse(objectId, flag, this._baseUrl(req));
        const page = items.slice(start, start + count);
        const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${page.join('')}</DIDL-Lite>`;
        return reply(soapEnvelope(cdsType, 'BrowseResponse',
          `      <Result>${escapeXml(didl)}</Result>
      <NumberReturned>${page.length}</NumberReturned>
      <TotalMatches>${total}</TotalMatches>
      <UpdateID>${this.updateId}</UpdateID>`));
      } catch (err) {
        return reply(soapFault(701, 'No such object: ' + err.message));
      }
    }
    return reply(soapFault(401, 'Invalid Action'));
  }

  // ── content tree ──

  _container(id, parent, title, childCount) {
    return `<container id="${escapeXml(id)}" parentID="${escapeXml(parent)}" restricted="1" childCount="${childCount}"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.container</upnp:class></container>`;
  }

  _trackItem(t, parent, base) {
    return trackItemXml(t, parent, base);
  }

  _browse(objectId, flag, base) {
    const tracks = this.deps.getLibrary().tracks;
    const playlists = this.deps.getPlaylists();

    const groups = (key) => {
      const map = new Map();
      for (const t of tracks) {
        const k = key(t);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
      }
      return map;
    };
    const albums = () => {
      const map = new Map();
      for (const t of tracks) {
        if (!map.has(t.albumKey)) map.set(t.albumKey, { album: t.album, artist: t.albumArtist, tracks: [] });
        map.get(t.albumKey).tracks.push(t);
      }
      return map;
    };
    const sortAlbumTracks = (list) => [...list].sort((a, b) =>
      (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0));

    if (flag === 'BrowseMetadata') {
      // Only the root needs real metadata for interop
      if (objectId === '0') {
        return { items: [this._container('0', '-1', this.config.name, 5)], total: 1 };
      }
      return { items: [this._container(objectId, '0', objectId, 0)], total: 1 };
    }

    if (objectId === '0') {
      const items = [
        this._container('albums', '0', 'Albums', albums().size),
        this._container('artists', '0', 'Artists', groups((t) => t.albumArtist).size),
        this._container('genres', '0', 'Genres', groups((t) => t.genre || 'Unknown').size),
        this._container('tracks', '0', 'All Tracks', tracks.length),
        this._container('playlists', '0', 'Playlists', playlists.length),
      ];
      return { items, total: items.length };
    }
    if (objectId === 'albums') {
      const items = [...albums().entries()]
        .sort((a, b) => a[1].artist.localeCompare(b[1].artist) || a[1].album.localeCompare(b[1].album))
        .map(([key, a]) => this._container(`album:${key}`, 'albums', `${a.album} — ${a.artist}`, a.tracks.length));
      return { items, total: items.length };
    }
    if (objectId.startsWith('album:')) {
      const key = objectId.slice(6);
      const a = albums().get(key);
      if (!a) throw new Error(objectId);
      const items = sortAlbumTracks(a.tracks).map((t) => this._trackItem(t, objectId, base));
      return { items, total: items.length };
    }
    if (objectId === 'artists') {
      const items = [...groups((t) => t.albumArtist).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, list]) => this._container(`artist:${name}`, 'artists', name, list.length));
      return { items, total: items.length };
    }
    if (objectId.startsWith('artist:')) {
      const name = objectId.slice(7);
      const list = tracks.filter((t) => t.albumArtist === name);
      if (!list.length) throw new Error(objectId);
      const items = sortAlbumTracks(list).map((t) => this._trackItem(t, objectId, base));
      return { items, total: items.length };
    }
    if (objectId === 'genres') {
      const items = [...groups((t) => t.genre || 'Unknown').entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([g, list]) => this._container(`genre:${g}`, 'genres', g, list.length));
      return { items, total: items.length };
    }
    if (objectId.startsWith('genre:')) {
      const g = objectId.slice(6);
      const list = tracks.filter((t) => (t.genre || 'Unknown') === g);
      if (!list.length) throw new Error(objectId);
      const items = list.map((t) => this._trackItem(t, objectId, base));
      return { items, total: items.length };
    }
    if (objectId === 'tracks') {
      const items = [...tracks]
        .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
        .map((t) => this._trackItem(t, 'tracks', base));
      return { items, total: items.length };
    }
    if (objectId === 'playlists') {
      const items = playlists.map((p) => {
        const list = this.deps.evaluatePlaylist(p);
        return this._container(`playlist:${p.id}`, 'playlists', p.name, list.length);
      });
      return { items, total: items.length };
    }
    if (objectId.startsWith('playlist:')) {
      const id = objectId.slice(9);
      const p = playlists.find((x) => x.id === id);
      if (!p) throw new Error(objectId);
      const items = this.deps.evaluatePlaylist(p).map((t) => this._trackItem(t, objectId, base));
      return { items, total: items.length };
    }
    throw new Error(objectId);
  }

  // ── streaming ──

  async _stream(req, res, trackId) {
    const track = this.deps.getLibrary().tracks.find((t) => t.id === trackId);
    if (!track) { res.writeHead(404); return res.end(); }
    let stat;
    try { stat = await fsp.stat(track.path); } catch { res.writeHead(404); return res.end(); }

    const mime = mimeFor(track.path);
    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': `DLNA.ORG_OP=01;DLNA.ORG_CI=0`,
    };

    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      const start = range[1] ? parseInt(range[1], 10) : Math.max(0, stat.size - parseInt(range[2], 10));
      const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(track.path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(track.path).pipe(res);
    }
  }

  async _art(req, res, trackId) {
    const track = this.deps.getLibrary().tracks.find((t) => t.id === trackId);
    const artPath = track?.artUrl ? this.deps.decodeMediaUrl(track.artUrl) : null;
    if (!artPath) { res.writeHead(404); return res.end(); }
    try {
      const data = await fsp.readFile(artPath);
      res.writeHead(200, {
        'Content-Type': artPath.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404); res.end();
    }
  }
}

// Minimal-but-valid SCPDs (action/argument declarations)
const CDS_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>Browse</name></action>
    <action><name>GetSearchCapabilities</name></action>
    <action><name>GetSortCapabilities</name></action>
    <action><name>GetSystemUpdateID</name></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const CMS_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name></action>
    <action><name>GetCurrentConnectionIDs</name></action>
    <action><name>GetCurrentConnectionInfo</name></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

module.exports = { MediaServer, trackItemXml };
