/* Small byte helpers shared by the parsers. Everything works on Uint8Array. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});

  function u16(b, o, le) {
    return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
  }

  function u32(b, o, le) {
    return le
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function ascii(b, start, len) {
    let s = '';
    const end = Math.min(b.length, start + len);
    for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function latin1(b) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < b.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
    }
    return s;
  }

  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  function utf8(b) {
    return utf8Decoder.decode(b);
  }

  /** Decode bytes that are probably UTF-8 but might be Latin-1. */
  function text(b) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) {
      return latin1(b);
    }
  }

  function startsWith(b, offset, str) {
    if (offset + str.length > b.length) return false;
    for (let i = 0; i < str.length; i++) {
      if (b[offset + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function writeU32BE(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  function writeU32LE(n) {
    return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** zlib inflate using the built-in DecompressionStream (browser + Node 18+). */
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('No DecompressionStream');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Shorten long values for display. */
  function clip(str, max) {
    max = max || 240;
    str = String(str).replace(/\u0000+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  MC.bin = { u16, u32, ascii, latin1, utf8, text, startsWith, concat, writeU32BE, writeU32LE, crc32, inflate, clip, formatBytes };
})(typeof window !== 'undefined' ? window : globalThis);
