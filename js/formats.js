/* Container-level parsing and metadata stripping for JPEG, PNG and WebP. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});
  const { u16, u32, ascii, latin1, text, startsWith, concat, writeU32BE, writeU32LE, crc32, inflate, formatBytes } = MC.bin;
  const { parseTiff, buildOrientationTiff, parsePhotoshop, parseXmp, field } = MC.exif;

  class FormatError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function detectFormat(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'png';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
      const brand = ascii(b, 8, 4);
      if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
      if (/^(avif|avis)$/.test(brand)) return 'avif';
    }
    if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'gif';
    if (b.length >= 4 && (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*')) return 'tiff';
    if (b.length >= 2 && ascii(b, 0, 2) === 'BM') return 'bmp';
    return 'unknown';
  }

  /** Printable ASCII runs from a binary blob (used to look for software names). */
  function printable(b, limit) {
    const s = latin1(b.length > 2e6 ? b.subarray(0, 2e6) : b);
    const runs = s.match(/[\x20-\x7e]{4,}/g) || [];
    const out = runs.join('\n');
    return out.length > (limit || 200000) ? out.slice(0, limit || 200000) : out;
  }

  /** Try to read "claim_generator" (a CBOR text string) from a C2PA manifest. */
  function c2paGenerators(b) {
    const s = latin1(b.length > 4e6 ? b.subarray(0, 4e6) : b);
    const found = new Set();
    let idx = s.indexOf('claim_generator');
    let guard = 0;
    while (idx >= 0 && guard++ < 20) {
      const p = idx + 'claim_generator'.length;
      const h = s.charCodeAt(p);
      let len = -1, start = p + 1;
      if (h >= 0x60 && h <= 0x77) len = h - 0x60;
      else if (h === 0x78) { len = s.charCodeAt(p + 1); start = p + 2; }
      else if (h === 0x79) { len = (s.charCodeAt(p + 1) << 8) | s.charCodeAt(p + 2); start = p + 3; }
      if (len > 0 && len < 500) {
        const v = s.slice(start, start + len);
        if (/^[\x20-\x7e]+$/.test(v)) found.add(v);
      }
      idx = s.indexOf('claim_generator', idx + 1);
    }
    return Array.from(found);
  }

  function c2paField(b, where) {
    const gens = c2paGenerators(b);
    let value = 'Manifest found (' + formatBytes(b.length) + ')';
    if (gens.length) value += ' · created with: ' + gens.join(', ');
    return field('C2PA', 'Content Credentials (C2PA)' + (where ? ' – ' + where : ''), value, { sensitive: true });
  }

  // =================================================================== JPEG

  function jpegSegmentId(b, seg) {
    return ascii(b, seg.dataStart, Math.min(40, seg.end - seg.dataStart));
  }

  function parseJpegStructure(b) {
    const segments = [];
    let o = 2;
    let eoi = -1;
    let width = 0, height = 0;
    while (o < b.length) {
      if (b[o] !== 0xff) throw new FormatError('corrupt', 'Unexpected data inside the JPEG structure.');
      while (b[o + 1] === 0xff && o + 2 < b.length) o++; // fill bytes
      const m = b[o + 1];
      const mStart = o;
      o += 2;
      if (m === 0xd9) { eoi = o; break; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        segments.push({ marker: m, start: mStart, end: o, dataStart: o });
        continue;
      }
      if (o + 2 > b.length) break;
      const len = u16(b, o, false);
      if (len < 2 || o + len > b.length) throw new FormatError('corrupt', 'A JPEG segment is truncated or damaged.');
      const seg = { marker: m, start: mStart, dataStart: o + 2, end: o + len };
      o = seg.end;
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && !width) {
        height = u16(b, seg.dataStart + 1, false);
        width = u16(b, seg.dataStart + 3, false);
      }
      if (m === 0xda) {
        // Entropy-coded data runs until the next real marker.
        let p = o;
        while (p + 1 < b.length) {
          if (b[p] === 0xff) {
            const n = b[p + 1];
            if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p += 2; continue; }
            if (n === 0xff) { p += 1; continue; }
            break;
          }
          p++;
        }
        if (p + 1 >= b.length) p = b.length;
        seg.end = p;
        o = p;
      }
      segments.push(seg);
    }
    return { segments, eoi, width, height };
  }

  function analyzeJpeg(b) {
    const { segments, eoi, width, height } = parseJpegStructure(b);
    if (!segments.some((s) => s.marker === 0xda)) throw new FormatError('corrupt', 'The JPEG has no image data.');
    const fields = [];
    const blobs = [];
    const problems = [];
    let orientation = 1;
    let c2paParts = [];
    let extXmp = {};

    for (const seg of segments) {
      const m = seg.marker;
      const data = b.subarray(seg.dataStart, seg.end);
      if (m < 0xe0 && m !== 0xfe) continue; // structural
      const id = jpegSegmentId(b, seg);
      seg.kind = 'meta';

      if (m === 0xe0 && startsWith(data, 0, 'JFIF\0')) {
        seg.kind = 'jfif';
        if (data.length >= 14 && data[12] * data[13] > 0) {
          fields.push(field('Thumbnail', 'JFIF thumbnail', data[12] + '×' + data[13] + ' px'));
        }
      } else if (m === 0xe0 && startsWith(data, 0, 'JFXX\0')) {
        fields.push(field('Thumbnail', 'JFIF extension thumbnail', formatBytes(data.length)));
      } else if (m === 0xe1 && startsWith(data, 0, 'Exif\0')) {
        const tiff = parseTiff(data.subarray(6));
        if (tiff.ok) {
          orientation = tiff.orientation;
          fields.push.apply(fields, tiff.fields);
          if (!tiff.fields.length) fields.push(field('EXIF', 'EXIF block', 'present (empty)'));
        } else {
          fields.push(field('EXIF', 'EXIF block', 'present (unreadable, ' + formatBytes(data.length) + ')'));
        }
      } else if (m === 0xe1 && startsWith(data, 0, 'http://ns.adobe.com/xap/1.0/\0')) {
        const xml = text(data.subarray(29));
        fields.push.apply(fields, parseXmp(xml));
      } else if (m === 0xe1 && startsWith(data, 0, 'http://ns.adobe.com/xmp/extension/\0')) {
        const guid = ascii(data, 35, 32);
        (extXmp[guid] = extXmp[guid] || []).push({ off: u32(data, 71, false), bytes: data.subarray(75) });
      } else if (m === 0xe2 && startsWith(data, 0, 'ICC_PROFILE\0')) {
        seg.kind = 'icc';
        if (data[12] === 1) fields.push(field('Color profile', 'ICC color profile', iccDescription(data.subarray(14)), { keep: true, note: 'Needed for correct colors' }));
      } else if (m === 0xe2 && startsWith(data, 0, 'MPF\0')) {
        fields.push(field('Thumbnail', 'Multi-picture index (MPF)', 'Points to extra embedded images'));
      } else if (m === 0xeb) {
        if (startsWith(data, 0, 'JP')) c2paParts.push(data.subarray(8));
        else fields.push(field('Other', 'APP11 data', id.replace(/[^\x20-\x7e]/g, '').slice(0, 30) || formatBytes(data.length)));
      } else if (m === 0xed && startsWith(data, 0, 'Photoshop 3.0\0')) {
        const ps = parsePhotoshop(data.subarray(14));
        fields.push.apply(fields, ps.length ? ps : [field('Photoshop', 'Photoshop block', 'present')]);
      } else if (m === 0xee && startsWith(data, 0, 'Adobe')) {
        seg.kind = 'adobe'; // color transform flag – required for decoding some JPEGs
      } else if (m === 0xfe) {
        fields.push(field('Comment', 'JPEG comment', text(data), { sensitive: true }));
        blobs.push({ source: 'JPEG comment', text: text(data) });
      } else {
        const label = id.split('\0')[0].replace(/[^\x20-\x7e]/g, '').slice(0, 30);
        const appName = m === 0xec && label === 'Ducky' ? 'Photoshop "Save for Web" data' : 'APP' + (m - 0xe0) + ' segment';
        fields.push(field('Other', appName, (label ? '"' + label + '" · ' : '') + formatBytes(data.length)));
        blobs.push({ source: appName, text: printable(data) });
      }
    }

    for (const guid in extXmp) {
      const parts = extXmp[guid].sort((a, b2) => a.off - b2.off).map((p) => p.bytes);
      const xml = text(concat(parts));
      fields.push.apply(fields, parseXmp(xml).map((f) => Object.assign(f, { name: f.name + ' (extended)' })));
    }

    if (c2paParts.length) {
      const all = concat(c2paParts);
      fields.push(c2paField(all));
      blobs.push({ source: 'C2PA manifest', text: printable(all) });
    }

    let trailer = null;
    if (eoi < 0) {
      problems.push('The file ends unexpectedly (no JPEG end marker). It may be truncated.');
    } else if (eoi < b.length) {
      const rest = b.subarray(eoi);
      if (rest.some((x) => x !== 0)) {
        trailer = rest;
        const extraJpeg = rest.length > 4 && latin1(rest.subarray(0, Math.min(rest.length, 65536))).indexOf('\xff\xd8\xff') >= 0;
        fields.push(field('Other', extraJpeg ? 'Extra images after end of file' : 'Hidden data after end of image', formatBytes(rest.length), { sensitive: true }));
        blobs.push({ source: 'Trailing data', text: printable(rest, 50000) });
      }
    }

    return { format: 'jpeg', width, height, fields, blobs, problems, orientation, animated: false, trailer };
  }

  function iccDescription(icc) {
    // Find the 'desc' tag in the ICC tag table.
    try {
      const count = u32(icc, 128, false);
      for (let i = 0; i < Math.min(count, 100); i++) {
        const t = 132 + i * 12;
        if (ascii(icc, t, 4) === 'desc') {
          const off = u32(icc, t + 4, false);
          const type = ascii(icc, off, 4);
          if (type === 'desc') {
            const len = u32(icc, off + 8, false);
            return ascii(icc, off + 12, Math.min(len, 100)).replace(/\0.*$/, '');
          }
          if (type === 'mluc') {
            const recLen = u32(icc, off + 20, false);
            const recOff = u32(icc, off + 24, false);
            let s = '';
            for (let k = 0; k < Math.min(recLen, 200); k += 2) s += String.fromCharCode(u16(icc, off + recOff + k, false));
            return s.replace(/\0.*$/, '');
          }
        }
      }
    } catch (e) { /* fall through */ }
    return 'present';
  }

  function segmentBytes(b, seg) {
    return b.subarray(seg.start, seg.end);
  }

  function app1Exif(tiff) {
    const len = 2 + 6 + tiff.length;
    return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 255]), new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff]);
  }

  /**
   * Remove all metadata segments while copying the compressed image data
   * byte-for-byte. Keeps: JFIF header (without thumbnail), ICC profile,
   * Adobe color-transform marker, and (optionally) the orientation flag.
   */
  function stripJpeg(b, opts) {
    const info = analyzeJpeg(b);
    const { segments } = parseJpegStructure(b);
    const parts = [new Uint8Array([0xff, 0xd8])];
    const jfif = segments.find((s) => s.marker === 0xe0 && startsWith(b, s.dataStart, 'JFIF\0'));
    if (jfif && jfif.end - jfif.dataStart >= 14) {
      const d = b.slice(jfif.dataStart, jfif.dataStart + 14);
      d[12] = 0; d[13] = 0; // no thumbnail
      parts.push(new Uint8Array([0xff, 0xe0, 0, 16]), d);
    }
    if (opts.keepOrientation && info.orientation > 1 && info.orientation <= 8) {
      parts.push(app1Exif(buildOrientationTiff(info.orientation)));
    }
    for (const seg of segments) {
      const m = seg.marker;
      if (seg === jfif) continue;
      const isApp = (m >= 0xe0 && m <= 0xef) || m === 0xfe;
      if (isApp) {
        const keepIcc = m === 0xe2 && startsWith(b, seg.dataStart, 'ICC_PROFILE\0') && opts.keepIcc !== false;
        const keepAdobe = m === 0xee && startsWith(b, seg.dataStart, 'Adobe');
        if (!keepIcc && !keepAdobe) continue;
      }
      parts.push(segmentBytes(b, seg));
    }
    parts.push(new Uint8Array([0xff, 0xd9]));
    return concat(parts);
  }

  // =================================================================== PNG

  const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);

  function parsePngChunks(b) {
    const chunks = [];
    let o = 8;
    let iend = -1;
    while (o + 12 <= b.length) {
      const len = u32(b, o, false);
      const type = ascii(b, o + 4, 4);
      if (!/^[A-Za-z]{4}$/.test(type) || o + 12 + len > b.length) throw new FormatError('corrupt', 'A PNG chunk is truncated or damaged.');
      chunks.push({ type, start: o, dataStart: o + 8, end: o + 12 + len, len });
      o += 12 + len;
      if (type === 'IEND') { iend = o; break; }
    }
    if (!chunks.length || chunks[0].type !== 'IHDR') throw new FormatError('corrupt', 'The PNG header is missing or damaged.');
    if (!chunks.some((c) => c.type === 'IDAT')) throw new FormatError('corrupt', 'The PNG has no image data.');
    return { chunks, iend };
  }

  async function readPngText(type, data) {
    const nul = data.indexOf(0);
    if (nul < 0) return { key: '(no keyword)', value: text(data) };
    const key = latin1(data.subarray(0, nul));
    if (type === 'tEXt') return { key, value: latin1(data.subarray(nul + 1)) };
    if (type === 'zTXt') {
      try { return { key, value: latin1(await inflate(data.subarray(nul + 2))) }; }
      catch (e) { return { key, value: '[compressed text could not be read]' }; }
    }
    // iTXt
    const compressed = data[nul + 1] === 1;
    let p = nul + 3;
    const langEnd = data.indexOf(0, p);
    const lang = langEnd > 0 ? latin1(data.subarray(p, langEnd)) : '';
    p = langEnd + 1;
    const tkEnd = data.indexOf(0, p);
    p = tkEnd + 1;
    let body = data.subarray(p);
    if (compressed) {
      try { body = await inflate(body); } catch (e) { return { key, value: '[compressed text could not be read]' }; }
    }
    return { key, value: text(body), lang };
  }

  const PNG_CHUNK_NAMES = {
    tIME: 'Last-modified time (tIME)', pHYs: 'Pixel density / DPI (pHYs)', sPLT: 'Suggested palette (sPLT)',
    hIST: 'Palette histogram (hIST)', oFFs: 'Image offset (oFFs)', pCAL: 'Pixel calibration (pCAL)',
    sCAL: 'Physical scale (sCAL)', dSIG: 'Digital signature (dSIG)', iDOT: 'Apple decoding hint (iDOT)',
    vpAg: 'Virtual page (vpAg)', sTER: 'Stereo layout (sTER)', gIFg: 'GIF control (gIFg)', gIFx: 'GIF extension (gIFx)',
  };

  async function analyzePng(b) {
    const { chunks, iend } = parsePngChunks(b);
    const ihdr = chunks[0];
    const width = u32(b, ihdr.dataStart, false);
    const height = u32(b, ihdr.dataStart + 4, false);
    const fields = [];
    const blobs = [];
    const problems = [];
    let orientation = 1;
    let animated = false;

    for (const c of chunks) {
      const data = b.subarray(c.dataStart, c.dataStart + c.len);
      if (c.type === 'acTL') animated = true;
      if (c.type === 'iCCP') {
        const nul = data.indexOf(0);
        fields.push(field('Color profile', 'ICC color profile', nul > 0 ? latin1(data.subarray(0, nul)) : 'present', { keep: true, note: 'Needed for correct colors' }));
        continue;
      }
      if (PNG_KEEP.has(c.type)) continue;

      if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
        const t = await readPngText(c.type, data);
        if (t.key === 'XML:com.adobe.xmp') {
          fields.push.apply(fields, parseXmp(t.value));
        } else {
          fields.push(field('PNG text', t.key + ' (' + c.type + ')', t.value, { sensitive: true, key: t.key }));
        }
        blobs.push({ source: 'PNG ' + c.type + ' "' + t.key + '"', key: t.key, text: t.value });
      } else if (c.type === 'eXIf') {
        const tiff = parseTiff(data);
        if (tiff.ok) {
          orientation = tiff.orientation;
          fields.push.apply(fields, tiff.fields);
          if (!tiff.fields.length) fields.push(field('EXIF', 'EXIF block (eXIf)', 'present (empty)'));
        } else fields.push(field('EXIF', 'EXIF block (eXIf)', 'present (unreadable)'));
      } else if (c.type === 'caBX') {
        fields.push(c2paField(data));
        blobs.push({ source: 'C2PA manifest', text: printable(data) });
      } else if (c.type === 'tIME' && c.len >= 7) {
        const pad = (n) => String(n).padStart(2, '0');
        fields.push(field('PNG text', PNG_CHUNK_NAMES.tIME, u16(data, 0, false) + '-' + pad(data[2]) + '-' + pad(data[3]) + ' ' + pad(data[4]) + ':' + pad(data[5]) + ':' + pad(data[6])));
      } else if (c.type === 'pHYs' && c.len >= 9) {
        const ppu = u32(data, 0, false);
        fields.push(field('PNG text', PNG_CHUNK_NAMES.pHYs, data[8] === 1 ? Math.round(ppu * 0.0254) + ' DPI' : String(ppu)));
      } else if (/^[A-Z]/.test(c.type)) {
        // Unknown critical chunk: cannot be removed safely.
        fields.push(field('Other', 'Unknown critical chunk "' + c.type + '"', formatBytes(c.len), { keep: true, note: 'Required to decode the file' }));
      } else {
        fields.push(field(PNG_CHUNK_NAMES[c.type] ? 'PNG text' : 'Other', PNG_CHUNK_NAMES[c.type] || 'Private chunk "' + c.type + '"', formatBytes(c.len)));
        blobs.push({ source: 'PNG chunk ' + c.type, text: printable(data) });
      }
    }

    let trailer = null;
    if (iend < 0) problems.push('The file ends unexpectedly (no PNG end chunk). It may be truncated.');
    else if (iend < b.length && b.subarray(iend).some((x) => x !== 0)) {
      trailer = b.subarray(iend);
      fields.push(field('Other', 'Hidden data after end of image', formatBytes(trailer.length), { sensitive: true }));
      blobs.push({ source: 'Trailing data', text: printable(trailer, 50000) });
    }
    return { format: 'png', width, height, fields, blobs, problems, orientation, animated, trailer };
  }

  function pngChunk(type, data) {
    const td = concat([new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]), data]);
    return concat([writeU32BE(data.length), td, writeU32BE(crc32(td))]);
  }

  async function stripPng(b, opts) {
    const info = await analyzePng(b);
    const { chunks } = parsePngChunks(b);
    const parts = [PNG_SIG];
    for (const c of chunks) {
      const keep = PNG_KEEP.has(c.type) || /^[A-Z]/.test(c.type);
      if (c.type === 'iCCP' && opts.keepIcc === false) continue;
      if (keep) parts.push(b.subarray(c.start, c.end));
      if (c.type === 'IHDR' && opts.keepOrientation && info.orientation > 1 && info.orientation <= 8) {
        parts.push(pngChunk('eXIf', buildOrientationTiff(info.orientation)));
      }
    }
    if (!chunks.some((c) => c.type === 'IEND')) parts.push(pngChunk('IEND', new Uint8Array(0)));
    return concat(parts);
  }

  // =================================================================== WebP

  const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

  function parseWebpChunks(b) {
    const chunks = [];
    let o = 12;
    const riffEnd = Math.min(b.length, 8 + u32(b, 4, true));
    while (o + 8 <= riffEnd) {
      const type = ascii(b, o, 4);
      const len = u32(b, o + 4, true);
      if (o + 8 + len > b.length) throw new FormatError('corrupt', 'A WebP chunk is truncated or damaged.');
      chunks.push({ type, start: o, dataStart: o + 8, len, end: o + 8 + len + (len & 1) });
      o += 8 + len + (len & 1);
    }
    if (!chunks.some((c) => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) {
      throw new FormatError('corrupt', 'The WebP has no image data.');
    }
    return { chunks, riffEnd };
  }

  function analyzeWebp(b) {
    const { chunks, riffEnd } = parseWebpChunks(b);
    const fields = [];
    const blobs = [];
    let orientation = 1, width = 0, height = 0, animated = false;
    for (const c of chunks) {
      const d = b.subarray(c.dataStart, c.dataStart + c.len);
      if (c.type === 'VP8X' && c.len >= 10) {
        animated = !!(d[0] & 0x02);
        width = 1 + (d[4] | (d[5] << 8) | (d[6] << 16));
        height = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
      } else if (c.type === 'VP8 ' && !width && c.len >= 10) {
        width = u16(d, 6, true) & 0x3fff;
        height = u16(d, 8, true) & 0x3fff;
      } else if (c.type === 'VP8L' && !width && c.len >= 5) {
        const bits = u32(d, 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      } else if (c.type === 'ICCP') {
        fields.push(field('Color profile', 'ICC color profile', iccDescription(d), { keep: true, note: 'Needed for correct colors' }));
      } else if (c.type === 'EXIF') {
        const tiffData = startsWith(d, 0, 'Exif\0\0') ? d.subarray(6) : d;
        const tiff = parseTiff(tiffData);
        if (tiff.ok) {
          orientation = tiff.orientation;
          fields.push.apply(fields, tiff.fields);
          if (!tiff.fields.length) fields.push(field('EXIF', 'EXIF block', 'present (empty)'));
        } else fields.push(field('EXIF', 'EXIF block', 'present (unreadable)'));
      } else if (c.type === 'XMP ') {
        const xml = text(d);
        fields.push.apply(fields, parseXmp(xml));
      } else if (c.type === 'C2PA') {
        fields.push(c2paField(d));
        blobs.push({ source: 'C2PA manifest', text: printable(d) });
      } else if (!WEBP_KEEP.has(c.type)) {
        fields.push(field('Other', 'Private chunk "' + c.type.trim() + '"', formatBytes(c.len)));
        blobs.push({ source: 'WebP chunk ' + c.type, text: printable(d) });
      }
    }
    let trailer = null;
    if (riffEnd < b.length && b.subarray(riffEnd).some((x) => x !== 0)) {
      trailer = b.subarray(riffEnd);
      fields.push(field('Other', 'Hidden data after end of image', formatBytes(trailer.length), { sensitive: true }));
    }
    const webpLossless = chunks.some((c) => c.type === 'VP8L') && !chunks.some((c) => c.type === 'VP8 ');
    return { format: 'webp', width, height, fields, blobs, problems: [], orientation, animated, trailer, webpLossless };
  }

  function stripWebp(b, opts) {
    const info = analyzeWebp(b);
    const { chunks } = parseWebpChunks(b);
    const parts = [];
    const addOrientation = opts.keepOrientation && info.orientation > 1 && info.orientation <= 8 && chunks.some((c) => c.type === 'VP8X');
    for (const c of chunks) {
      if (!WEBP_KEEP.has(c.type)) continue;
      if (c.type === 'ICCP' && opts.keepIcc === false) continue;
      if (c.type === 'VP8X') {
        const chunk = b.slice(c.start, c.end);
        chunk[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
        if (addOrientation) chunk[8] |= 0x08;
        if (opts.keepIcc === false) chunk[8] &= ~0x20;
        parts.push(chunk);
      } else {
        parts.push(b.subarray(c.start, c.end));
      }
    }
    if (addOrientation) {
      const tiff = buildOrientationTiff(info.orientation);
      parts.push(new Uint8Array([0x45, 0x58, 0x49, 0x46]), writeU32LE(tiff.length), tiff);
      if (tiff.length & 1) parts.push(new Uint8Array([0]));
    }
    const body = concat(parts);
    return concat([new Uint8Array([0x52, 0x49, 0x46, 0x46]), writeU32LE(body.length + 4), new Uint8Array([0x57, 0x45, 0x42, 0x50]), body]);
  }

  // =================================================================== dispatch

  async function analyzeBytes(b) {
    const format = detectFormat(b);
    if (format === 'jpeg') return analyzeJpeg(b);
    if (format === 'png') return analyzePng(b);
    if (format === 'webp') return analyzeWebp(b);
    throw new FormatError('unsupported', format);
  }

  async function stripBytes(b, opts) {
    const format = detectFormat(b);
    if (format === 'jpeg') return stripJpeg(b, opts);
    if (format === 'png') return stripPng(b, opts);
    if (format === 'webp') return stripWebp(b, opts);
    throw new FormatError('unsupported', format);
  }

  MC.formats = { detectFormat, analyzeBytes, stripBytes, FormatError };
})(typeof window !== 'undefined' ? window : globalThis);
