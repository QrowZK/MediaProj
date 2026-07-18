'use strict';

// Minimal XML helpers for UPnP SOAP/DIDL — string building + targeted
// extraction. UPnP payloads are small and well-formed enough that a full DOM
// parser buys nothing here.

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function unescapeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// First <tag …>value</tag> match, namespace-prefix agnostic.
function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function xmlValues(xml, tag) {
  const out = [];
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

function soapEnvelope(serviceType, action, bodyXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
${bodyXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

function soapFault(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>${code}</errorCode>
          <errorDescription>${escapeXml(description)}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

module.exports = { escapeXml, unescapeXml, xmlValue, xmlValues, soapEnvelope, soapFault };
