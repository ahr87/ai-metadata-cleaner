/* Video engine: MP4 / MOV / M4V metadata cleaning WITHOUT re-encoding.
 *
 * Separate from the image engine. Works on File/Blob objects through
 * Blob.slice(), so the video is never loaded into memory as a whole: only box
 * headers, the 'moov' index and small metadata boxes are read.
 *
 * Cleaning is same-size and in place:
 *   - metadata boxes are overwritten with a 'free' box of exactly the same size
 *   - creation/modification dates in mvhd/tkhd/mdhd are zeroed
 *   - handler names and compressor names are zeroed
 *   - samples of removable timed-metadata tracks are zeroed
 * No byte moves, so every chunk offset stays valid, and the encoded video and
 * audio samples are copied byte-for-byte (as slices of the original file).
 */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});

  const CONFIG = {
    maxBytesDesktop: 2 * 1024 * 1024 * 1024, // ~2 GB
    maxBytesMobile: 1024 * 1024 * 1024, // ~1 GB on iPhone/iPad until tested further
    maxMoovBytes: 128 * 1024 * 1024, // the index of a very long video stays well below this
    maxBoxRead: 32 * 1024 * 1024, // largest metadata box read in full (C2PA, XMP, cover art)
    maxGapCheck: 64 * 1024 * 1024, // unreferenced bytes inside mdat that we inspect
    chunk: 4 * 1024 * 1024, // read size for comparisons
  };

  const UUIDS = {
    be7acfcb97a942e89c71999491e3afac: ['XMP', 'XMP metadata'],
    d8fec3d61b0e483c92975828877ec481: ['C2PA', 'Content Credentials (C2PA)'],
    '50524f4621d24fcebb88695cfac9c740': ['Device', 'Sony camera profile (PROF)'],
    '55534d5421d24fcebb88695cfac9c740': ['Device', 'Sony user metadata (USMT)'],
    '85c0b687820f11e08111f4ce462b6a48': ['Device', 'Canon camera data'],
  };
  const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';
  const UUID_C2PA = 'd8fec3d61b0e483c92975828877ec481';

  const ENCRYPTED = new Set(['encv', 'enca', 'enct', 'encs', 'encm', 'encf', 'drmi', 'drms', 'drmc']);
  const META_FORMATS = new Set(['mebx', 'gpmd', 'camm', 'mett', 'metx', 'urim', 'rtmd', 'djmd', 'dbgi', 'fdsc']);
  const FRAGMENT_BOXES = new Set(['moof', 'mfra', 'sidx', 'styp', 'ssix']);
  const PREVIEW_BOXES = new Set(['pnot', 'PICT', 'thum']);
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex', 'tref', 'gmhd', 'sinf', 'schi']);

  const VIDEO_CODECS = {
    avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)', dvh1: 'Dolby Vision', dvhe: 'Dolby Vision',
    dva1: 'Dolby Vision', dvav: 'Dolby Vision', av01: 'AV1', vp08: 'VP8', vp09: 'VP9', mp4v: 'MPEG-4 Visual',
    apch: 'ProRes 422 HQ', apcn: 'ProRes 422', apcs: 'ProRes 422 LT', apco: 'ProRes 422 Proxy', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ',
    jpeg: 'Motion JPEG', mjpa: 'Motion JPEG', s263: 'H.263', h263: 'H.263', encv: 'Encrypted video', drmi: 'Encrypted video',
  };
  const AUDIO_CODECS = {
    mp4a: 'AAC', Opus: 'Opus', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', 'ac-4': 'AC-4', alac: 'ALAC', fLaC: 'FLAC', '.mp3': 'MP3',
    lpcm: 'PCM', sowt: 'PCM', twos: 'PCM', in24: 'PCM', in32: 'PCM', fl32: 'PCM', fl64: 'PCM', raw: 'PCM', ulaw: 'µ-law', alaw: 'A-law',
    samr: 'AMR', sawb: 'AMR-WB', ipcm: 'PCM', fpcm: 'PCM', enca: 'Encrypted audio', drms: 'Encrypted audio',
  };

  class VideoError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // ------------------------------------------------------------------ helpers

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const i32 = (b, o) => u32(b, o) | 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const hex = (b, o, n) => Array.from(b.subarray(o, o + n), (x) => x.toString(16).padStart(2, '0')).join('');
  const label = (t) => t.replace(/[^\x20-\x7e]/g, (c) => (c === '\xa9' ? '©' : '?'));
  const utf8 = new TextDecoder('utf-8');
  const utf16 = new TextDecoder('utf-16be');

  async function read(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  function latin1(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return s;
  }

  function printable(b, min) {
    const runs = latin1(b.length > 4e6 ? b.subarray(0, 4e6) : b).match(new RegExp('[\\x20-\\x7e]{' + (min || 4) + ',}', 'g')) || [];
    return runs.join(' ');
  }

  function text(b) {
    return utf8.decode(b).replace(/\0+$/g, '').replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
  }

  function clip(s, max) {
    s = String(s);
    return s.length > (max || 400) ? s.slice(0, max || 400) + '…' : s;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function field(category, name, value, extra) {
    const v = value == null ? '' : String(value);
    const f = { category, name, value: clip(v), fullValue: v };
    if (extra) Object.assign(f, extra);
    return f;
  }

  function isZero(b) {
    for (let i = 0; i < b.length; i++) if (b[i]) return false;
    return true;
  }

  /** Seconds since 1904-01-01 (QuickTime epoch) → readable UTC string. */
  function qtDate(secs) {
    const d = new Date((secs - 2082844800) * 1000);
    return isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : String(secs);
  }

  function mergeRanges(ranges) {
    const r = ranges.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const x of r) {
      const last = out[out.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else out.push([x[0], x[1]]);
    }
    return out;
  }

  /** Does [s,e) intersect any merged range? */
  function overlaps(merged, s, e) {
    let lo = 0, hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][1] <= s) lo = mid + 1;
      else if (merged[mid][0] >= e) hi = mid - 1;
      else return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ detection

  function isVideoFile(file) {
    return /\.(mp4|mov|m4v|qt)$/i.test(file.name || '') || /^video\/(mp4|quicktime|x-m4v)$/i.test(file.type || '');
  }

  function isAppleMobile() {
    if (typeof navigator === 'undefined') return false;
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  }

  function maxBytes() {
    return isAppleMobile() ? CONFIG.maxBytesMobile : CONFIG.maxBytesDesktop;
  }

  function formatFrom(brand, compat, name) {
    const ext = ((name || '').match(/\.([^.]+)$/) || [])[1];
    const e = ext ? ext.toLowerCase() : '';
    if (/^M4V/.test(brand) || e === 'm4v') return 'm4v';
    if (brand === 'qt  ' || e === 'mov' || e === 'qt') return 'mov';
    return 'mp4';
  }

  // ------------------------------------------------------------------ box parsing

  /** Parse sibling boxes inside [start,end) of an in-memory buffer. */
  function parseChildren(b, start, end, lenient) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = fourcc(b, o + 4);
      let hs = 8;
      if (size === 1) {
        if (o + 16 > end) throw new VideoError('structure', 'A box header is truncated.');
        size = u64(b, o + 8);
        hs = 16;
      } else if (size === 0) {
        if (isZero(b.subarray(o, end))) break; // QuickTime list terminator / zero padding
        size = end - o;
      }
      if (size < hs || o + size > end) {
        if (lenient) break;
        throw new VideoError('structure', 'Box "' + label(type) + '" has an invalid size.');
      }
      out.push({ type, start: o, end: o + size, hs });
      o += size;
    }
    return out;
  }

  function tree(b, start, end) {
    return parseChildren(b, start, end).map((n) => {
      if (CONTAINERS.has(n.type)) n.children = tree(b, n.start + n.hs, n.end);
      return n;
    });
  }

  const kid = (n, t) => (n && n.children ? n.children.find((c) => c.type === t) : null);
  const path = (n, ...ts) => ts.reduce((x, t) => kid(x, t), n);

  /** Read the top-level box list of the file (headers only). */
  async function topLevel(blob) {
    const size = blob.size;
    const boxes = [];
    let o = 0;
    while (o < size) {
      if (size - o < 8) { boxes.push({ type: '(trailing)', start: o, end: size, hs: 0 }); break; }
      const h = await read(blob, o, Math.min(size, o + 32));
      let len = u32(h, 0);
      const type = fourcc(h, 4);
      let hs = 8;
      if (len === 1) { len = u64(h, 8); hs = 16; }
      else if (len === 0) len = size - o;
      const plausible = /^[\x20-\x7e\xa9]{4}$/.test(type);
      if (len < hs || o + len > size || !plausible) {
        // Data that is not a box (e.g. a vendor trailer appended after the last box).
        if (boxes.some((x) => x.type === 'moov')) { boxes.push({ type: '(trailing)', start: o, end: size, hs: 0 }); break; }
        throw new VideoError('structure', 'The file structure is damaged near byte ' + o + '.');
      }
      const box = { type, start: o, end: o + len, hs };
      if (type === 'uuid') box.uuid = hex(h, hs, 16);
      boxes.push(box);
      o += len;
      if (boxes.length > 100000) throw new VideoError('structure', 'Too many top-level boxes.');
    }
    return boxes;
  }

  // ------------------------------------------------------------------ metadata readers

  const UDTA = {
    '©nam': ['Text', 'Title'], '©day': ['Dates', 'Date'], '©too': ['Software', 'Encoder'], '©swr': ['Software', 'Software'],
    '©cmt': ['Text', 'Comment'], '©des': ['Text', 'Description'], '©inf': ['Text', 'Information'], '©ART': ['Text', 'Artist'],
    '©aut': ['Text', 'Author'], '©wrt': ['Text', 'Writer'], '©cpy': ['Text', 'Copyright'], '©mak': ['Device', 'Make'],
    '©mod': ['Device', 'Model'], '©dir': ['Text', 'Director'], '©prd': ['Text', 'Producer'], '©prf': ['Text', 'Performers'],
    '©req': ['Software', 'Requirements'], '©enc': ['Software', 'Encoded by'], '©fmt': ['Software', 'Format'], '©src': ['Text', 'Source'],
    '©hst': ['Device', 'Host computer'], '©key': ['Text', 'Keywords'], '©alb': ['Text', 'Album'], '©gen': ['Text', 'Genre'],
    '©xyz': ['Location', 'GPS location'], '©url': ['Text', 'URL'], '©lnk': ['Text', 'Link'], '©grp': ['Text', 'Grouping'],
    '©lyr': ['Text', 'Lyrics'], '©dis': ['Text', 'Disclaimer'], '©wrn': ['Text', 'Warning'], '©pub': ['Text', 'Publisher'],
    '©ed1': ['Text', 'Edit note'], '©snm': ['Text', 'Sort name'],
    titl: ['Text', 'Title'], auth: ['Text', 'Author'], cprt: ['Text', 'Copyright'], dscp: ['Text', 'Description'],
    perf: ['Text', 'Performer'], gnre: ['Text', 'Genre'], albm: ['Text', 'Album'], kywd: ['Text', 'Keywords'],
    rtng: ['Text', 'Rating'], clsf: ['Text', 'Classification'], yrrc: ['Dates', 'Recording year'], loci: ['Location', 'Location'],
    name: ['Text', 'Track name'], desc: ['Text', 'Description'], ldes: ['Text', 'Long description'], aART: ['Text', 'Album artist'],
    covr: ['Cover art', 'Cover art'], XMP_: ['XMP', 'XMP metadata'], Xtra: ['Vendor data', 'Windows Media tags (Xtra)'],
    manu: ['Device', 'Manufacturer'], modl: ['Device', 'Model'], FIRM: ['Device', 'Firmware'], LENS: ['Device', 'Lens'],
    CAME: ['Device', 'Camera serial'], SETT: ['Device', 'Camera settings'], MUID: ['Device', 'Media unique ID'],
    GUMI: ['Device', 'Media ID'], GPMF: ['Vendor data', 'GoPro metadata (GPMF)'], HMMT: ['Vendor data', 'Highlight markers'],
    BCID: ['Device', 'Camera ID'], smta: ['Device', 'Samsung metadata'], SDLN: ['Device', 'Device model'],
    mdln: ['Device', 'Model'], thmb: ['Cover art', 'Thumbnail'], mcvr: ['Cover art', 'Cover image'], chpl: ['Text', 'Chapters'],
    hnti: ['Other', 'Streaming hint info'], tagc: ['Device', 'Camera tags'], meta: ['Other', 'Metadata'],
  };

  function keyCategory(key) {
    if (/location|iso6709|gps|latitude|longitude|altitude|\bxyz\b/i.test(key)) return 'Location';
    if (/content\.identifier|make|model|camera|lens|serial|device|firmware|manufacturer/i.test(key)) return 'Device';
    if (/software|encoder|tool|application|writer\b|version|handler/i.test(key)) return 'Software';
    if (/creationdate|date|time/i.test(key)) return 'Dates';
    if (/artwork|cover|thumbnail/i.test(key)) return 'Cover art';
    return 'Text';
  }

  /** Value of an iTunes/QuickTime 'data' box. */
  function dataValue(b, d) {
    const p = d.start + d.hs;
    if (p + 8 > d.end) return '';
    const type = u32(b, p) & 0xffffff;
    const v = b.subarray(p + 8, d.end);
    switch (type) {
      case 1: return text(v);
      case 2: return utf16.decode(v).replace(/\0+$/, '');
      case 13: case 14: case 27: return '[image, ' + fmtBytes(v.length) + ']';
      case 21: case 22: case 65: case 66: case 67: case 74: case 75: case 76: case 77: case 78: {
        let n = 0;
        for (let i = 0; i < Math.min(v.length, 6); i++) n = n * 256 + v[i];
        return String(n);
      }
      case 23: return v.length >= 4 ? String(new DataView(v.buffer, v.byteOffset, 4).getFloat32(0)) : '';
      case 24: return v.length >= 8 ? String(new DataView(v.buffer, v.byteOffset, 8).getFloat64(0)) : '';
      default: return printable(v, 3) || '[' + fmtBytes(v.length) + ' of data]';
    }
  }

  /** QuickTime ©-text atom: list of [u16 len][u16 lang][text], or an iTunes 'data' child. */
  function qtText(b, n) {
    const inner = parseChildren(b, n.start + n.hs, n.end, true);
    const data = inner.filter((c) => c.type === 'data');
    if (data.length) return data.map((d) => dataValue(b, d)).join('; ');
    const out = [];
    let o = n.start + n.hs;
    while (o + 4 <= n.end) {
      const len = u16(b, o);
      if (!len || o + 4 + len > n.end) break;
      out.push(text(b.subarray(o + 4, o + 4 + len)));
      o += 4 + len;
    }
    return out.length ? out.join('; ') : printable(b.subarray(n.start + n.hs, n.end), 3);
  }

  /** 3GPP text box: FullBox + 2-byte language + UTF-8 / UTF-16 string. */
  function gppText(b, n) {
    const p = n.start + n.hs + 6;
    const v = b.subarray(p, n.end);
    if (v[0] === 0xfe && v[1] === 0xff) return utf16.decode(v.subarray(2)).replace(/\0+$/, '');
    return text(v);
  }

  function lociValue(b, n) {
    let p = n.start + n.hs + 6;
    const z = b.indexOf(0, p);
    const name = z > p ? text(b.subarray(p, z)) : '';
    p = (z < 0 ? n.end : z) + 2; // skip terminator + role
    if (p + 12 <= n.end) {
      const lon = i32(b, p) / 65536, lat = i32(b, p + 4) / 65536;
      return (name ? name + ' · ' : '') + lat.toFixed(5) + ', ' + lon.toFixed(5);
    }
    return name || printable(b.subarray(n.start + n.hs, n.end), 3);
  }

  function xmpFields(xml, where) {
    const parse = MC.exif && MC.exif.parseXmp;
    if (!parse) return [field('XMP', 'XMP metadata' + where, clip(xml, 200))];
    return parse(xml).map((f) => field(f.category === 'GPS' ? 'Location' : 'XMP', f.name + where, f.fullValue));
  }

  /** claim_generator / claim_generator_info.name from a C2PA manifest (CBOR text). */
  function c2paGenerators(b) {
    const s = latin1(b.length > 8e6 ? b.subarray(0, 8e6) : b);
    const found = new Set();
    const readText = (i) => {
      const h = s.charCodeAt(i);
      let len = -1, st = i + 1;
      if (h >= 0x60 && h <= 0x77) len = h - 0x60;
      else if (h === 0x78) { len = s.charCodeAt(i + 1); st = i + 2; }
      else if (h === 0x79) { len = (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2); st = i + 3; }
      const v = len > 0 && len < 300 ? s.slice(st, st + len) : '';
      return /^[\x20-\x7e]+$/.test(v) ? v : '';
    };
    let i = s.indexOf('claim_generator');
    for (let guard = 0; i >= 0 && guard < 30; guard++) {
      const after = i + 'claim_generator'.length;
      if (s.slice(after, after + 5) === '_info') {
        const n = s.indexOf('\x64name', after);
        if (n > 0 && n - after < 400) { const v = readText(n + 5); if (v) found.add(v); }
      } else {
        const v = readText(after);
        if (v) found.add(v);
      }
      i = s.indexOf('claim_generator', i + 1);
    }
    const agent = /softwareAgent[\s\S]{0,40}?\x64name([\s\S])/.exec(s);
    if (agent) { const v = readText(agent.index + agent[0].length - 1); if (v) found.add(v); }
    return Array.from(found);
  }

  /** Fields for a 'meta' box (QuickTime mdta keys or iTunes ilst, ID3, XML). */
  function metaFields(b, n, where, blobs) {
    const fields = [];
    let p = n.start + n.hs;
    if (fourcc(b, p + 4) !== 'hdlr') p += 4; // ISO 'meta' is a FullBox; QuickTime 'meta' is not
    const kids = parseChildren(b, p, n.end, true);
    const keysBox = kids.find((k) => k.type === 'keys');
    const keys = [];
    if (keysBox) {
      let q = keysBox.start + keysBox.hs + 8;
      const count = u32(b, keysBox.start + keysBox.hs + 4);
      for (let i = 0; i < count && q + 8 <= keysBox.end; i++) {
        const sz = u32(b, q);
        if (sz < 8 || q + sz > keysBox.end) break;
        keys.push(text(b.subarray(q + 8, q + sz)));
        q += sz;
      }
    }
    for (const k of kids) {
      if (k.type === 'ilst') {
        for (const item of parseChildren(b, k.start + k.hs, k.end, true)) {
          const idx = u32(b, item.start + 4);
          let key = keys.length && idx >= 1 && idx <= keys.length ? keys[idx - 1] : item.type;
          const inner = parseChildren(b, item.start + item.hs, item.end, true);
          if (item.type === '----') {
            const mean = inner.find((c) => c.type === 'mean'), nm = inner.find((c) => c.type === 'name');
            key = (mean ? text(b.subarray(mean.start + 12, mean.end)) + ':' : '') + (nm ? text(b.subarray(nm.start + 12, nm.end)) : '----');
          }
          const value = inner.filter((c) => c.type === 'data').map((d) => dataValue(b, d)).join('; ');
          const known = UDTA[key];
          const cat = known ? known[0] : keyCategory(key);
          const nice = known ? known[1] : key.replace(/^com\.apple\.quicktime\./, '');
          fields.push(field(cat, nice + where, value, { key: key.split('.').pop(), sensitive: cat === 'Location' || cat === 'Device' }));
        }
      } else if (k.type === 'ID32' || k.type === 'ID3 ') {
        fields.push(field('Text', 'ID3 tags' + where, printable(b.subarray(k.start + k.hs, k.end), 3)));
      } else if (k.type === 'xml ' || k.type === 'XMP_') {
        fields.push.apply(fields, xmpFields(utf8.decode(b.subarray(k.start + k.hs + (k.type === 'xml ' ? 4 : 0), k.end)), where));
      } else if (k.type !== 'hdlr' && k.type !== 'keys' && k.type !== 'free' && k.type !== 'skip') {
        const t = printable(b.subarray(k.start + k.hs, k.end), 4);
        if (t) { fields.push(field('Other', 'Metadata "' + label(k.type) + '"' + where, t)); blobs.push({ source: 'meta ' + k.type, text: t }); }
      }
    }
    const meaningful = kids.some((k) => !/^(hdlr|free|skip|keys|ilst)$/.test(k.type) || (k.type === 'ilst' && k.end - k.start > 8) || (k.type === 'keys' && u32(b, k.start + k.hs + 4) > 0));
    if (!fields.length && meaningful) fields.push(field('Other', 'Metadata box' + where, fmtBytes(n.end - n.start)));
    return fields;
  }

  function udtaFields(b, n, where, blobs) {
    const fields = [];
    let kids;
    try {
      kids = parseChildren(b, n.start + n.hs, n.end);
    } catch (e) {
      return [field('Other', 'User data (unreadable)' + where, fmtBytes(n.end - n.start))];
    }
    for (const k of kids) {
      if (k.type === 'free' || k.type === 'skip') continue;
      const known = UDTA[k.type];
      let cat = known ? known[0] : 'Other';
      const nm = (known ? known[1] : 'User data "' + label(k.type) + '"') + where;
      try {
        if (k.type === 'meta') { fields.push.apply(fields, metaFields(b, k, where, blobs)); continue; }
        if (k.type === 'XMP_') { fields.push.apply(fields, xmpFields(utf8.decode(b.subarray(k.start + k.hs, k.end)), where)); continue; }
        if (k.type === 'uuid') { const u = hex(b, k.start + 8, 16); const kn = UUIDS[u]; fields.push(field(kn ? kn[0] : 'Vendor data', (kn ? kn[1] : 'Vendor data (uuid ' + u.slice(0, 8) + '…)') + where, printable(b.subarray(k.start + 24, k.end), 4) || fmtBytes(k.end - k.start))); continue; }
        let value;
        if (k.type === 'loci') value = lociValue(b, k);
        else if (k.type === 'yrrc') value = String(u16(b, k.start + k.hs + 4));
        else if (/^(titl|auth|cprt|dscp|perf|gnre|albm|kywd|rtng|clsf)$/.test(k.type)) value = gppText(b, k);
        else if (k.type[0] === '©') value = qtText(b, k);
        else if (k.type === 'name') value = text(b.subarray(k.start + k.hs, k.end));
        else value = printable(b.subarray(k.start + k.hs, k.end), 3) || fmtBytes(k.end - k.start);
        if (cat === 'Other' && /gps|loc/i.test(value)) cat = 'Location';
        fields.push(field(cat, nm, value, { key: (known ? known[1] : k.type).toLowerCase(), sensitive: cat === 'Location' || cat === 'Device' }));
      } catch (e) {
        fields.push(field(cat, nm, fmtBytes(k.end - k.start)));
      }
    }
    if (!fields.length && kids.some((k) => !/^(meta|free|skip)$/.test(k.type))) fields.push(field('Other', 'User data box' + where, fmtBytes(n.end - n.start)));
    return fields;
  }

  // ------------------------------------------------------------------ tracks

  function hdlrInfo(b, h) {
    const p = h.start + h.hs;
    const nameStart = Math.min(h.end, p + 24);
    const raw = b.subarray(nameStart, h.end);
    let name = latin1(raw).replace(/\0+$/, '');
    if (name.length && name.charCodeAt(0) === name.length - 1) name = name.slice(1); // Pascal string
    name = name.replace(/[^\x20-\x7e]/g, '').trim();
    return { handler: fourcc(b, p + 8), name, nameStart, end: h.end };
  }

  function datesOf(b, box) {
    const p = box.start + box.hs;
    const v1 = b[p] === 1;
    const len = v1 ? 8 : 4;
    const c = p + 4, m = p + 4 + len;
    const rd = (o) => (v1 ? u64(b, o) : u32(b, o));
    return { c, m, len, created: rd(c), modified: rd(m), v1, p };
  }

  function timescaleDuration(b, box) {
    const d = datesOf(b, box);
    return d.v1 ? { timescale: u32(b, d.p + 20), duration: u64(b, d.p + 24) } : { timescale: u32(b, d.p + 12), duration: u32(b, d.p + 16) };
  }

  function sampleTables(b, stbl) {
    const t = { offsets: [], stsc: [], sizes: null, constSize: 0, count: 0, ok: true };
    const stco = kid(stbl, 'stco') || kid(stbl, 'co64');
    if (stco) {
      const big = stco.type === 'co64';
      const p = stco.start + stco.hs;
      const n = u32(b, p + 4);
      if (p + 8 + n * (big ? 8 : 4) > stco.end) t.ok = false;
      else for (let i = 0; i < n; i++) t.offsets.push(big ? u64(b, p + 8 + i * 8) : u32(b, p + 8 + i * 4));
    }
    const stsc = kid(stbl, 'stsc');
    if (stsc) {
      const p = stsc.start + stsc.hs;
      const n = u32(b, p + 4);
      if (p + 8 + n * 12 > stsc.end) t.ok = false;
      else for (let i = 0; i < n; i++) t.stsc.push({ first: u32(b, p + 8 + i * 12), spc: u32(b, p + 12 + i * 12) });
    }
    const stsz = kid(stbl, 'stsz');
    const stz2 = kid(stbl, 'stz2');
    if (stsz) {
      const p = stsz.start + stsz.hs;
      t.constSize = u32(b, p + 4);
      t.count = u32(b, p + 8);
      if (!t.constSize) {
        if (p + 12 + t.count * 4 > stsz.end) t.ok = false;
        else { t.sizes = new Uint32Array(t.count); for (let i = 0; i < t.count; i++) t.sizes[i] = u32(b, p + 12 + i * 4); }
      }
    } else if (stz2) {
      const p = stz2.start + stz2.hs;
      const fs = b[p + 7];
      t.count = u32(b, p + 8);
      t.sizes = new Uint32Array(t.count);
      for (let i = 0; i < t.count; i++) {
        if (fs === 16) t.sizes[i] = u16(b, p + 12 + i * 2);
        else if (fs === 8) t.sizes[i] = b[p + 12 + i];
        else t.sizes[i] = (b[p + 12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;
      }
    }
    return t;
  }

  /** Byte ranges [start,end) of every chunk of a track. */
  function chunkRanges(t) {
    const ranges = [];
    let si = 0;
    for (let i = 0; i < t.stsc.length; i++) {
      const next = i + 1 < t.stsc.length ? t.stsc[i + 1].first : t.offsets.length + 1;
      for (let c = t.stsc[i].first; c < next && c <= t.offsets.length; c++) {
        let bytes = 0;
        for (let s = 0; s < t.stsc[i].spc; s++, si++) bytes += t.constSize || (t.sizes ? t.sizes[si] || 0 : 0);
        ranges.push([t.offsets[c - 1], t.offsets[c - 1] + bytes]);
      }
    }
    return ranges;
  }

  function sampleEntry(b, stsd) {
    const p = stsd.start + stsd.hs;
    const entries = parseChildren(b, p + 8, stsd.end, true);
    return entries;
  }

  function esdsLabel(b, e, childStart) {
    try {
      const kids = parseChildren(b, childStart, e.end, true);
      const esds = kids.find((k) => k.type === 'esds');
      if (!esds) return 'AAC';
      const s = b.subarray(esds.start + esds.hs + 4, esds.end);
      const i = s.indexOf(0x04);
      if (i >= 0) {
        let j = i + 1;
        while (j < s.length && s[j] & 0x80) j++;
        const ot = s[j + 1];
        if (ot === 0x6b || ot === 0x69) return 'MP3';
      }
    } catch (e2) { /* fall through */ }
    return 'AAC';
  }

  function colorInfo(b, e, childStart) {
    const info = { hdr: false, boxes: [] };
    try {
      for (const k of parseChildren(b, childStart, e.end, true)) {
        info.boxes.push(k.type);
        if (/^(mdcv|clli|dvcC|dvvC|dvwC|SmDm|CoLL|mdvc)$/.test(k.type)) info.hdr = true;
        if (k.type === 'colr') {
          const ct = fourcc(b, k.start + 8);
          if ((ct === 'nclx' || ct === 'nclc') && k.end - k.start >= 16) {
            const tr = u16(b, k.start + 14);
            if (tr === 16 || tr === 18) info.hdr = true;
          }
        }
      }
    } catch (e2) { /* ignore */ }
    return info;
  }

  function rotationOf(b, tkhd) {
    const m = tkhd.end - 8 - 36;
    const a = i32(b, m), bb = i32(b, m + 4);
    if (a === 0 && bb === 0x10000) return 90;
    if (a === 0 && bb === -0x10000) return 270;
    if (a === -0x10000) return 180;
    return 0;
  }

  /** Bytes of a track that must stay identical (dates and names masked). */
  function fingerprint(b, trak, maskList) {
    const parts = [];
    const walk = (n) => {
      if (n.type === 'udta' || n.type === 'meta' || n.type === 'uuid' || n.type === 'free' || n.type === 'skip') return;
      if (n.children) { n.children.forEach(walk); return; }
      const copy = b.slice(n.start, n.end);
      for (const [s, e] of maskList) {
        for (let i = Math.max(s, n.start); i < Math.min(e, n.end); i++) copy[i - n.start] = 0;
      }
      parts.push(copy);
    };
    walk(trak);
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function seiText(buf, nalLen, hevc) {
    const out = [];
    let o = 0;
    while (o + nalLen < buf.length) {
      let n = 0;
      for (let i = 0; i < nalLen; i++) n = n * 256 + buf[o + i];
      o += nalLen;
      if (n <= 0 || o + n > buf.length) break;
      const h = buf[o];
      const type = hevc ? (h >> 1) & 0x3f : h & 0x1f;
      if ((!hevc && type === 6) || (hevc && (type === 39 || type === 40))) {
        const t = printable(buf.subarray(o + (hevc ? 2 : 1), o + n), 8);
        if (t) out.push(t);
      }
      o += n;
    }
    return out.join(' ');
  }

  // ------------------------------------------------------------------ analyze

  /**
   * Analyze an MP4/MOV/M4V file. Never throws for unsupported files; instead
   * sets `unsupported` so the UI can explain why it will not be modified.
   */
  async function analyze(blob, name, onProgress) {
    const a = {
      kind: 'video', name: name || blob.name || 'video', size: blob.size, format: 'mp4', brand: '',
      fields: [], blobs: [], unsupported: null, uuids: [], props: null,
      plan: { moovEdits: [], patches: [], moov: null }, keptRanges: [], tracks: [],
    };
    const fail = (code, message) => { if (!a.unsupported) a.unsupported = { code, message }; };

    let top;
    try {
      top = await topLevel(blob);
    } catch (e) {
      fail('structure', e.message);
      return finish(a);
    }
    a.top = top;
    const ftyp = top.find((x) => x.type === 'ftyp');
    if (ftyp) {
      const h = await read(blob, ftyp.start, Math.min(ftyp.end, ftyp.start + 64));
      a.brand = fourcc(h, 8);
      const compat = [];
      for (let o = 16; o + 4 <= h.length; o += 4) compat.push(fourcc(h, o));
      a.compat = compat;
      if (/^(heic|heix|mif1|msf1|avif|avis|crx )$/.test(a.brand)) fail('format', 'This is not a video file (' + a.brand.trim() + ').');
    } else if (!top.length || !/^(moov|mdat|wide|free|skip|pnot)$/.test(top[0].type)) {
      fail('format', 'This file does not look like an MP4, MOV or M4V video.');
      return finish(a);
    }
    a.format = formatFrom(a.brand, a.compat, a.name);

    if (top.some((x) => FRAGMENT_BOXES.has(x.type))) fail('fragmented', 'Unsupported: fragmented MP4. This kind of file is not modified in this version.');
    if (top.some((x) => x.type === 'pssh')) fail('encrypted', 'Unsupported: encrypted/protected video. Protected media is never modified.');
    const moovs = top.filter((x) => x.type === 'moov');
    const mdats = top.filter((x) => x.type === 'mdat').map((x) => [x.start + x.hs, x.end]);
    if (moovs.length !== 1) { fail('structure', moovs.length ? 'Unsupported structure: more than one movie header.' : 'The file has no movie header (moov). It may be incomplete.'); return finish(a); }
    const moovBox = moovs[0];
    if (moovBox.end - moovBox.start > CONFIG.maxMoovBytes) { fail('structure', 'The video index is too large to process in the browser.'); return finish(a); }

    const mb = await read(blob, moovBox.start, moovBox.end);
    a.plan.moov = { start: moovBox.start, end: moovBox.end, bytes: null };
    const edits = []; // [kind, start, end] inside mb
    let moov;
    try {
      moov = { type: 'moov', start: 0, end: mb.length, hs: moovBox.hs, children: tree(mb, moovBox.hs, mb.length) };
    } catch (e) {
      fail('structure', 'Unsupported structure: ' + e.message);
      return finish(a);
    }
    if (kid(moov, 'cmov')) { fail('structure', 'Unsupported structure: compressed movie header (old QuickTime).'); return finish(a); }
    if (kid(moov, 'mvex')) fail('fragmented', 'Unsupported: fragmented MP4. This kind of file is not modified in this version.');
    if (kid(moov, 'rmra')) { fail('structure', 'Unsupported structure: QuickTime reference movie (points to other files).'); return finish(a); }

    const neutralize = (n, why) => edits.push(['free', n.start, n.end, n.hs, why]);
    const zero = (s, e, why) => { if (e > s) edits.push(['zero', s, e, 0, why]); };

    // Movie header dates
    const mvhd = kid(moov, 'mvhd');
    if (!mvhd) { fail('structure', 'The movie header (mvhd) is missing.'); return finish(a); }
    const md = datesOf(mb, mvhd);
    const mts = timescaleDuration(mb, mvhd);
    if (md.created) a.fields.push(field('Dates', 'Creation date (movie header)', qtDate(md.created), { sensitive: true }));
    if (md.modified) a.fields.push(field('Dates', 'Modification date (movie header)', qtDate(md.modified)));
    zero(md.c, md.c + md.len, 'date');
    zero(md.m, md.m + md.len, 'date');

    // Tracks
    const traks = moov.children.filter((c) => c.type === 'trak');
    for (const trak of traks) {
      const t = { node: trak, remove: false, fields: [] };
      const tkhd = kid(trak, 'tkhd');
      const mdhd = path(trak, 'mdia', 'mdhd');
      const hdlr = path(trak, 'mdia', 'hdlr');
      const stbl = path(trak, 'mdia', 'minf', 'stbl');
      if (!tkhd || !mdhd || !hdlr || !stbl) { fail('structure', 'Unsupported structure: a track is missing required boxes.'); continue; }
      const td = datesOf(mb, tkhd);
      t.id = td.v1 ? u32(mb, td.p + 20) : u32(mb, td.p + 12);
      const hd = hdlrInfo(mb, hdlr);
      t.handler = hd.handler;
      const mdd = datesOf(mb, mdhd);
      const mts2 = timescaleDuration(mb, mdhd);
      t.timescale = mts2.timescale;
      t.duration = mts2.duration;
      t.masks = [[td.c, td.c + td.len * 2], [mdd.c, mdd.c + mdd.len * 2], [hd.nameStart, hd.end]];
      t.width = u32(mb, tkhd.end - 8) / 65536;
      t.height = u32(mb, tkhd.end - 4) / 65536;
      t.rotation = rotationOf(mb, tkhd);

      // Sample description
      const stsd = kid(stbl, 'stsd');
      const entries = stsd ? sampleEntry(mb, stsd) : [];
      const e = entries[0];
      t.format = e ? e.type : '';
      // QuickTime sample descriptions carry a 4-byte vendor code of the writing software ('FFMP', 'appl', …).
      // In ISO MP4 these bytes are reserved zeros, so clearing them is always safe.
      if (e && (t.handler === 'vide' || t.handler === 'soun') && e.start + 24 <= e.end) {
        const vendor = latin1(mb.subarray(e.start + 20, e.start + 24));
        if (!isZero(mb.subarray(e.start + 20, e.start + 24))) {
          t.fields.push(field('Software', 'Encoder vendor code (' + label(t.handler) + ' track)', vendor.replace(/[^\x20-\x7e]/g, '?')));
          zero(e.start + 20, e.start + 24, 'vendor');
        }
        t.masks.push([e.start + 20, e.start + 24]);
      }
      if (entries.some((x) => ENCRYPTED.has(x.type) || /sinf[\s\S]{4}frma/.test(latin1(mb.subarray(x.start, x.end))))) {
        fail('encrypted', 'Unsupported: encrypted/protected video. Protected media is never modified.');
      }
      if (t.handler === 'vide' && e) {
        t.kind = 'video';
        t.codec = VIDEO_CODECS[e.type] || e.type;
        t.codedWidth = u16(mb, e.start + 32);
        t.codedHeight = u16(mb, e.start + 34);
        const cn = e.start + 50;
        if (cn + 32 <= e.end) {
          const len = Math.min(mb[cn], 31);
          const cname = latin1(mb.subarray(cn + 1, cn + 1 + len)).replace(/[^\x20-\x7e]/g, '').trim();
          if (cname) t.fields.push(field('Software', 'Compressor name (track ' + t.id + ')', cname));
          zero(cn, cn + 32, 'compressorname');
          t.masks.push([cn, cn + 32]);
        }
        const ci = colorInfo(mb, e, e.start + 86);
        t.hdr = ci.hdr;
        t.colorBoxes = ci.boxes;
        // NAL length size for SEI scanning
        try {
          const cfg = parseChildren(mb, e.start + 86, e.end, true).find((k) => k.type === 'avcC' || k.type === 'hvcC');
          if (cfg) t.nal = { len: ((mb[cfg.start + 8 + (cfg.type === 'avcC' ? 4 : 21)] & 3) + 1), hevc: cfg.type === 'hvcC' };
        } catch (er) { /* ignore */ }
      } else if (t.handler === 'soun' && e) {
        t.kind = 'audio';
        const ver = u16(mb, e.start + 16);
        t.codec = AUDIO_CODECS[e.type] || e.type;
        t.channels = u16(mb, e.start + 24);
        t.sampleRate = u32(mb, e.start + 32) >>> 16;
        const childStart = e.start + (ver === 1 ? 52 : ver === 2 ? 72 : 36);
        if (e.type === 'mp4a') t.codec = esdsLabel(mb, e, childStart);
      } else if (t.handler === 'meta' || META_FORMATS.has(t.format)) {
        t.kind = 'meta';
      } else {
        t.kind = 'other';
        t.codec = t.format;
      }

      // External data references are not supported
      const dref = path(trak, 'mdia', 'minf', 'dinf');
      if (dref) {
        const dr = kid(dref, 'dref');
        if (dr) {
          for (const en of parseChildren(mb, dr.start + dr.hs + 8, dr.end, true)) {
            if (!(u32(mb, en.start + 8) & 1)) fail('structure', 'Unsupported structure: the video refers to media in other files.');
          }
        }
      }

      // Samples
      const st = sampleTables(mb, stbl);
      if (!st.ok) fail('structure', 'Unsupported structure: a sample table is damaged.');
      t.sampleCount = st.count;
      t.firstOffset = st.offsets[0];
      t.firstSize = st.constSize || (st.sizes ? st.sizes[0] : 0);
      t.conservative = t.kind === 'audio' && st.constSize === 1; // old QuickTime PCM: sizes are not bytes
      t.ranges = chunkRanges(st);
      t.fps = t.kind === 'video' && t.duration && t.timescale ? st.count / (t.duration / t.timescale) : 0;
      t.tref = [];
      const tref = kid(trak, 'tref');
      if (tref && tref.children) for (const r of tref.children) for (let o = r.start + 8; o + 4 <= r.end; o += 4) t.tref.push(u32(mb, o));

      // Track-level metadata
      if (td.created) t.fields.push(field('Dates', 'Creation date (track ' + t.id + ')', qtDate(td.created)));
      if (td.modified) t.fields.push(field('Dates', 'Modification date (track ' + t.id + ')', qtDate(td.modified)));
      if (mdd.created) t.fields.push(field('Dates', 'Creation date (media ' + t.id + ')', qtDate(mdd.created)));
      if (mdd.modified) t.fields.push(field('Dates', 'Modification date (media ' + t.id + ')', qtDate(mdd.modified)));
      zero(td.c, td.c + td.len * 2, 'date');
      zero(mdd.c, mdd.c + mdd.len * 2, 'date');
      if (hd.name) t.fields.push(field('Software', 'Handler name (' + label(hd.handler) + ')', hd.name));
      zero(hd.nameStart, hd.end, 'hdlr');
      const dh = path(trak, 'mdia', 'minf', 'hdlr');
      if (dh) {
        const di = hdlrInfo(mb, dh);
        if (di.name) t.fields.push(field('Software', 'Data handler name (track ' + t.id + ')', di.name));
        zero(di.nameStart, di.end, 'hdlr');
        t.masks.push([di.nameStart, di.end]);
      }
      for (const c of trak.children) {
        if (c.type === 'udta') { t.fields.push.apply(t.fields, udtaFields(mb, c, ' (track ' + t.id + ')', a.blobs)); neutralize(c, 'udta'); }
        else if (c.type === 'meta') { t.fields.push.apply(t.fields, metaFields(mb, c, ' (track ' + t.id + ')', a.blobs)); neutralize(c, 'meta'); }
        else if (c.type === 'uuid') { const u = hex(mb, c.start + 8, 16); a.uuids.push(u); const kn = UUIDS[u]; t.fields.push(field(kn ? kn[0] : 'Vendor data', (kn ? kn[1] : 'Vendor data (uuid)') + ' (track ' + t.id + ')', fmtBytes(c.end - c.start))); neutralize(c, 'uuid'); }
      }
      a.tracks.push(t);
    }

    // Movie-level metadata boxes
    for (const c of moov.children) {
      if (c.type === 'udta') { a.fields.push.apply(a.fields, udtaFields(mb, c, '', a.blobs)); neutralize(c, 'udta'); }
      else if (c.type === 'meta') { a.fields.push.apply(a.fields, metaFields(mb, c, '', a.blobs)); neutralize(c, 'meta'); }
      else if (c.type === 'uuid') {
        const u = hex(mb, c.start + 8, 16);
        a.uuids.push(u);
        const kn = UUIDS[u];
        const body = mb.subarray(c.start + 24, c.end);
        if (u === UUID_XMP) a.fields.push.apply(a.fields, xmpFields(utf8.decode(body), ''));
        else a.fields.push(field(kn ? kn[0] : 'Vendor data', kn ? kn[1] : 'Vendor data (uuid ' + u.slice(0, 8) + '…)', printable(body, 4) || fmtBytes(body.length)));
        neutralize(c, 'uuid');
      } else if ((c.type === 'free' || c.type === 'skip') && !isZero(mb.subarray(c.start + c.hs, c.end))) {
        a.fields.push(field('Hidden data', 'Leftover data in free space (movie header)', printable(mb.subarray(c.start + c.hs, c.end), 4) || fmtBytes(c.end - c.start)));
        zero(c.start + c.hs, c.end, 'free');
      }
    }

    // Kept media ranges (everything except removable metadata tracks)
    const allRanges = [];
    for (const t of a.tracks) for (const r of t.ranges) allRanges.push(r);
    const chunkStarts = mergeRanges(allRanges).map((r) => r[0]);
    for (const t of a.tracks) {
      if (t.conservative) {
        // Old QuickTime PCM: protect everything up to the next chunk of any track / end of mdat.
        t.ranges = t.ranges.map(([s]) => {
          const nextStart = chunkStarts.find((x) => x > s);
          const md2 = mdats.find(([ms, me]) => s >= ms && s < me);
          return [s, Math.min(nextStart || Infinity, md2 ? md2[1] : blob.size)];
        });
      }
      t.merged = mergeRanges(t.ranges);
      for (const [s, e] of t.merged) {
        if (e > blob.size || s < 0) fail('structure', 'The file is incomplete: some samples are missing.');
        if (!mdats.some(([ms, me]) => s >= ms && e <= me)) t.outsideMdat = true;
      }
    }

    // Timed metadata tracks: remove only when it is provably safe.
    for (const t of a.tracks.filter((x) => x.kind === 'meta')) {
      const others = a.tracks.filter((x) => x !== t && !x.remove);
      const otherRanges = mergeRanges([].concat(...others.map((x) => x.merged)));
      const referenced = others.some((x) => x.tref.includes(t.id));
      const shared = t.merged.some(([s, e]) => overlaps(otherRanges, s, e));
      const safe = !t.conservative && !t.outsideMdat && !referenced && !shared;
      let preview = '';
      try {
        if (!shared && t.firstOffset != null && t.firstSize) preview = printable(await read(blob, t.firstOffset, t.firstOffset + Math.min(t.firstSize, 65536)), 4);
      } catch (e) { /* ignore */ }
      const stsdInfo = printable(mb.subarray(t.node.start, t.node.end), 6).replace(/\b(trak|tkhd|mdia|mdhd|hdlr|minf|stbl|stsd|stts|stsc|stsz|stco|dinf|dref|nmhd|url )\b/g, '').trim();
      const desc = 'Format ' + label(t.format) + ' · ' + t.sampleCount + ' samples' + (preview ? ' · ' + preview : stsdInfo ? ' · ' + stsdInfo : '');
      if (safe) {
        t.remove = true;
        a.fields.push(field('Timed metadata', 'Timed metadata track ' + t.id + ' (' + label(t.format) + ')', desc, { sensitive: true }));
        if (preview) a.blobs.push({ source: 'timed metadata', text: preview });
      } else {
        a.fields.push(field('Timed metadata', 'Timed metadata track ' + t.id + ' (' + label(t.format) + ')', desc, { remaining: true, reason: 'Remaining — advanced/in-stream metadata (cannot be removed safely)' }));
      }
    }
    for (const t of a.tracks) {
      if (t.remove) { neutralize(t.node, 'meta-track'); continue; }
      a.fields.push.apply(a.fields, t.fields);
      for (const r of t.merged) a.keptRanges.push(r);
    }
    a.keptRanges = mergeRanges(a.keptRanges);
    if (a.keptRanges.some(([s, e]) => s < moovBox.end && e > moovBox.start)) fail('structure', 'Unsupported structure: media data overlaps the movie header.');

    // In-stream metadata (reported, never modified)
    for (const t of a.tracks.filter((x) => x.kind === 'video' && x.nal && x.firstSize)) {
      try {
        const s = await read(blob, t.firstOffset, t.firstOffset + Math.min(t.firstSize, 1048576));
        const txt = seiText(s, t.nal.len, t.nal.hevc);
        if (txt) a.fields.push(field('In-stream', 'Encoder information inside the video stream (track ' + t.id + ')', txt, { remaining: true, reason: 'Remaining: In-stream metadata (inside the encoded video; not removed without re-encoding)' }));
      } catch (e) { /* ignore */ }
    }

    // Top-level boxes
    const topPatches = [];
    for (const x of top) {
      if (x.type === 'moov' || x.type === 'mdat' || x.type === 'ftyp') continue;
      if (x.type === 'free' || x.type === 'skip' || x.type === 'wide') {
        const len = x.end - x.start - x.hs;
        if (len <= 0) continue;
        let dirty = false;
        for (let o = x.start + x.hs; o < x.end && o < x.start + x.hs + CONFIG.maxGapCheck && !dirty; o += CONFIG.chunk) {
          dirty = !isZero(await read(blob, o, Math.min(x.end, o + CONFIG.chunk)));
        }
        if (dirty) {
          a.fields.push(field('Hidden data', 'Leftover data in free space', fmtBytes(len)));
          topPatches.push({ start: x.start + x.hs, end: x.end, head: null, why: 'free' });
        }
        continue;
      }
      if (x.type === '(trailing)') {
        const t = await read(blob, x.start, Math.min(x.end, x.start + 1048576));
        if (!isZero(t)) {
          a.fields.push(field('Hidden data', 'Data after the end of the video structure', fmtBytes(x.end - x.start) + (printable(t, 4) ? ' · ' + clip(printable(t, 4), 120) : '')));
          a.blobs.push({ source: 'trailing data', text: printable(t, 4) });
          topPatches.push({ start: x.start, end: x.end, head: null, why: 'trailing' });
        }
        continue;
      }
      if (x.type === 'pssh' || FRAGMENT_BOXES.has(x.type)) continue;
      const len = x.end - x.start;
      const body = await read(blob, x.start + x.hs, Math.min(x.end, x.start + x.hs + CONFIG.maxBoxRead));
      if (x.type === 'uuid') {
        a.uuids.push(x.uuid);
        const kn = UUIDS[x.uuid];
        const payload = body.subarray(16);
        if (x.uuid === UUID_C2PA) {
          const gens = c2paGenerators(payload);
          a.fields.push(field('C2PA', 'Content Credentials (C2PA)', 'Manifest found (' + fmtBytes(len) + ')' + (gens.length ? ' · created with: ' + gens.join(', ') : ''), { sensitive: true }));
          a.blobs.push({ source: 'C2PA manifest', text: printable(payload, 4) });
        } else if (x.uuid === UUID_XMP) {
          a.fields.push.apply(a.fields, xmpFields(utf8.decode(payload), ''));
        } else {
          a.fields.push(field(kn ? kn[0] : 'Vendor data', kn ? kn[1] : 'Vendor data (uuid ' + x.uuid.slice(0, 8) + '…)', printable(payload, 4) || fmtBytes(len)));
        }
      } else if (x.type === 'meta' || x.type === 'udta') {
        const whole = await read(blob, x.start, Math.min(x.end, x.start + CONFIG.maxBoxRead));
        const n = { type: x.type, start: 0, end: whole.length, hs: x.hs };
        a.fields.push.apply(a.fields, x.type === 'meta' ? metaFields(whole, n, '', a.blobs) : udtaFields(whole, n, '', a.blobs));
      } else if (PREVIEW_BOXES.has(x.type)) {
        a.fields.push(field('Cover art', 'Embedded preview image (' + label(x.type) + ')', fmtBytes(len)));
      } else {
        a.fields.push(field('Vendor data', 'Unknown box "' + label(x.type) + '"', printable(body, 4) || fmtBytes(len)));
        a.blobs.push({ source: 'box ' + x.type, text: printable(body, 4) });
      }
      const head = new Uint8Array(x.hs);
      if (x.hs === 16) { head.set([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65]); const hi = Math.floor(len / 4294967296); head.set([hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], 8); }
      else head.set([len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, 0x66, 0x72, 0x65, 0x65]);
      topPatches.push({ start: x.start, end: x.end, head, why: x.type });
    }

    // Unreferenced bytes inside mdat (only when every track's byte ranges are exact)
    if (!a.tracks.some((t) => t.conservative) && !(a.unsupported && a.unsupported.code === 'fragmented')) {
      const used = mergeRanges([].concat(...a.tracks.map((t) => t.merged)));
      const gaps = [];
      for (const [ms, me] of mdats) {
        let o = ms;
        for (const [s, e] of used) {
          if (e <= ms || s >= me) continue;
          if (s > o) gaps.push([o, s]);
          o = Math.max(o, e);
        }
        if (o < me) gaps.push([o, me]);
      }
      const total = gaps.reduce((n, g) => n + g[1] - g[0], 0);
      if (total && total <= CONFIG.maxGapCheck) {
        let dirty = 0, sample = '';
        for (const [s, e] of gaps) {
          for (let o = s; o < e; o += CONFIG.chunk) {
            const d = await read(blob, o, Math.min(e, o + CONFIG.chunk));
            if (!isZero(d)) { dirty += d.length; if (sample.length < 200) sample += printable(d, 4).slice(0, 200); }
          }
        }
        if (dirty) {
          a.fields.push(field('Hidden data', 'Unreferenced data inside the media area', fmtBytes(total) + (sample ? ' · ' + clip(sample, 120) : '')));
          if (sample) a.blobs.push({ source: 'unreferenced data', text: sample });
          for (const [s, e] of gaps) topPatches.push({ start: s, end: e, head: null, why: 'gap' });
        }
      } else if (total > CONFIG.maxGapCheck) {
        a.fields.push(field('Hidden data', 'Unreferenced data inside the media area (not checked)', fmtBytes(total), { remaining: true, reason: 'Remaining — too large to inspect in the browser' }));
      }
    }

    // Removed metadata tracks: zero their sample bytes
    for (const t of a.tracks.filter((x) => x.remove)) for (const [s, e] of t.merged) topPatches.push({ start: s, end: e, head: null, why: 'meta-samples' });

    // Safety: no patch may touch kept media samples.
    for (const p of topPatches) {
      if (overlaps(a.keptRanges, p.start, p.end) || (p.start < moovBox.end && p.end > moovBox.start)) {
        fail('unsafe', 'Metadata requires unsafe modification (it overlaps the video/audio data). The file was not modified.');
      }
    }
    a.plan.patches = topPatches;
    a.plan.moovEdits = edits;
    a.moovBytes = mb;

    // Properties
    const v = a.tracks.find((t) => t.kind === 'video' && !t.remove);
    const au = a.tracks.find((t) => t.kind === 'audio');
    a.props = {
      duration: mts.timescale ? mts.duration / mts.timescale : 0,
      timescale: mts.timescale,
      video: v ? { codec: v.codec, format: v.format, width: v.codedWidth || Math.round(v.width), height: v.codedHeight || Math.round(v.height), displayWidth: Math.round(v.width), displayHeight: Math.round(v.height), rotation: v.rotation, fps: v.fps, hdr: !!v.hdr } : null,
      audio: au ? { codec: au.codec, channels: au.channels, sampleRate: au.sampleRate } : null,
      audioTracks: a.tracks.filter((t) => t.kind === 'audio').length,
      videoTracks: a.tracks.filter((t) => t.kind === 'video').length,
    };
    for (const t of a.tracks) t.fp = t.remove ? null : fingerprint(mb, t.node, t.masks);
    if (!v && !au) fail('structure', 'No video or audio track was found.');
    if (onProgress) onProgress(1);
    return finish(a);
  }

  /** JSON values (e.g. ComfyUI {"prompt":{…},"workflow":{…}} in a comment tag): expose nested objects to the AI detector. */
  function jsonBlobs(a) {
    for (const f of a.fields) {
      const t = (f.fullValue || '').trim();
      if (t[0] !== '{' || t.length > 4e6) continue;
      try {
        const obj = JSON.parse(t);
        for (const k of Object.keys(obj)) {
          const v = typeof obj[k] === 'string' && /^\s*[{[]/.test(obj[k]) ? obj[k] : obj[k] && typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : null;
          if (v) a.blobs.push({ source: f.name + ' › ' + k, text: v });
        }
      } catch (e) { /* not JSON */ }
    }
  }

  function finish(a) {
    jsonBlobs(a);
    a.removable = a.fields.filter((f) => !f.remaining);
    a.remainingFields = a.fields.filter((f) => f.remaining);
    a.ai = MC.ai ? MC.ai.detect({ fields: a.fields, blobs: a.blobs }) : { found: false, aiFound: false, ai: [], editors: [], markers: [], params: [], c2pa: false };
    return a;
  }

  // ------------------------------------------------------------------ clean

  /**
   * Build the cleaned file as a Blob made of slices of the original plus the
   * patched bytes. Same size; media samples are never copied or changed.
   */
  function clean(file, a) {
    if (a.unsupported) throw new VideoError(a.unsupported.code, a.unsupported.message);
    const mb = a.moovBytes.slice();
    // Zero fields first, then turn whole boxes into 'free' (so a free header is never zeroed afterwards).
    const ordered = a.plan.moovEdits.filter((x) => x[0] === 'zero').concat(a.plan.moovEdits.filter((x) => x[0] === 'free'));
    for (const [kind, s, e, hs] of ordered) {
      if (kind === 'zero') mb.fill(0, s, e);
      else {
        const len = e - s;
        mb.fill(0, s, e);
        if (hs === 16) { mb.set([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65], s); const hi = Math.floor(len / 4294967296); mb.set([hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], s + 8); }
        else mb.set([len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, 0x66, 0x72, 0x65, 0x65], s);
      }
    }
    const patches = a.plan.patches.map((p) => ({ start: p.start, end: p.end, head: p.head }));
    patches.push({ start: a.plan.moov.start, end: a.plan.moov.end, bytes: mb });
    patches.sort((x, y) => x.start - y.start);
    for (let i = 1; i < patches.length; i++) {
      if (patches[i].start < patches[i - 1].end) throw new VideoError('unsafe', 'Internal check failed: overlapping changes. The file was not modified.');
    }
    const ZERO = new Uint8Array(Math.min(CONFIG.chunk, 1048576));
    const parts = [];
    let o = 0;
    for (const p of patches) {
      if (p.start > o) parts.push(file.slice(o, p.start));
      if (p.bytes) parts.push(p.bytes);
      else {
        let n = p.end - p.start;
        if (p.head) { parts.push(p.head); n -= p.head.length; }
        while (n > 0) { const k = Math.min(n, ZERO.length); parts.push(ZERO.subarray(0, k)); n -= k; }
      }
      o = p.end;
    }
    if (o < file.size) parts.push(file.slice(o));
    const type = file.type || (a.format === 'mov' ? 'video/quicktime' : a.format === 'm4v' ? 'video/x-m4v' : 'video/mp4');
    const out = new Blob(parts, { type });
    if (out.size !== file.size) throw new VideoError('unsafe', 'Internal check failed: size changed. The file was not modified.');
    return out;
  }

  // ------------------------------------------------------------------ verify

  async function sameBytes(x, y, ranges, onProgress, total, doneRef) {
    for (const [s, e] of ranges) {
      for (let o = s; o < e; o += CONFIG.chunk) {
        const end = Math.min(e, o + CONFIG.chunk);
        const [p, q] = await Promise.all([read(x, o, end), read(y, o, end)]);
        for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
        doneRef.n += end - o;
        if (onProgress) onProgress(doneRef.n / total);
      }
    }
    return true;
  }

  function eqBytes(p, q) {
    if (!p || !q || p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
    return true;
  }

  /**
   * Verify the cleaned file from scratch against the original analysis.
   * Returns { ok, checks: [{label, ok, detail}], after }.
   */
  async function verify(original, before, output, onProgress) {
    const checks = [];
    const add = (lbl, ok, detail) => checks.push({ label: lbl, ok: !!ok, detail: detail || '' });
    const after = await analyze(output, before.name);
    if (after.unsupported && after.unsupported.code !== 'unsafe') {
      add('File structure is valid', false, after.unsupported.message);
      return { ok: false, checks, after };
    }
    add('No removable metadata remains', after.removable.length === 0, after.removable.length ? after.removable.map((f) => f.name).slice(0, 5).join(', ') : '');
    add('No C2PA manifest remains', !after.uuids.includes(UUID_C2PA));
    add('No XMP packet remains', !after.uuids.includes(UUID_XMP));
    const topOk = after.top && after.top.length && after.top[after.top.length - 1].end === output.size;
    add('Box sizes and file structure are valid', topOk && output.size === original.size, 'Same size: ' + fmtBytes(output.size));

    const keptBefore = before.tracks.filter((t) => !t.remove);
    const byId = new Map(after.tracks.map((t) => [t.id, t]));
    let offsetsOk = true, tablesOk = true;
    for (const t of keptBefore) {
      const u = byId.get(t.id);
      if (!u) { offsetsOk = false; tablesOk = false; continue; }
      if (JSON.stringify(t.merged) !== JSON.stringify(u.merged)) offsetsOk = false;
      if (!eqBytes(t.fp, u.fp)) tablesOk = false;
    }
    add('Sample offsets are unchanged and valid', offsetsOk && !after.tracks.some((t) => t.merged && t.merged.some(([s, e]) => e > output.size)));

    // Byte-identical media samples, video and audio separately
    const vRanges = mergeRanges([].concat(...keptBefore.filter((t) => t.kind === 'video').map((t) => t.merged)));
    const aRanges = mergeRanges([].concat(...keptBefore.filter((t) => t.kind === 'audio').map((t) => t.merged)));
    const total = [...vRanges, ...aRanges].reduce((n, r) => n + r[1] - r[0], 0) || 1;
    const done = { n: 0 };
    const vSame = await sameBytes(original, output, vRanges, onProgress, total, done);
    const aSame = await sameBytes(original, output, aRanges, onProgress, total, done);
    if (vRanges.length) add('Video sample data is byte-identical', vSame, fmtBytes(vRanges.reduce((n, r) => n + r[1] - r[0], 0)) + ' compared');
    if (aRanges.length) add('Audio sample data is byte-identical', aSame, fmtBytes(aRanges.reduce((n, r) => n + r[1] - r[0], 0)) + ' compared');

    const pv = before.props, pa = after.props;
    add('Codecs unchanged', JSON.stringify([pv.video && pv.video.codec, pv.audio && pv.audio.codec]) === JSON.stringify([pa.video && pa.video.codec, pa.audio && pa.audio.codec]) && tablesOk,
      [pa.video && pa.video.codec, pa.audio && pa.audio.codec].filter(Boolean).join(' + '));
    add('Duration unchanged', pv.duration === pa.duration && keptBefore.every((t) => byId.get(t.id) && byId.get(t.id).duration === t.duration), formatDuration(pa.duration));
    if (pv.video) {
      add('Resolution unchanged', pa.video && pv.video.width === pa.video.width && pv.video.height === pa.video.height && pv.video.rotation === pa.video.rotation, pa.video ? pa.video.width + ' × ' + pa.video.height : '');
      add('Frame rate unchanged', pa.video && pv.video.fps === pa.video.fps, pa.video ? (Math.round(pa.video.fps * 100) / 100) + ' fps' : '');
      add('HDR / color information unchanged', pa.video && pv.video.hdr === pa.video.hdr && tablesOk, pa.video && pa.video.hdr ? 'HDR' : 'SDR');
    }
    if (pv.audioTracks) add('Audio is still present', pa.audioTracks === pv.audioTracks, pa.audioTracks + ' audio track' + (pa.audioTracks === 1 ? '' : 's'));
    return { ok: checks.every((c) => c.ok), checks, after };
  }

  function formatDuration(s) {
    if (!isFinite(s)) return '';
    const m = Math.floor(s / 60), sec = s - m * 60;
    return String(m).padStart(2, '0') + ':' + (sec < 10 ? '0' : '') + sec.toFixed(sec % 1 ? 2 : 0);
  }

  MC.video = { CONFIG, VideoError, isVideoFile, isAppleMobile, maxBytes, analyze, clean, verify, formatDuration, fmtBytes, UUID_C2PA, UUID_XMP };
})(typeof window !== 'undefined' ? window : globalThis);
