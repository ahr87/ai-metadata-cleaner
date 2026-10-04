/* Cleaning pipeline: analyze → clean (metadata-only or deep) → re-analyze → compare. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});
  const { analyzeBytes, stripBytes, detectFormat } = MC.formats;

  const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const JPEG_QUALITY = 0.95;
  const MAX_DEEP_PIXELS = 120e6; // stay well below browser canvas limits
  const MAX_COMPARE_PIXELS = 50e6;

  function countable(fields) {
    return fields.filter((f) => !f.keep && !f.derived);
  }

  async function analyze(bytes) {
    const info = await analyzeBytes(bytes);
    info.ai = MC.ai.detect(info);
    info.removable = countable(info.fields);
    info.kept = info.fields.filter((f) => f.keep);
    return info;
  }

  // ------------------------------------------------------------ decoding helpers (browser)

  async function decode(bytes, format) {
    const blob = new Blob([bytes], { type: MIME[format] });
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      // Some browsers reject the options object; fall back to <img>.
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function dims(img) {
    return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  }

  function canvasFor(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image.'))), type, quality);
    });
  }

  function pixels(img) {
    const { width, height } = dims(img);
    const c = canvasFor(width, height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  }

  /** Compare the decoded pixels of two images. */
  function comparePixels(a, b) {
    const da = dims(a), db = dims(b);
    if (da.width !== db.width || da.height !== db.height) return { sameSize: false };
    if (da.width * da.height > MAX_COMPARE_PIXELS) return { sameSize: true, skipped: true };
    const pa = pixels(a), pb = pixels(b);
    let maxDiff = 0, sum = 0, sq = 0;
    for (let i = 0; i < pa.length; i++) {
      const d = Math.abs(pa[i] - pb[i]);
      if (d) {
        sum += d;
        sq += d * d;
        if (d > maxDiff) maxDiff = d;
      }
    }
    const n = pa.length;
    const mse = sq / n;
    return {
      sameSize: true,
      identical: maxDiff === 0,
      meanDiff: sum / n,
      maxDiff,
      psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    };
  }

  // ------------------------------------------------------------ cleaning

  async function metadataOnly(bytes) {
    const out = await stripBytes(bytes, { keepOrientation: true, keepIcc: true });
    return { bytes: out, format: detectFormat(out), notes: [] };
  }

  async function deepClean(bytes, info) {
    const notes = [];
    const pixelsCount = info.width * info.height;
    if (pixelsCount > MAX_DEEP_PIXELS) {
      const e = new Error('This image is too large (' + Math.round(pixelsCount / 1e6) + ' megapixels) for Deep Clean in the browser. Use “Metadata Only” instead.');
      e.code = 'too-large-deep';
      throw e;
    }
    const img = await decode(bytes, info.format);
    const { width, height } = dims(img);
    const canvas = canvasFor(width, height);
    const ctx = canvas.getContext('2d', { alpha: info.format !== 'jpeg' });
    ctx.drawImage(img, 0, 0);
    if (img.close) img.close();

    let format = info.format;
    let quality;
    if (format === 'jpeg') quality = JPEG_QUALITY;
    if (format === 'webp') quality = info.webpLossless ? 1 : JPEG_QUALITY;
    let blob = await toBlob(canvas, MIME[format], quality);
    if (blob.type !== MIME[format]) {
      // e.g. Safari cannot encode WebP; it silently returns PNG.
      notes.push('Your browser cannot save WebP files, so the clean image was saved as lossless PNG.');
      format = 'png';
      blob = await toBlob(canvas, 'image/png');
    }
    canvas.width = canvas.height = 0; // free memory

    // Belt and braces: also strip anything the browser's encoder may have written.
    const encoded = new Uint8Array(await blob.arrayBuffer());
    const out = await stripBytes(encoded, { keepOrientation: false, keepIcc: true });
    if (format === 'jpeg' || (format === 'webp' && quality < 1)) {
      notes.push('The image was re-saved at ' + Math.round(JPEG_QUALITY * 100) + '% quality. This can cause very minor compression differences that are normally invisible.');
    }
    if (info.orientation > 1) notes.push('The photo’s rotation was applied to the pixels, so it displays the same way without a rotation flag.');
    if (info.kept.some((f) => f.category === 'Color profile' && !/srgb/i.test(f.value))) {
      notes.push('Colors were converted to standard sRGB (the embedded color profile is not carried over).');
    }
    return { bytes: out, format: detectFormat(out), notes };
  }

  // ------------------------------------------------------------ verification

  function key(f) {
    return f.category + '\u0000' + f.name + '\u0000' + f.fullValue;
  }

  const CHECKS = [
    ['EXIF', 'EXIF'],
    ['GPS', 'GPS / location'],
    ['IPTC', 'IPTC'],
    ['XMP', 'XMP'],
    ['PNG text', 'PNG text metadata'],
    ['Comment', 'Comments'],
    ['Thumbnail', 'Embedded thumbnails'],
    ['Photoshop', 'Photoshop data'],
    ['C2PA', 'C2PA / Content Credentials'],
    ['Other', 'Other hidden data'],
  ];

  function verify(before, after) {
    const beforeFields = before.removable;
    const afterFields = after.removable;
    const afterKeys = new Set(afterFields.map(key));
    const removedCount = beforeFields.filter((f) => !afterKeys.has(key(f))).length;

    const checks = [];
    for (const [cat, label] of CHECKS) {
      const had = beforeFields.some((f) => f.category === cat);
      const has = afterFields.some((f) => f.category === cat);
      if (had || has) checks.push({ label, ok: !has, had });
    }
    if (before.ai.aiFound || after.ai.aiFound) {
      checks.push({ label: 'AI-related metadata', ok: !after.ai.aiFound, had: before.ai.aiFound });
    }
    if (before.ai.editors.length || after.ai.editors.length) {
      checks.push({ label: 'Software / editing app info', ok: !after.ai.editors.length, had: before.ai.editors.length > 0 });
    }

    return {
      before: beforeFields.length,
      removed: removedCount,
      remaining: afterFields.length,
      remainingFields: afterFields,
      kept: after.kept,
      checks,
      clean: afterFields.length === 0 && !after.ai.found,
    };
  }

  /**
   * Full pipeline. `before` is the analysis of the original bytes.
   * Returns everything the UI needs to show the result.
   */
  async function clean(bytes, before, mode) {
    let usedMode = mode;
    const notes = [];
    if (mode === 'deep' && before.animated) {
      usedMode = 'metadata';
      notes.push('This is an animated image. Deep Clean would keep only the first frame, so Metadata Only was used instead.');
    }
    const result = usedMode === 'deep' ? await deepClean(bytes, before) : await metadataOnly(bytes);
    notes.push.apply(notes, result.notes);

    // Re-read the NEW file from scratch – never assume the cleaning worked.
    const after = await analyze(result.bytes);
    const verification = verify(before, after);

    let visual = null;
    try {
      const a = await decode(bytes, before.format);
      const b = await decode(result.bytes, result.format);
      visual = comparePixels(a, b);
      visual.width = dims(b).width;
      visual.height = dims(b).height;
      if (a.close) a.close();
      if (b.close) b.close();
    } catch (e) {
      visual = { error: 'The cleaned image could not be decoded for comparison.' };
    }

    return { mode: usedMode, bytes: result.bytes, format: result.format, mime: MIME[result.format], notes, after, verification, visual };
  }

  MC.cleaner = { analyze, clean, decode, dims, MIME, JPEG_QUALITY };
})(typeof window !== 'undefined' ? window : globalThis);
