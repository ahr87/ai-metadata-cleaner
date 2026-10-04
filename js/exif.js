/* EXIF (TIFF structure), IPTC-IIM / Photoshop resources, and XMP parsing. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});
  const { u16, u32, ascii, text, clip } = MC.bin;

  // ---------------------------------------------------------------- EXIF

  const IFD0_TAGS = {
    0x010e: 'Image Description', 0x010f: 'Camera Make', 0x0110: 'Camera Model', 0x0112: 'Orientation',
    0x011a: 'X Resolution', 0x011b: 'Y Resolution', 0x0128: 'Resolution Unit', 0x0131: 'Software',
    0x0132: 'Date/Time Modified', 0x013b: 'Artist', 0x013c: 'Host Computer', 0x013e: 'White Point',
    0x013f: 'Primary Chromaticities', 0x0211: 'YCbCr Coefficients', 0x0213: 'YCbCr Positioning',
    0x0214: 'Reference Black/White', 0x02bc: 'Embedded XMP', 0x4746: 'Rating', 0x4749: 'Rating Percent',
    0x8298: 'Copyright', 0x83bb: 'Embedded IPTC', 0x8773: 'Embedded ICC Profile', 0x927c: 'Maker Note',
    0x9c9b: 'Windows Title', 0x9c9c: 'Windows Comment', 0x9c9d: 'Windows Author', 0x9c9e: 'Windows Keywords',
    0x9c9f: 'Windows Subject', 0xa480: 'GDAL Metadata', 0xc4a5: 'Print Image Matching', 0xea1c: 'Padding',
    0x0100: 'Image Width', 0x0101: 'Image Height', 0x0102: 'Bits Per Sample', 0x0103: 'Compression',
    0x0106: 'Photometric Interpretation', 0x0115: 'Samples Per Pixel', 0x011c: 'Planar Configuration',
    0x0201: 'Thumbnail Offset', 0x0202: 'Thumbnail Length',
  };

  const EXIF_TAGS = {
    0x829a: 'Exposure Time', 0x829d: 'F-Number', 0x8822: 'Exposure Program', 0x8827: 'ISO',
    0x8830: 'Sensitivity Type', 0x9000: 'EXIF Version', 0x9003: 'Date/Time Original',
    0x9004: 'Date/Time Digitized', 0x9010: 'Time Zone Offset', 0x9011: 'Time Zone Offset (Original)',
    0x9012: 'Time Zone Offset (Digitized)', 0x9101: 'Components Configuration', 0x9102: 'Compressed Bits/Pixel',
    0x9201: 'Shutter Speed', 0x9202: 'Aperture', 0x9203: 'Brightness', 0x9204: 'Exposure Bias',
    0x9205: 'Max Aperture', 0x9206: 'Subject Distance', 0x9207: 'Metering Mode', 0x9208: 'Light Source',
    0x9209: 'Flash', 0x920a: 'Focal Length', 0x9214: 'Subject Area', 0x927c: 'Maker Note',
    0x9286: 'User Comment', 0x9290: 'Sub-second Time', 0x9291: 'Sub-second Time (Original)',
    0x9292: 'Sub-second Time (Digitized)', 0xa000: 'FlashPix Version', 0xa001: 'Color Space',
    0xa002: 'Pixel Width', 0xa003: 'Pixel Height', 0xa004: 'Related Sound File', 0xa20e: 'Focal Plane X Res',
    0xa20f: 'Focal Plane Y Res', 0xa210: 'Focal Plane Res Unit', 0xa215: 'Exposure Index',
    0xa217: 'Sensing Method', 0xa300: 'File Source', 0xa301: 'Scene Type', 0xa302: 'CFA Pattern',
    0xa401: 'Custom Rendered', 0xa402: 'Exposure Mode', 0xa403: 'White Balance', 0xa404: 'Digital Zoom',
    0xa405: 'Focal Length (35mm)', 0xa406: 'Scene Capture Type', 0xa407: 'Gain Control', 0xa408: 'Contrast',
    0xa409: 'Saturation', 0xa40a: 'Sharpness', 0xa40c: 'Subject Distance Range', 0xa420: 'Image Unique ID',
    0xa430: 'Camera Owner Name', 0xa431: 'Camera Serial Number', 0xa432: 'Lens Specification',
    0xa433: 'Lens Make', 0xa434: 'Lens Model', 0xa435: 'Lens Serial Number', 0xa460: 'Composite Image',
    0xa500: 'Gamma', 0xea1c: 'Padding', 0xea1d: 'Offset Schema',
  };

  const GPS_TAGS = {
    0x00: 'GPS Version', 0x01: 'GPS Latitude Ref', 0x02: 'GPS Latitude', 0x03: 'GPS Longitude Ref',
    0x04: 'GPS Longitude', 0x05: 'GPS Altitude Ref', 0x06: 'GPS Altitude', 0x07: 'GPS Time (UTC)',
    0x08: 'GPS Satellites', 0x09: 'GPS Status', 0x0a: 'GPS Measure Mode', 0x0b: 'GPS Precision',
    0x0c: 'GPS Speed Ref', 0x0d: 'GPS Speed', 0x0e: 'GPS Track Ref', 0x0f: 'GPS Track',
    0x10: 'GPS Image Direction Ref', 0x11: 'GPS Image Direction', 0x12: 'GPS Map Datum',
    0x17: 'GPS Dest Bearing Ref', 0x18: 'GPS Dest Bearing', 0x1b: 'GPS Processing Method',
    0x1c: 'GPS Area Information', 0x1d: 'GPS Date', 0x1e: 'GPS Differential', 0x1f: 'GPS H. Positioning Error',
  };

  const POINTER_TAGS = { 0x8769: 'exif', 0x8825: 'gps', 0xa005: 'interop', 0x014a: 'subifd' };
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const SENSITIVE = /GPS|Serial|Owner|Artist|Author|Copyright|Make|Model|Date|Time Zone|Host|Unique|User Comment|Description|Software/;

  function readValue(b, le, type, count, valOff) {
    const size = TYPE_SIZE[type] || 1;
    if (valOff + size * count > b.length) return null;
    if (type === 2) return ascii(b, valOff, count).replace(/\0+$/, '');
    if (type === 1 || type === 7 || type === 6) return b.subarray(valOff, valOff + count);
    const out = [];
    const n = Math.min(count, 64);
    for (let i = 0; i < n; i++) {
      const o = valOff + i * size;
      if (type === 3) out.push(u16(b, o, le));
      else if (type === 8) out.push((u16(b, o, le) << 16) >> 16);
      else if (type === 4 || type === 13) out.push(u32(b, o, le));
      else if (type === 9) out.push(u32(b, o, le) | 0);
      else if (type === 5 || type === 10) {
        let num = u32(b, o, le), den = u32(b, o + 4, le);
        if (type === 10) { num |= 0; den |= 0; }
        out.push(den ? num / den : 0);
      } else out.push(0);
    }
    return out;
  }

  function ucs2(bytes) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const c = bytes[i] | (bytes[i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function displayValue(tag, raw) {
    if (raw == null) return '';
    if (tag === 0x9286 && raw instanceof Uint8Array) {
      // User Comment: 8-byte character code prefix
      const code = ascii(raw, 0, 8).replace(/\0/g, '').trim().toUpperCase();
      const body = raw.subarray(8);
      if (code === 'UNICODE') {
        // Byte order is not specified; guess by looking for zero bytes.
        const be = body.length > 1 && body[0] === 0 && body[1] !== 0;
        let s = '';
        for (let i = 0; i + 1 < body.length; i += 2) {
          const c = be ? (body[i] << 8) | body[i + 1] : body[i] | (body[i + 1] << 8);
          s += String.fromCharCode(c);
        }
        return s.replace(/\0+$/, '').trim();
      }
      return text(body).replace(/\0+$/, '').trim();
    }
    if (tag >= 0x9c9b && tag <= 0x9c9f && raw instanceof Uint8Array) return ucs2(raw);
    if (raw instanceof Uint8Array) {
      if (raw.length > 32) return '[' + raw.length + ' bytes of binary data]';
      // Short undefined values are usually version strings ("0230") or flags.
      const s = ascii(raw, 0, raw.length);
      return /^[\x20-\x7e]+$/.test(s) ? s : Array.from(raw).join(' ');
    }
    if (Array.isArray(raw)) {
      return raw.map((v) => (Number.isInteger(v) ? v : +v.toFixed(4))).join(', ');
    }
    return String(raw);
  }

  function gpsDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length < 3) return null;
    let v = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (ref === 'S' || ref === 'W') v = -v;
    return v;
  }

  /**
   * Parse a TIFF/EXIF block (starting at the "II*\0" / "MM\0*" header).
   * Returns { fields, orientation, thumbnail: {offset,length}|null }.
   */
  function parseTiff(b) {
    const result = { fields: [], orientation: 1, thumbnail: null, ok: false };
    if (b.length < 8) return result;
    const order = ascii(b, 0, 2);
    if (order !== 'II' && order !== 'MM') return result;
    const le = order === 'II';
    if (u16(b, 2, le) !== 42) return result;
    result.ok = true;

    const visited = new Set();
    const gps = {};
    let thumbOffset = 0, thumbLength = 0;

    function walk(offset, kind, depth) {
      if (depth > 4 || offset < 8 || offset + 2 > b.length || visited.has(offset)) return 0;
      visited.add(offset);
      const count = u16(b, offset, le);
      if (count > 1000 || offset + 2 + count * 12 > b.length) return 0;
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        const tag = u16(b, e, le);
        const type = u16(b, e + 2, le);
        const n = u32(b, e + 4, le);
        const size = (TYPE_SIZE[type] || 1) * n;
        if (!TYPE_SIZE[type] || size > b.length) continue;
        const valOff = size <= 4 ? e + 8 : u32(b, e + 8, le);

        if (kind !== 'gps' && kind !== 'interop' && POINTER_TAGS[tag]) {
          const sub = POINTER_TAGS[tag];
          const target = u32(b, e + 8, le);
          if (sub === 'interop') {
            result.fields.push(field('EXIF', 'Interoperability Info', 'present'));
          } else if (sub === 'subifd') {
            result.fields.push(field('EXIF', 'Sub-image directory', 'present'));
          } else {
            walk(target, sub, depth + 1);
          }
          continue;
        }

        const raw = readValue(b, le, type, n, valOff);
        if (kind === 'ifd1') {
          if (tag === 0x0201) thumbOffset = Array.isArray(raw) ? raw[0] : 0;
          if (tag === 0x0202) thumbLength = Array.isArray(raw) ? raw[0] : 0;
          continue;
        }
        if (kind === 'interop') continue;

        let name;
        let category = 'EXIF';
        if (kind === 'gps') {
          name = GPS_TAGS[tag] || 'GPS tag 0x' + tag.toString(16);
          category = 'GPS';
          gps[tag] = raw;
        } else if (kind === 'exif') {
          name = EXIF_TAGS[tag] || IFD0_TAGS[tag] || 'EXIF tag 0x' + tag.toString(16);
        } else {
          name = IFD0_TAGS[tag] || EXIF_TAGS[tag] || 'EXIF tag 0x' + tag.toString(16);
        }

        if (kind === 'ifd0' && tag === 0x0112 && Array.isArray(raw)) {
          result.orientation = raw[0] || 1;
          result.fields.push(field('EXIF', 'Orientation', String(raw[0]), { keep: true, note: 'Rotation flag' }));
          continue;
        }
        if (tag === 0x927c) {
          result.fields.push(field('EXIF', 'Maker Note', '[' + n + ' bytes of manufacturer data]', { sensitive: true }));
          continue;
        }
        const value = displayValue(tag, raw);
        result.fields.push(field(category, name, value, { sensitive: category === 'GPS' || SENSITIVE.test(name) }));
      }
      const nextPtr = offset + 2 + count * 12;
      return nextPtr + 4 <= b.length ? u32(b, nextPtr, le) : 0;
    }

    const ifd1 = walk(u32(b, 4, le), 'ifd0', 0);
    if (ifd1) walk(ifd1, 'ifd1', 0);

    if (thumbOffset && thumbLength) {
      result.thumbnail = { offset: thumbOffset, length: thumbLength };
      result.fields.push(field('Thumbnail', 'Embedded EXIF thumbnail', MC.bin.formatBytes(thumbLength), { sensitive: true }));
    }

    const lat = gpsDecimal(gps[2], gps[1]);
    const lon = gpsDecimal(gps[4], gps[3]);
    if (lat != null && lon != null) {
      result.location = { lat, lon };
      result.fields.push(field('GPS', 'Location (decoded)', lat.toFixed(5) + ', ' + lon.toFixed(5), { sensitive: true, derived: true }));
    }
    return result;
  }

  /** Build a minimal EXIF TIFF block that only contains the Orientation tag. */
  function buildOrientationTiff(orientation) {
    const b = new Uint8Array(26);
    b.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]); // "MM", 42, IFD0 at offset 8
    b.set([0, 1], 8); // one entry
    b.set([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, orientation & 255, 0, 0], 10);
    // next IFD offset = 0 (already zero)
    return b;
  }

  function field(category, name, value, extra) {
    const f = { category, name, value: clip(value == null ? '' : value, 400), fullValue: value == null ? '' : String(value) };
    if (extra) Object.assign(f, extra);
    return f;
  }

  // ---------------------------------------------------------------- IPTC / Photoshop

  const IPTC_NAMES = {
    '1:90': 'Coded Character Set', '2:0': 'Record Version', '2:3': 'Object Type', '2:5': 'Object Name / Title',
    '2:7': 'Edit Status', '2:10': 'Urgency', '2:12': 'Subject Reference', '2:15': 'Category',
    '2:20': 'Supplemental Categories', '2:22': 'Fixture ID', '2:25': 'Keywords', '2:26': 'Location Code',
    '2:27': 'Location Name', '2:30': 'Release Date', '2:35': 'Release Time', '2:40': 'Special Instructions',
    '2:55': 'Date Created', '2:60': 'Time Created', '2:62': 'Digital Creation Date',
    '2:63': 'Digital Creation Time', '2:65': 'Originating Program', '2:70': 'Program Version',
    '2:80': 'By-line (Creator)', '2:85': 'By-line Title', '2:90': 'City', '2:92': 'Sub-location',
    '2:95': 'Province/State', '2:100': 'Country Code', '2:101': 'Country', '2:103': 'Job Identifier',
    '2:105': 'Headline', '2:110': 'Credit', '2:115': 'Source', '2:116': 'Copyright Notice',
    '2:118': 'Contact', '2:120': 'Caption / Description', '2:122': 'Caption Writer',
    '2:135': 'Language',
  };

  function parseIIM(b) {
    const fields = [];
    let o = 0;
    while (o + 5 <= b.length) {
      if (b[o] !== 0x1c) { o++; continue; }
      const rec = b[o + 1], ds = b[o + 2];
      let len = u16(b, o + 3, false);
      let start = o + 5;
      if (len & 0x8000) {
        const n = len & 0x7fff;
        if (n > 4 || start + n > b.length) break;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + b[start + i];
        start += n;
      }
      if (start + len > b.length) break;
      const key = rec + ':' + ds;
      const data = b.subarray(start, start + len);
      const name = IPTC_NAMES[key] || 'IPTC ' + key;
      const value = rec === 1 && ds === 90 ? 'charset marker' : text(data);
      fields.push(field('IPTC', name, value, { sensitive: /City|Country|Province|location|Creator|Copyright|Contact|Credit|Program/i.test(name) }));
      o = start + len;
    }
    return fields;
  }

  const PS_RESOURCES = {
    0x0404: 'IPTC', 0x040f: 'ICC Profile', 0x0409: 'Thumbnail (old)', 0x040c: 'Thumbnail',
    0x0422: 'EXIF data 1', 0x0423: 'EXIF data 3', 0x0424: 'XMP', 0x0425: 'Caption digest',
    0x03ed: 'Resolution info', 0x0421: 'Version info', 0x0406: 'JPEG quality', 0x040a: 'Copyright flag',
    0x040b: 'URL', 0x041a: 'Slices', 0x0426: 'Print scale', 0x0428: 'Pixel aspect ratio', 0x0414: 'Document ID',
    0x041e: 'URL list', 0x043a: 'Print info', 0x043b: 'Print style', 0x0bb7: 'Clipping path name',
  };

  /** Parse an APP13 "Photoshop 3.0" block (8BIM resources). */
  function parsePhotoshop(b) {
    const fields = [];
    let o = 0;
    const others = [];
    while (o + 12 <= b.length) {
      if (ascii(b, o, 4) !== '8BIM') break;
      const id = u16(b, o + 4, false);
      const nameLen = b[o + 6];
      let p = o + 6 + 1 + nameLen;
      if ((nameLen + 1) % 2) p++;
      if (p + 4 > b.length) break;
      const size = u32(b, p, false);
      const dataStart = p + 4;
      if (dataStart + size > b.length) break;
      const data = b.subarray(dataStart, dataStart + size);
      if (id === 0x0404) {
        fields.push.apply(fields, parseIIM(data));
      } else if (id === 0x0409 || id === 0x040c) {
        fields.push(field('Thumbnail', 'Photoshop thumbnail', MC.bin.formatBytes(size), { sensitive: true }));
      } else if (id === 0x0424) {
        fields.push.apply(fields, parseXmp(text(data)));
      } else {
        others.push(PS_RESOURCES[id] || '0x' + id.toString(16));
      }
      o = dataStart + size + (size % 2);
    }
    if (others.length) {
      fields.push(field('Photoshop', 'Photoshop image resources', others.join(', ')));
    }
    return fields;
  }

  // ---------------------------------------------------------------- XMP

  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return XML_ENTITIES[e] || m;
    });
  }

  const SKIP_PREFIX = { xmlns: 1, rdf: 1, x: 1, xml: 1 };
  const CONTAINER = /^(rdf:|x:xmpmeta|x:xapmeta)/;

  /**
   * Lightweight XMP reader. Extracts property name/value pairs from both
   * attribute form (prefix:Name="value") and element form.
   */
  function parseXmp(xml) {
    const fields = [];
    const seen = new Set();
    if (!xml || xml.indexOf('<') < 0) return fields;
    const body = xml.replace(/<\?xpacket[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');

    function add(name, value) {
      value = unescapeXml(String(value)).replace(/\s+/g, ' ').trim();
      const key = name + '=' + value;
      if (seen.has(key)) return;
      seen.add(key);
      const prefix = name.split(':')[0];
      const local = name.split(':')[1] || '';
      let category = 'XMP';
      if (/^GPS/i.test(local) || /^(exif|exifEX)$/.test(prefix) && /GPS/i.test(local)) category = 'GPS';
      fields.push(field(category, name, value, {
        sensitive: category === 'GPS' || /creator|author|rights|CreatorTool|softwareAgent|Location|City|Country|Owner|Serial|Date/i.test(local),
      }));
    }

    // Attribute form.
    const attrRe = /\s([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(body))) {
      if (SKIP_PREFIX[m[1]]) continue;
      add(m[1] + ':' + m[2], m[4] != null ? m[4] : m[5]);
    }

    // Element form (leaf or rdf container with li items).
    const elRe = /<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(\s[^>]*?)?(\/?)>/g;
    while ((m = elRe.exec(body))) {
      const qn = m[1] + ':' + m[2];
      if (m[4] === '/' || SKIP_PREFIX[m[1]] || CONTAINER.test(qn)) continue;
      const close = '</' + qn + '>';
      const end = body.indexOf(close, elRe.lastIndex);
      if (end < 0) continue;
      const inner = body.slice(elRe.lastIndex, end);
      // Skip structures whose children are other XMP properties (they get their own entries).
      if (/<[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*[\s>]/.test(inner.replace(/<\/?rdf:[^>]*>/g, ''))) continue;
      const items = [];
      const liRe = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g;
      let li;
      while ((li = liRe.exec(inner))) items.push(li[1].replace(/<[^>]+>/g, ''));
      const value = items.length ? items.join('; ') : inner.replace(/<[^>]+>/g, '');
      if (value.trim()) add(qn, value);
    }

    if (!fields.length) fields.push(field('XMP', 'XMP packet', 'present (no readable properties)'));
    return fields;
  }

  MC.exif = { parseTiff, buildOrientationTiff, parseIIM, parsePhotoshop, parseXmp, field };
})(typeof window !== 'undefined' ? window : globalThis);
