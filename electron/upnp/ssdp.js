'use strict';

// SSDP: multicast discovery for UPnP. One module covers both roles —
// advertising the Auralis media server, and searching for renderers.

const dgram = require('dgram');
const os = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function localIPv4() {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

// ── advertiser (media server role) ──────────────────────────────────────

class SsdpAdvertiser {
  constructor({ uuid, location, serverName }) {
    this.uuid = uuid;
    this.location = location; // http://ip:port/device.xml
    this.serverName = serverName || 'Auralis';
    this.socket = null;
    this.notifyTimer = null;
    this.targets = [
      'upnp:rootdevice',
      `uuid:${uuid}`,
      'urn:schemas-upnp-org:device:MediaServer:1',
      'urn:schemas-upnp-org:service:ContentDirectory:1',
      'urn:schemas-upnp-org:service:ConnectionManager:1',
    ];
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => { /* SSDP is best-effort */ });
    this.socket.on('message', (msg, rinfo) => this._onMessage(msg.toString(), rinfo));
    this.socket.bind(SSDP_PORT, () => {
      try {
        this.socket.addMembership(SSDP_ADDR);
        this.socket.setMulticastTTL(4);
      } catch { /* interface without multicast */ }
      this._notifyAll('ssdp:alive');
      this.notifyTimer = setInterval(() => this._notifyAll('ssdp:alive'), 90000);
    });
  }

  stop() {
    clearInterval(this.notifyTimer);
    if (this.socket) {
      try { this._notifyAll('ssdp:byebye'); } catch { /* closing */ }
      const s = this.socket;
      this.socket = null;
      setTimeout(() => { try { s.close(); } catch { /* closed */ } }, 150);
    }
  }

  _usn(target) {
    return target === `uuid:${this.uuid}` ? target : `uuid:${this.uuid}::${target}`;
  }

  _notifyAll(nts) {
    for (const target of this.targets) {
      const msg =
        'NOTIFY * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'CACHE-CONTROL: max-age=1800\r\n' +
        `LOCATION: ${this.location}\r\n` +
        `NT: ${target}\r\n` +
        `NTS: ${nts}\r\n` +
        `SERVER: Auralis/1.6 UPnP/1.0 ${this.serverName}/1.0\r\n` +
        `USN: ${this._usn(target)}\r\n\r\n`;
      try { this.socket?.send(msg, SSDP_PORT, SSDP_ADDR); } catch { /* best-effort */ }
    }
  }

  _onMessage(msg, rinfo) {
    if (!msg.startsWith('M-SEARCH')) return;
    const stMatch = msg.match(/^ST:\s*(.+)$/im);
    if (!stMatch) return;
    const st = stMatch[1].trim();
    const matches = st === 'ssdp:all' || this.targets.includes(st);
    if (!matches) return;
    const targets = st === 'ssdp:all' ? this.targets : [st];
    for (const target of targets) {
      const res =
        'HTTP/1.1 200 OK\r\n' +
        'CACHE-CONTROL: max-age=1800\r\n' +
        'EXT: \r\n' +
        `LOCATION: ${this.location}\r\n` +
        `SERVER: Auralis/1.6 UPnP/1.0 ${this.serverName}/1.0\r\n` +
        `ST: ${target}\r\n` +
        `USN: ${this._usn(target)}\r\n\r\n`;
      // small random delay per spec (MX), keep it snappy
      setTimeout(() => {
        try { this.socket?.send(res, rinfo.port, rinfo.address); } catch { /* gone */ }
      }, Math.random() * 300);
    }
  }
}

// ── searcher (control point role) ───────────────────────────────────────

const RENDERER_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:av-openhome-org:service:Product:1',
  'urn:av-openhome-org:service:Product:2',
];

function searchRenderers(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map(); // location → { location, st, usn }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => { try { socket.close(); } catch { /* fine */ } resolve([...found.values()]); });
    socket.on('message', (msg) => {
      const text = msg.toString();
      if (!/^HTTP\/1\.1 200/i.test(text)) return;
      const loc = text.match(/^LOCATION:\s*(.+)$/im)?.[1]?.trim();
      const st = text.match(/^ST:\s*(.+)$/im)?.[1]?.trim() || '';
      const usn = text.match(/^USN:\s*(.+)$/im)?.[1]?.trim() || '';
      if (loc && !found.has(loc)) found.set(loc, { location: loc, st, usn });
    });
    socket.bind(0, () => {
      for (const st of RENDERER_TARGETS) {
        const msearch =
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          `ST: ${st}\r\n\r\n`;
        socket.send(msearch, SSDP_PORT, SSDP_ADDR);
        // resend once — SSDP is UDP, first packets get eaten
        setTimeout(() => { try { socket.send(msearch, SSDP_PORT, SSDP_ADDR); } catch { /* fine */ } }, 400);
      }
    });
    setTimeout(() => {
      try { socket.close(); } catch { /* fine */ }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

module.exports = { SsdpAdvertiser, searchRenderers, localIPv4 };
