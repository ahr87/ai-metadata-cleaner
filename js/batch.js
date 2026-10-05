/* Batch mode: several images in one go.
   This file only orchestrates. Every image goes through the SAME engine as the
   single-image flow: MC.cleaner.analyze → MC.cleaner.clean (which re-scans the
   cleaned file from scratch) → one more independent MC.cleaner.analyze of the
   output. Images are processed one at a time to keep memory use low; only the
   File handles, small summaries and the verified cleaned Blobs are kept. */
(function () {
  'use strict';

  const MC = window.MetaClean;
  const { formatBytes, crc32 } = MC.bin;
  const ui = MC.ui;
  const el = ui.el;
  const $ = (id) => document.getElementById(id);

  const MAX_BATCH = 100;
  const ZIP_NAME = 'ai-metadata-cleaner-cleaned.zip';
  const THUMB = 160;

  const CAT_LABEL = {
    EXIF: 'EXIF', GPS: 'GPS', IPTC: 'IPTC', XMP: 'XMP', 'PNG text': 'PNG text', Comment: 'Comment',
    Thumbnail: 'Thumbnail', Photoshop: 'Photoshop', C2PA: 'C2PA', Other: 'Hidden data',
  };
  const STATUS_LABEL = {
    queued: 'Queued', analyzing: 'Analyzing', ready: 'Ready', cleaning: 'Cleaning', verifying: 'Verifying',
    verified: 'Verified', warning: 'Warning', failed: 'Failed',
  };

  let items = [];
  let run = 0; // bumps on reset so an in-flight loop stops touching the page
  let zip = null; // { blob, url, name, count }
  let skipped = 0;

  const tick = () => new Promise((r) => setTimeout(r, 0)); // let the page repaint between images

  // ------------------------------------------------------------ rendering

  function setStatus(item, status, detail) {
    item.status = status;
    if (detail !== undefined) item.detail = detail;
    renderItem(item);
  }

  function renderItem(item) {
    const s = item.summary;
    const lines = [];
    if (s) {
      lines.push(el('p', { class: 'bi-meta', text: s.width + ' × ' + s.height + ' · ' + ui.FORMAT_LABEL[s.format] + ' · ' + formatBytes(item.file.size) }));
      lines.push(el('p', { class: 'bi-meta', text: s.count ? s.count + ' metadata ' + (s.count === 1 ? 'field' : 'fields') + ' found' : 'No removable metadata found' }));
      if (s.tags.length) lines.push(el('p', { class: 'bi-tags' }, s.tags.map((t) => el('span', { class: 'tag' + (/AI|C2PA|GPS/.test(t) ? ' hot' : ''), text: t }))));
    } else {
      lines.push(el('p', { class: 'bi-meta', text: formatBytes(item.file.size) }));
    }
    const r = item.result;
    if (r) lines.push(el('p', { class: 'bi-result', text: 'Before: ' + r.before + ' · Removed: ' + r.removed + ' · Remaining: ' + r.remaining }));
    if (item.detail) lines.push(el('p', { class: 'bi-detail', text: item.detail }));

    const thumb = el('div', { class: 'bi-thumb' }, item.thumb ? [el('img', { src: item.thumb, alt: '' })] : []);
    const node = el('li', { class: 'bi bi-' + item.status, 'data-status': item.status }, [
      thumb,
      el('div', { class: 'bi-body' }, [
        el('div', { class: 'bi-top' }, [
          el('p', { class: 'bi-name', text: item.file.name }),
          el('span', { class: 'pill pill-' + item.status, text: STATUS_LABEL[item.status] }),
        ]),
      ].concat(lines)),
    ]);
    if (item.node) item.node.replaceWith(node);
    item.node = node;
  }

  function setProgress(verb, done, total) {
    const box = $('batchProgress');
    if (!verb) { box.hidden = true; return; }
    box.hidden = false;
    $('batchProgressText').textContent = verb + ' ' + Math.min(done + 1, total) + ' of ' + total + ' images…';
    $('batchBar').style.width = Math.round((done / total) * 100) + '%';
  }

  function count(status) {
    return items.filter((i) => i.status === status).length;
  }

  function setTitle() {
    const n = items.length;
    const ready = count('ready');
    let t = n + ' Images Selected';
    if (ready && ready === n) t = n + ' Images Ready';
    else if (ready) t = ready + ' of ' + n + ' Images Ready';
    $('batchTitle').textContent = t;
  }

  // ------------------------------------------------------------ analysis

  function summarize(info, display) {
    const cats = new Set(info.removable.map((f) => f.category));
    const tags = [];
    if (info.ai.aiFound) tags.push('AI metadata');
    if (cats.has('C2PA')) tags.push('C2PA');
    for (const c of ['GPS', 'EXIF', 'IPTC', 'XMP', 'PNG text', 'Thumbnail', 'Comment', 'Photoshop', 'Other']) if (cats.has(c)) tags.push(CAT_LABEL[c]);
    if (info.ai.editors.length && !tags.includes('AI metadata')) tags.push('Software info');
    return { format: info.format, width: display.width, height: display.height, count: info.removable.length, tags };
  }

  async function makeThumb(img) {
    try {
      const { width, height } = MC.cleaner.dims(img);
      const scale = Math.min(1, THUMB / Math.max(width, height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(width * scale));
      c.height = Math.max(1, Math.round(height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      return blob ? ui.objectUrl(blob) : null;
    } catch (e) {
      return null;
    }
  }

  async function analyzeItem(item) {
    const f = item.file;
    if (f.size === 0) throw new Error('This file is empty.');
    if (f.size > ui.MAX_FILE) throw new Error('Too large (' + formatBytes(f.size) + '). The maximum size is 50 MB.');
    let bytes = new Uint8Array(await f.arrayBuffer());
    const format = MC.formats.detectFormat(bytes);
    if (!ui.FORMAT_LABEL[format]) throw new Error(ui.unsupportedMessage(format, f).join(' '));
    let info;
    try {
      info = await MC.cleaner.analyze(bytes);
    } catch (e) {
      if (e.code === 'corrupt') throw new Error('The image appears to be damaged or incomplete. ' + e.message);
      throw new Error('The image could not be analyzed.');
    }
    let img;
    try {
      img = await MC.cleaner.decode(bytes, format);
    } catch (e) {
      throw new Error('Your browser could not open this image.');
    }
    bytes = null;
    const display = MC.cleaner.dims(img);
    item.thumb = await makeThumb(img);
    if (img.close) img.close();
    item.summary = summarize(info, display);
    item.display = display;
  }

  async function analyzeAll(myRun) {
    ui.setBusy(true);
    for (let i = 0; i < items.length; i++) {
      if (myRun !== run) return;
      const item = items[i];
      setProgress('Analyzing', i, items.length);
      setStatus(item, 'analyzing');
      await tick();
      try {
        await analyzeItem(item);
        if (myRun !== run) return;
        setStatus(item, 'ready', '');
      } catch (e) {
        if (myRun !== run) return;
        setStatus(item, 'failed', e.message || 'Could not be read.');
      }
      setTitle();
    }
    setProgress(null);
    ui.setBusy(false);
    setTitle();
    $('cleanCard').hidden = !items.some((i) => i.status !== 'failed');
    if (!count('ready')) ui.showError('None of the selected files can be cleaned.', 'See the reason shown on each file.');
  }

  // ------------------------------------------------------------ cleaning

  async function cleanItem(item, mode, myRun) {
    let bytes = new Uint8Array(await item.file.arrayBuffer());
    // Existing engine, exactly as in the single-image flow.
    const before = await MC.cleaner.analyze(bytes);
    const res = await MC.cleaner.clean(bytes, before, mode);
    bytes = null;
    if (myRun !== run) return;

    setStatus(item, 'verifying');
    await tick();
    // Independent re-scan of the exact output bytes that will go into the ZIP.
    const again = await MC.cleaner.analyze(res.bytes);
    const v = res.verification;
    const remaining = Math.max(v.remaining, again.removable.length);
    const aiLeft = res.after.ai.found || again.ai.found;

    item.result = {
      before: v.before,
      removed: v.removed,
      remaining,
      blob: new Blob([res.bytes], { type: res.mime }),
      crc: crc32(res.bytes),
      size: res.bytes.length,
      name: ui.cleanName(item.file.name, res.format),
    };
    const notes = [];
    if (res.mode !== mode) notes.push('Animated image: Metadata Only was used.');
    if (res.format !== before.format) notes.push('Saved as ' + ui.FORMAT_LABEL[res.format] + ' (browser cannot save ' + ui.FORMAT_LABEL[before.format] + ').');
    const vis = res.visual;
    if (vis && !vis.error && (vis.width !== item.display.width || vis.height !== item.display.height)) notes.push('Dimensions changed: ' + vis.width + ' × ' + vis.height + '.');

    if (remaining || aiLeft) {
      const left = again.removable.map((f) => f.name).slice(0, 4).join(', ');
      setStatus(item, 'warning', 'Some metadata could not be removed' + (left ? ': ' + left : '') + '. Not included in the ZIP.');
    } else {
      setStatus(item, 'verified', notes.join(' '));
    }
  }

  async function cleanAll(mode) {
    const myRun = run;
    const todo = items.filter((i) => i.summary); // every image that analyzed successfully
    if (!todo.length) return;
    ui.clearError();
    $('batchResultCard').hidden = true;
    revokeZip();
    ui.setBusy(true);
    for (const i of todo) { i.result = null; setStatus(i, 'queued', ''); }
    await tick();

    for (let n = 0; n < todo.length; n++) {
      if (myRun !== run) return;
      const item = todo[n];
      setProgress('Cleaning', n, todo.length);
      setStatus(item, 'cleaning');
      await tick();
      try {
        await cleanItem(item, mode, myRun);
      } catch (e) {
        if (myRun !== run) return;
        console.error(e);
        item.result = null;
        setStatus(item, 'failed', (e && e.message) || 'Cleaning failed.');
      }
    }
    if (myRun !== run) return;
    setProgress(null);
    ui.setBusy(false);
    finish(mode);
  }

  // ------------------------------------------------------------ result + ZIP

  function revokeZip() {
    if (zip && zip.url) URL.revokeObjectURL(zip.url);
    zip = null;
  }

  function finish(mode) {
    $('batchTitle').textContent = items.length + ' Images Processed';
    const verified = items.filter((i) => i.status === 'verified');
    const warnings = count('warning');
    const failed = count('failed');
    const cleaned = verified.length + warnings;

    const rows = [
      [items.length, 'Images Processed', ''],
      [cleaned, 'Cleaned', ''],
      [verified.length, 'Verified', 'ok'],
      [failed, 'Failed', failed ? 'bad' : ''],
    ];
    if (warnings) rows.splice(3, 0, [warnings, 'Warnings', 'warn']);
    const summary = $('batchSummary');
    summary.replaceChildren(
      el('p', { class: 'mode-used', text: 'Mode: ' + (mode === 'deep' ? 'Deep Clean' : 'Metadata Only') + ' · every file was re-scanned after cleaning' }),
      el('div', { class: 'stats batch-stats' }, rows.map(([n, l, cls]) => el('div', { class: 'stat ' + cls }, [el('div', { class: 'num', text: String(n) }), el('div', { class: 'lbl', text: l })])))
    );
    if (failed || warnings) {
      summary.appendChild(el('div', { class: 'alert alert-warn section', text: (failed ? failed + ' image' + (failed === 1 ? '' : 's') + ' failed' : '') + (failed && warnings ? ' and ' : '') + (warnings ? warnings + ' still contain' + (warnings === 1 ? 's' : '') + ' some metadata' : '') + '. ' + (verified.length ? 'Only the verified images are in the ZIP.' : '') }));
    }
    if (items.some((i) => i.status === 'verified' && i.summary && i.summary.tags.some((t) => t === 'AI metadata' || t === 'C2PA'))) {
      summary.appendChild(el('div', { class: 'alert alert-info section' }, [
        el('p', { text: 'AI-related metadata and provenance information found inside the files have been removed where technically possible.' }),
        el('p', { text: 'This does not guarantee that social media platforms will stop identifying the images as AI-generated.' }),
      ]));
    }

    const btn = $('zipBtn');
    $('zipStatus').hidden = true;
    revokeZip();
    if (verified.length) {
      try {
        const names = MC.zip.uniqueNames(verified.map((i) => i.result.name));
        const entries = verified.map((i, k) => ({ name: names[k], data: i.result.blob, crc: i.result.crc, size: i.result.size }));
        const blob = MC.zip.buildZip(entries);
        zip = { blob, url: URL.createObjectURL(blob), names };
        btn.href = zip.url;
        btn.download = ZIP_NAME;
        btn.hidden = false;
        $('zipName').textContent = ZIP_NAME + ' · ' + verified.length + ' image' + (verified.length === 1 ? '' : 's') + ' · ' + formatBytes(blob.size);
      } catch (e) {
        btn.hidden = true;
        $('zipName').textContent = '';
        ui.showError('The ZIP file could not be created.', e.message);
      }
    } else {
      btn.hidden = true;
      $('zipName').textContent = 'No verified images to download.';
    }
    $('batchResultCard').hidden = false;
    $('batchResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setZipStatus(text, ok) {
    const p = $('zipStatus');
    p.textContent = text;
    p.className = 'download-status ' + (ok ? 'ok' : 'warn');
    p.hidden = false;
  }

  // Inside the Claude artifact viewer plain download links are blocked; hand the ZIP to its save prompt.
  async function saveZipInViewer(e) {
    if (!ui.inViewer || !zip) return;
    e.preventDefault();
    const api = ui.downloads();
    if (!api) return setZipStatus('Saving is not available in this view.', false);
    try {
      await api.save({ filename: ZIP_NAME, data: zip.blob });
      setZipStatus('✓ Saved: ' + ZIP_NAME, true);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') setZipStatus('Save cancelled.', false);
      else if (code === 'extension_not_enabled' || code === 'rejected_extension') setZipStatus('ZIP files cannot be saved in this view. Open the app in Safari or Chrome instead.', false);
      else setZipStatus('The ZIP could not be saved here' + (code ? ' (' + code + ')' : '') + '.', false);
    }
  }

  // ------------------------------------------------------------ public

  function start(fileList) {
    run++;
    let files = fileList;
    skipped = Math.max(0, files.length - MAX_BATCH);
    files = files.slice(0, MAX_BATCH);
    items = files.map((file, idx) => ({ id: idx, file, status: 'queued', detail: '', summary: null, result: null, thumb: null, node: null }));
    const list = $('batchList');
    list.replaceChildren();
    for (const it of items) { renderItem(it); list.appendChild(it.node); }
    document.body.classList.add('batch-mode');
    $('dropzone').classList.add('compact');
    $('deepNote').textContent = ui.deepNoteDefault;
    $('batchCard').hidden = false;
    $('cleanTitle').textContent = 'Clean All Images';
    setTitle();
    if (skipped) ui.showError('Only the first ' + MAX_BATCH + ' images were added.', skipped + ' more were skipped. Please clean them in another batch.');
    analyzeAll(run);
  }

  function reset() {
    run++;
    revokeZip();
    items = [];
    skipped = 0;
    $('batchList').replaceChildren();
    $('batchCard').hidden = true;
    $('batchResultCard').hidden = true;
    $('batchProgress').hidden = true;
    document.body.classList.remove('batch-mode');
  }

  $('zipBtn').addEventListener('click', saveZipInViewer);

  MC.batch = { start, cleanAll, reset, _items: () => items, _zip: () => zip };
})();
