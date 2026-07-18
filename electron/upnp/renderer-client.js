'use strict';

// UPnP AV / OpenHome control point: drives a network renderer (WiiM, Lumin,
// Cambridge, Linn, Volumio…) as an Auralis output zone. The renderer pulls
// audio from the Auralis media server over HTTP.

const http = require('http');
const { URL } = require('url');
const { searchRenderers } = require('./ssdp');
const { escapeXml, unescapeXml, xmlValue } = require('./xml');

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const OH_PLAYLIST = 'urn:av-openhome-org:service:Playlist:1';
const OH_TIME = 'urn:av-openhome-org:service:Time:1';
const OH_VOLUME = 'urn:av-openhome-org:service:Volume:1';

function httpFetch(urlStr, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request({
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname + url.search, method, headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function soapCall(controlUrl, serviceType, action, args = {}) {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${typeof v === 'string' ? v : escapeXml(String(v))}</${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  const res = await httpFetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`,
      'Content-Length': Buffer.byteLength(envelope),
    },
    body: envelope,
  });
  if (res.status !== 200) {
    const desc = xmlValue(res.body, 'errorDescription') || `HTTP ${res.status}`;
    throw new Error(`${action}: ${desc}`);
  }
  return res.body;
}

// escape an argument value that is itself XML (DIDL metadata)
function xmlArg(didl) { return escapeXml(didl); }

function hmsToSeconds(hms) {
  if (!hms) return 0;
  const parts = hms.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function secondsToHms(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── device description ──────────────────────────────────────────────────

async function describeRenderer(location) {
  const res = await httpFetch(location);
  if (res.status !== 200) throw new Error('device description HTTP ' + res.status);
  const xml = res.body;
  const base = new URL(location);
  const abs = (p) => p ? new URL(p, `${base.protocol}//${base.host}`).toString() : null;

  const services = {};
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const s = m[1];
    const type = xmlValue(s, 'serviceType');
    const control = xmlValue(s, 'controlURL');
    if (type && control) services[type.replace(/:\d+$/, '')] = {
      type, controlUrl: abs(control),
    };
  }
  const svc = (t) => services[t.replace(/:\d+$/, '')] || null;
  return {
    location,
    name: xmlValue(xml, 'friendlyName') || 'Renderer',
    model: xmlValue(xml, 'modelName') || '',
    udn: xmlValue(xml, 'UDN') || location,
    avTransport: svc(AVT),
    renderingControl: svc(RCS),
    ohPlaylist: svc(OH_PLAYLIST),
    ohTime: svc(OH_TIME),
    ohVolume: svc(OH_VOLUME),
  };
}

async function discoverRenderers(timeoutMs = 3200) {
  const found = await searchRenderers(timeoutMs);
  const out = [];
  const seen = new Set();
  for (const f of found) {
    try {
      const d = await describeRenderer(f.location);
      if (seen.has(d.udn)) continue;
      seen.add(d.udn);
      if (!d.avTransport && !d.ohPlaylist) continue; // not driveable
      out.push({
        id: d.location, name: d.name, model: d.model,
        openhome: !!d.ohPlaylist, upnpAv: !!d.avTransport,
      });
    } catch { /* unreachable device */ }
  }
  return out;
}

// ── renderer engine ─────────────────────────────────────────────────────

class RendererEngine {
  constructor(emit) {
    this.emit = emit;
    this.device = null;      // describeRenderer result
    this.currentTrack = null;
    this.nextTrack = null;
    this.nextUri = null;
    this.playing = false;
    this.pollTimer = null;
    this.lastPos = 0;
    this.buildTrackUrl = null; // (track) → { uri, didl } injected by main
    this.volume = 80;
  }

  async select(location) {
    this.stopAll();
    this.device = location ? await describeRenderer(location) : null;
    return this.device ? { name: this.device.name, openhome: !!this.device.ohPlaylist } : null;
  }

  get mode() {
    if (!this.device) return null;
    // Prefer UPnP AV (widest interop); OpenHome Playlist when that's all there is
    return this.device.avTransport ? 'avtransport' : 'openhome';
  }

  async play(track, startAt = 0) {
    if (!this.device) throw new Error('No renderer selected');
    const { uri, didl } = this.buildTrackUrl(track);
    this.currentTrack = track;
    this.nextUri = null;
    if (this.mode === 'avtransport') {
      const ctl = this.device.avTransport.controlUrl;
      await soapCall(ctl, AVT, 'SetAVTransportURI', {
        InstanceID: 0, CurrentURI: escapeXml(uri), CurrentURIMetaData: xmlArg(didl),
      });
      await soapCall(ctl, AVT, 'Play', { InstanceID: 0, Speed: 1 });
      if (startAt > 1) {
        await soapCall(ctl, AVT, 'Seek', {
          InstanceID: 0, Unit: 'REL_TIME', Target: secondsToHms(startAt),
        }).catch(() => { /* some renderers refuse early seeks */ });
      }
    } else {
      const ctl = this.device.ohPlaylist.controlUrl;
      await soapCall(ctl, OH_PLAYLIST, 'DeleteAll', {});
      const res = await soapCall(ctl, OH_PLAYLIST, 'Insert', {
        AfterId: 0, Uri: escapeXml(uri), Metadata: xmlArg(didl),
      });
      const newId = Number(xmlValue(res, 'NewId') || 0);
      await soapCall(ctl, OH_PLAYLIST, 'SeekId', { Value: newId });
      await soapCall(ctl, OH_PLAYLIST, 'Play', {});
      if (startAt > 1) {
        await soapCall(ctl, OH_PLAYLIST, 'SeekSecondAbsolute', { Value: Math.round(startAt) })
          .catch(() => { /* fine */ });
      }
    }
    this.playing = true;
    this._startPoll();
    this.emit('upnp:state', { playing: true });
    return true;
  }

  async setNext(track) {
    this.nextTrack = track;
    if (!this.device || !track) return;
    if (this.mode === 'avtransport') {
      const { uri, didl } = this.buildTrackUrl(track);
      this.nextUri = uri;
      await soapCall(this.device.avTransport.controlUrl, AVT, 'SetNextAVTransportURI', {
        InstanceID: 0, NextURI: escapeXml(uri), NextURIMetaData: xmlArg(didl),
      }).catch(() => { this.nextUri = null; /* renderer without gapless */ });
    } else {
      const { uri, didl } = this.buildTrackUrl(track);
      this.nextUri = uri;
      await soapCall(this.device.ohPlaylist.controlUrl, OH_PLAYLIST, 'Insert', {
        AfterId: 0, Uri: escapeXml(uri), Metadata: xmlArg(didl),
      }).catch(() => { this.nextUri = null; });
    }
  }

  async pause() {
    if (!this.device) return false;
    const call = this.mode === 'avtransport'
      ? soapCall(this.device.avTransport.controlUrl, AVT, 'Pause', { InstanceID: 0 })
      : soapCall(this.device.ohPlaylist.controlUrl, OH_PLAYLIST, 'Pause', {});
    await call.catch(() => {});
    this.playing = false;
    this.emit('upnp:state', { playing: false });
    return true;
  }

  async resume() {
    if (!this.device) return false;
    const call = this.mode === 'avtransport'
      ? soapCall(this.device.avTransport.controlUrl, AVT, 'Play', { InstanceID: 0, Speed: 1 })
      : soapCall(this.device.ohPlaylist.controlUrl, OH_PLAYLIST, 'Play', {});
    await call.catch(() => {});
    this.playing = true;
    this.emit('upnp:state', { playing: true });
    return true;
  }

  async seek(seconds) {
    if (!this.device) return;
    this.lastPos = Math.round(seconds); // keep the poll's wrap detection honest
    if (this.mode === 'avtransport') {
      await soapCall(this.device.avTransport.controlUrl, AVT, 'Seek', {
        InstanceID: 0, Unit: 'REL_TIME', Target: secondsToHms(seconds),
      }).catch(() => {});
    } else {
      await soapCall(this.device.ohPlaylist.controlUrl, OH_PLAYLIST, 'SeekSecondAbsolute', {
        Value: Math.round(seconds),
      }).catch(() => {});
    }
  }

  async setVolume(v100) {
    this.volume = v100;
    if (!this.device) return;
    if (this.device.renderingControl) {
      await soapCall(this.device.renderingControl.controlUrl, RCS, 'SetVolume', {
        InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(v100),
      }).catch(() => {});
    } else if (this.device.ohVolume) {
      await soapCall(this.device.ohVolume.controlUrl, OH_VOLUME, 'SetVolume', {
        Value: Math.round(v100),
      }).catch(() => {});
    }
  }

  _startPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._poll().catch(() => {}), 1000);
  }

  async _poll() {
    if (!this.device || !this.currentTrack) return;
    if (this.mode === 'avtransport') {
      const ctl = this.device.avTransport.controlUrl;
      const pos = await soapCall(ctl, AVT, 'GetPositionInfo', { InstanceID: 0 });
      const rel = hmsToSeconds(xmlValue(pos, 'RelTime'));
      const trackUri = unescapeXml(xmlValue(pos, 'TrackURI') || '');
      const info = await soapCall(ctl, AVT, 'GetTransportInfo', { InstanceID: 0 });
      const stateVal = xmlValue(info, 'CurrentTransportState') || '';

      // gapless handoff detection: renderer moved to the queued next URI
      if (this.nextUri && trackUri && trackUri === this.nextUri) {
        const next = this.nextTrack;
        this.currentTrack = next;
        this.nextTrack = null;
        this.nextUri = null;
        this.emit('upnp:track-ended', { advancedTo: next?.id || null });
        this.emit('upnp:track-changed', { trackId: next?.id || null });
      } else if (stateVal === 'STOPPED' && this.playing && rel === 0 && this.lastPos > 1) {
        // natural end without a queued next
        this.playing = false;
        clearInterval(this.pollTimer);
        this.emit('upnp:track-ended', { advancedTo: null });
        this.emit('upnp:state', { playing: false });
        return;
      }
      this.lastPos = rel;
      this.emit('upnp:progress', { time: rel, duration: this.currentTrack?.duration || 0 });
    } else {
      const time = await soapCall(this.device.ohTime.controlUrl, OH_TIME, 'Time', {});
      const seconds = Number(xmlValue(time, 'Seconds') || 0);
      const dur = this.currentTrack?.duration || Number(xmlValue(time, 'Duration') || 0);
      if (this.playing && this.lastPos > 1 && seconds < 2 && seconds < this.lastPos - 2) {
        if (this.nextUri) {
          // playlist advanced to the queued next entry (position wrapped to 0)
          const next = this.nextTrack;
          this.currentTrack = next;
          this.nextTrack = null;
          this.nextUri = null;
          this.emit('upnp:track-ended', { advancedTo: next?.id || null });
          this.emit('upnp:track-changed', { trackId: next?.id || null });
        } else {
          this.playing = false;
          clearInterval(this.pollTimer);
          this.emit('upnp:track-ended', { advancedTo: null });
          this.emit('upnp:state', { playing: false });
          return;
        }
      }
      this.lastPos = seconds;
      this.emit('upnp:progress', { time: seconds, duration: dur });
    }
  }

  stopAll() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.device) {
      if (this.mode === 'avtransport') {
        soapCall(this.device.avTransport.controlUrl, AVT, 'Stop', { InstanceID: 0 }).catch(() => {});
      } else if (this.device.ohPlaylist) {
        soapCall(this.device.ohPlaylist.controlUrl, OH_PLAYLIST, 'Stop', {}).catch(() => {});
      }
    }
    this.playing = false;
    this.currentTrack = null;
    this.nextTrack = null;
    this.nextUri = null;
    this.lastPos = 0;
  }
}

module.exports = { RendererEngine, discoverRenderers, describeRenderer, soapCall };
