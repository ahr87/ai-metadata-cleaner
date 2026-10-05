/* Minimal ZIP writer (no compression, "stored"). Images are already compressed,
   so storing keeps it fast and exact: every file inside the ZIP is byte-for-byte
   the verified cleaned file. Runs entirely in the browser; no dependencies.
   Output opens with Windows File Explorer, macOS Finder and the iOS Files app. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});
  const MAX_ZIP = 0xffffffff - 1024 * 1024; // classic ZIP (no ZIP64) limit, with headroom

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  function header(size) {
    const buf = new ArrayBuffer(size);
    return { buf, view: new DataView(buf) };
  }

  /**
   * @param entries [{ name: string, data: Blob, crc: number, size: number }]
   * @returns Blob (application/zip)
   */
  function buildZip(entries, now) {
    const { time, date } = dosDateTime(now || new Date());
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const local = header(30);
      const v = local.view;
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true); // version needed
      v.setUint16(6, 0x0800, true); // UTF-8 file names
      v.setUint16(8, 0, true); // stored
      v.setUint16(10, time, true);
      v.setUint16(12, date, true);
      v.setUint32(14, e.crc >>> 0, true);
      v.setUint32(18, e.size, true);
      v.setUint32(22, e.size, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, 0, true);
      parts.push(local.buf, name, e.data);

      const cd = header(46);
      const c = cd.view;
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true); // made by (MS-DOS / FAT)
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, e.crc >>> 0, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(cd.buf, name);

      offset += 30 + name.length + e.size;
      if (offset > MAX_ZIP) throw new Error('The cleaned images are too large to fit in one ZIP file (4 GB limit).');
    }

    let cdSize = 0;
    for (const p of central) cdSize += p.byteLength;
    const end = header(22);
    const z = end.view;
    z.setUint32(0, 0x06054b50, true);
    z.setUint16(8, entries.length, true);
    z.setUint16(10, entries.length, true);
    z.setUint32(12, cdSize, true);
    z.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end.buf]), { type: 'application/zip' });
  }

  /** Make names unique (case-insensitive, like Windows): a_clean.jpg, a_clean_2.jpg, … */
  function uniqueNames(names) {
    const used = new Set();
    return names.map((n) => {
      const m = /^(.*?)(\.[^.]*)?$/.exec(n);
      let candidate = n;
      for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = m[1] + '_' + i + (m[2] || '');
      used.add(candidate.toLowerCase());
      return candidate;
    });
  }

  MC.zip = { buildZip, uniqueNames };
})(typeof window !== 'undefined' ? window : globalThis);
