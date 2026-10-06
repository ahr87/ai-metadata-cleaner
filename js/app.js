/* UI wiring. All metadata text is inserted with textContent (never innerHTML),
   because values inside an image file are untrusted. */
(function () {
  'use strict';

  const MC = window.MetaClean;
  const { formatBytes } = MC.bin;
  const MAX_FILE = 50 * 1024 * 1024;
  const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };
  const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

  const CATS = [
    ['EXIF', 'EXIF'],
    ['GPS', 'GPS / Location'],
    ['IPTC', 'IPTC'],
    ['XMP', 'XMP'],
    ['PNG text', 'PNG metadata'],
    ['Comment', 'Comments'],
    ['Thumbnail', 'Embedded thumbnails / previews'],
    ['Photoshop', 'Photoshop data'],
    ['C2PA', 'C2PA / Content Credentials'],
    ['Other', 'Other hidden data'],
  ];

  const $ = (id) => document.getElementById(id);
  const state = { file: null, bytes: null, info: null, display: null, urls: [], busy: false, cleanBlob: null, cleanName: '', batchMode: false, videoMode: false };

  // Inside the Claude artifact viewer, plain <a download> links are blocked, so the
  // verified file is handed to the viewer's own save prompt instead. Locally, the
  // normal download link is used.
  const inViewer = !!(window.claude && typeof window.claude.use === 'function');
  let downloadsApi = null;
  if (inViewer) {
    window.claude.use('downloads').then((d) => { downloadsApi = d; }).catch(() => {});
  }
  const SAVE_EXT = /\.(jpe?g|png|webp)$/i;

  // ------------------------------------------------------------ DOM helper

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else node.setAttribute(k, props[k]);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function objectUrl(blob) {
    const u = URL.createObjectURL(blob);
    state.urls.push(u);
    return u;
  }

  // ------------------------------------------------------------ errors

  function showError(title, detail) {
    const box = $('errorBox');
    box.replaceChildren(el('p', null, [el('strong', { text: title })]));
    if (detail) box.appendChild(el('p', { text: detail }));
    box.hidden = false;
  }

  function clearError() {
    $('errorBox').hidden = true;
  }

  function unsupportedMessage(format, file) {
    if (format === 'heic') return ['HEIC/HEIF photos are not supported yet.', 'Please export the photo as JPG first (on iPhone: Settings › Camera › Formats › Most Compatible).'];
    if (format === 'avif') return ['AVIF images are not supported yet.', 'Supported formats: JPG, PNG and WEBP.'];
    if (format === 'gif' || format === 'tiff' || format === 'bmp') return [format.toUpperCase() + ' files are not supported.', 'Supported formats: JPG, PNG and WEBP.'];
    if (/^image\//.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)) {
      return ['This file does not look like a valid image.', 'It may be corrupted, or its file extension does not match its contents.'];
    }
    return ['This file type is not supported.', 'Please choose a JPG, PNG or WEBP image.'];
  }

  // ------------------------------------------------------------ reset

  function reset() {
    for (const u of state.urls) URL.revokeObjectURL(u);
    Object.assign(state, { file: null, bytes: null, info: null, display: null, urls: [], busy: false, cleanBlob: null, cleanName: '', batchMode: false, videoMode: false });
    if (MC.batch) MC.batch.reset();
    if (MC.videoUI) MC.videoUI.reset();
    $('cleanTitle').textContent = 'Clean Image';
    $('downloadStatus').hidden = true;
    for (const id of ['fileCard', 'reportCard', 'cleanCard', 'resultCard', 'compareCard', 'downloadCard']) $(id).hidden = true;
    $('dropzone').classList.remove('compact');
    $('fileInput').value = '';
    clearError();
    setBusy(false);
    updatePicker();
  }

  /** "Choose Images" when empty; "Add More Images" + "Clear All" once something is selected. */
  function updatePicker() {
    const has = !!state.file || state.videoMode || (state.batchMode && MC.batch && MC.batch.count() > 0);
    $('chooseBtn').textContent = has ? 'Add More Images' : 'Choose Images';
    $('clearAllBtn').hidden = !has;
  }

  // ------------------------------------------------------------ load + analyze

  async function handleFile(file) {
    if (state.busy) return;
    reset();
    if (!file) return;
    if (file.size === 0) return showError('This file is empty.', 'Please choose a different image.');
    if (file.size > MAX_FILE) {
      return showError('This file is too large (' + formatBytes(file.size) + ').', 'The maximum size is 50 MB.');
    }

    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      return showError('The file could not be read.', 'Please try again or choose a different image.');
    }

    const format = MC.formats.detectFormat(bytes);
    if (!FORMAT_LABEL[format]) {
      const [t, d] = unsupportedMessage(format, file);
      return showError(t, d);
    }

    let info;
    try {
      info = await MC.cleaner.analyze(bytes);
    } catch (e) {
      if (e.code === 'corrupt') return showError('This image appears to be damaged or incomplete.', e.message + ' It cannot be cleaned safely.');
      console.error(e);
      return showError('The image could not be analyzed.', 'It may be corrupted or use an unusual format variant.');
    }

    // Make sure the browser can actually display/decode it.
    let display;
    try {
      const img = await MC.cleaner.decode(bytes, format);
      display = MC.cleaner.dims(img);
      if (img.close) img.close();
    } catch (e) {
      return showError('Your browser could not open this image.', 'The file may be corrupted, or it uses a ' + FORMAT_LABEL[format] + ' variant your browser does not support.');
    }

    Object.assign(state, { file, bytes, info, display });
    updatePicker();
    renderFile();
    renderReport();
    renderCleanCard();
  }

  function renderFile() {
    const { file, info, display } = state;
    const url = objectUrl(new Blob([state.bytes], { type: MC.cleaner.MIME[info.format] }));
    $('filePreview').src = url;
    $('fileName').textContent = file.name;
    $('fileSize').textContent = formatBytes(file.size);
    $('fileDims').textContent = display.width + ' × ' + display.height + ' px';
    $('fileFormat').textContent = FORMAT_LABEL[info.format] + (info.animated ? ' (animated)' : '');
    $('fileCard').hidden = false;
    $('dropzone').classList.add('compact');
  }

  // ------------------------------------------------------------ report

  function friendlyExif(name) {
    if (/Camera Make|Camera Model/.test(name)) return 'Camera';
    if (/^Lens/.test(name)) return 'Lens';
    if (/Serial/.test(name)) return 'Serial number';
    if (/Owner/.test(name)) return 'Camera owner';
    if (/Date|Time|Sub-second/.test(name)) return 'Date/time';
    if (/^Software$/.test(name)) return 'Software';
    if (/Host Computer/.test(name)) return 'Device / computer';
    if (/Artist|Author/.test(name)) return 'Artist';
    if (/Copyright/.test(name)) return 'Copyright';
    if (/Description|Title|Subject/.test(name)) return 'Description';
    if (/User Comment|Windows Comment/.test(name)) return 'User comment';
    if (/Keywords/.test(name)) return 'Keywords';
    if (/Maker Note/.test(name)) return 'Maker note (manufacturer data)';
    if (/Embedded/.test(name)) return name;
    if (/Exposure|F-Number|ISO|Aperture|Shutter|Focal|Flash|Metering|White Balance|Brightness|Light|Scene|Gain|Contrast|Saturation|Sharpness|Zoom|Subject/.test(name)) return 'Camera settings';
    return 'Technical tags';
  }

  function groupItems(cat, fields) {
    if (cat === 'EXIF') {
      const last = ['Camera settings', 'Technical tags'];
      const rank = (n) => last.indexOf(n);
      return unique(fields.map((f) => friendlyExif(f.name))).sort((a, b) => rank(a) - rank(b));
    }
    if (cat === 'GPS') {
      const loc = state.info.fields.find((f) => f.derived && f.category === 'GPS');
      return ['Location data found' + (loc ? ': ' + loc.value : '')].concat(unique(fields.map((f) => f.name)).slice(0, 4));
    }
    if (cat === 'C2PA') return fields.map((f) => f.value);
    return unique(fields.map((f) => f.name));
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  function renderGroups(fields) {
    const wrap = el('div', { class: 'groups' });
    for (const [cat, label] of CATS) {
      const fs = fields.filter((f) => f.category === cat);
      if (!fs.length) continue;
      const items = groupItems(cat, fs);
      const shown = items.slice(0, 8);
      const sensitive = cat === 'GPS' || cat === 'C2PA';
      wrap.appendChild(
        el('div', { class: 'group' + (sensitive ? ' sensitive' : '') + (cat === 'C2PA' ? ' wide' : '') }, [
          el('h3', null, [label, el('span', { class: 'count', text: fs.length + (fs.length === 1 ? ' field' : ' fields') })]),
          el('ul', null, shown.map((t) => el('li', { text: t })).concat(items.length > shown.length ? [el('li', { class: 'more', text: '+ ' + (items.length - shown.length) + ' more' })] : [])),
        ])
      );
    }
    return wrap;
  }

  function renderAiBox(ai) {
    if (!ai.found) return null;
    const items = [];
    for (const t of ai.ai) items.push(t.name + ' metadata detected');
    for (const m of ai.markers) items.push(m);
    if (ai.c2pa) items.push('Content Credentials (C2PA provenance) found');
    for (const t of ai.editors) items.push(t.name + ' information found');
    const box = el('div', { class: 'ai-box' }, [el('h3', { text: 'AI / Software' }), el('ul', null, items.map((t) => el('li', { text: t })))]);
    if (ai.params.length) {
      const order = ['Prompt', 'Negative prompt', 'Seed', 'Model', 'Model hash', 'Sampler', 'Scheduler', 'Steps', 'CFG scale', 'Size', 'VAE', 'LoRA', 'Midjourney Job ID', 'Generation parameters', 'Workflow information'];
      const rank = (n) => (order.indexOf(n) < 0 ? 99 : order.indexOf(n));
      const sorted = ai.params.slice().sort((a, b) => rank(a.name) - rank(b.name));
      box.appendChild(el('p', { class: 'kept-note', text: 'Generation details found inside the file:' }));
      box.appendChild(el('dl', { class: 'params' }, sorted.slice(0, 16).map((p) => el('div', { class: 'param' }, [el('dt', { text: p.name }), el('dd', { text: p.value })]))));
    }
    return box;
  }

  function fieldTable(fields) {
    const label = Object.fromEntries(CATS.concat([['Color profile', 'Color profile']]));
    return el('div', { class: 'table-wrap' }, [
      el('table', null, [
        el('thead', null, [el('tr', null, [el('th', { text: 'Group' }), el('th', { text: 'Field' }), el('th', { text: 'Value' })])]),
        el('tbody', null, fields.map((f) =>
          el('tr', { class: f.sensitive ? 'sensitive' : '' }, [
            el('td', { class: 'cat', text: label[f.category] || f.category }),
            el('td', { text: f.name }),
            el('td', { class: 'v', text: f.value || '—' }),
          ])
        )),
      ]),
    ]);
  }

  function keptNote(kept) {
    if (!kept.length) return null;
    const names = unique(kept.map((f) => (f.name === 'Orientation' ? 'rotation flag' : f.name === 'ICC color profile' ? 'color profile (' + f.value + ')' : f.name)));
    return el('p', { class: 'kept-note', text: 'Technical data, not counted as removable metadata: ' + names.join(', ') + '.' });
  }

  function renderReport() {
    const { info } = state;
    const body = $('reportBody');
    body.replaceChildren();
    const fields = info.removable;

    if (!fields.length && !info.ai.found) {
      body.appendChild(el('div', { class: 'empty-state' }, [el('strong', { text: 'No removable metadata detected.' }), 'This image already looks clean. You can still run a clean to be safe.']));
    } else {
      body.appendChild(el('p', { class: 'mode-used', text: fields.length + ' metadata ' + (fields.length === 1 ? 'field' : 'fields') + ' found in this file.' }));
      body.appendChild(renderGroups(fields));
      const ai = renderAiBox(info.ai);
      if (ai) body.appendChild(ai);
      if (fields.length) {
        body.appendChild(el('details', { class: 'fields' }, [el('summary', { text: 'Show all ' + fields.length + ' fields' }), fieldTable(fields)]));
      }
    }
    const k = keptNote(info.kept);
    if (k) body.appendChild(k);
    for (const p of info.problems) body.appendChild(el('div', { class: 'alert alert-warn section', text: p }));
    $('reportCard').hidden = false;
  }

  // ------------------------------------------------------------ clean

  function renderCleanCard() {
    const f = state.info.format;
    const note = $('deepNote');
    if (f === 'png') note.textContent = 'PNG stays lossless — no quality loss.';
    else if (f === 'webp' && state.info.webpLossless) note.textContent = 'This lossless WebP is re-saved losslessly (if your browser supports WebP encoding).';
    else note.textContent = 'Re-saved at high quality (' + Math.round(MC.cleaner.JPEG_QUALITY * 100) + '%). This may cause very minor compression that is normally invisible.';
    if (state.info.animated) note.textContent = 'Not available for animated images — Metadata Only will be used.';
    $('cleanCard').hidden = false;
  }

  function setBusy(busy) {
    state.busy = busy;
    const btn = $('cleanBtn');
    btn.disabled = busy;
    const label = el('span', { class: 'btn-label', text: busy ? 'Cleaning…' : state.batchMode ? 'Clean All' : 'Clean Image' });
    if (busy) btn.replaceChildren(el('span', { class: 'spinner' }), label);
    else btn.replaceChildren(label);
  }

  async function runClean() {
    if (state.batchMode) {
      if (!state.busy) MC.batch.cleanAll(document.querySelector('input[name="mode"]:checked').value);
      return;
    }
    if (!state.bytes || state.busy) return;
    clearError();
    for (const id of ['resultCard', 'compareCard', 'downloadCard']) $(id).hidden = true;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const res = await MC.cleaner.clean(state.bytes, state.info, mode);
      renderResult(res);
    } catch (e) {
      console.error(e);
      if (e.code === 'too-large-deep') showError('Deep Clean is not possible for this image.', e.message);
      else showError('Something went wrong while cleaning.', (e && e.message ? e.message + ' ' : '') + 'Your original file was not changed.');
    } finally {
      setBusy(false);
    }
  }

  function cleanName(name, format) {
    const m = /^(.*?)(\.([^.]+))?$/.exec(name);
    const base = (m[1] || 'image').replace(/[\\/:*?"<>|]+/g, '_');
    let ext = (m[3] || '').toLowerCase();
    const matches = (format === 'jpeg' && /^(jpe?g|jfif)$/.test(ext)) || ext === EXT[format];
    if (!matches) ext = EXT[format];
    return base + '_clean.' + ext;
  }

  function renderResult(res) {
    const v = res.verification;
    const body = $('resultBody');
    body.replaceChildren();

    body.appendChild(el('p', { class: 'mode-used', text: 'Mode: ' + (res.mode === 'deep' ? 'Deep Clean' : 'Metadata Only') + ' · verified by re-scanning the cleaned file' }));

    body.appendChild(el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(v.before) }), el('div', { class: 'lbl', text: 'Before' })]),
      el('div', { class: 'stat removed' }, [el('div', { class: 'num', text: String(v.removed) }), el('div', { class: 'lbl', text: 'Removed' })]),
      el('div', { class: 'stat remaining' + (v.remaining ? ' has' : '') }, [el('div', { class: 'num', text: String(v.remaining) }), el('div', { class: 'lbl', text: 'Remaining' })]),
    ]));

    if (v.checks.length) {
      body.appendChild(el('ul', { class: 'checks' }, v.checks.map((c) =>
        el('li', { class: c.ok ? 'ok' : 'bad' }, [el('span', { class: 'ic', text: c.ok ? '✓' : '!' }), c.label + (c.ok ? ' removed' : ' still present')])
      )));
    }

    if (v.remaining || res.after.ai.found) {
      const box = el('div', { class: 'alert alert-warn section' }, [el('p', null, [el('strong', { text: '⚠ Some metadata could not be removed.' })]), el('p', { text: 'This is exactly what is still inside the cleaned file:' })]);
      body.appendChild(box);
      if (v.remainingFields.length) body.appendChild(el('div', { class: 'section' }, [fieldTable(v.remainingFields)]));
      const aiLeft = renderAiBox(res.after.ai);
      if (aiLeft) body.appendChild(aiLeft);
    } else if (v.before === 0) {
      body.appendChild(el('div', { class: 'alert alert-ok section', text: '✓ The cleaned file contains no removable metadata (none was found in the original either).' }));
    } else {
      body.appendChild(el('div', { class: 'alert alert-ok section', text: '✓ All removable metadata was removed. The new file was scanned again and nothing removable was found.' }));
    }

    if (state.info.ai.aiFound || state.info.ai.c2pa) {
      body.appendChild(el('div', { class: 'alert alert-info section' }, [
        el('p', { text: 'AI-related metadata and provenance information found inside the file have been removed where technically possible.' }),
        el('p', { text: 'This does not guarantee that social media platforms will stop identifying the image as AI-generated.' }),
      ]));
    }

    const k = keptNote(v.kept);
    if (k) body.appendChild(k);

    // Visual check
    const vis = res.visual;
    const visualLines = [];
    if (vis && !vis.error) {
      const sameDims = vis.width === state.display.width && vis.height === state.display.height;
      visualLines.push('Dimensions: ' + vis.width + ' × ' + vis.height + ' px' + (sameDims ? ' (same as original)' : ' — differs from original ' + state.display.width + ' × ' + state.display.height));
      if (vis.skipped) visualLines.push('Pixel comparison skipped (image too large to compare in the browser).');
      else if (vis.identical) visualLines.push('Pixels: identical to the original.');
      else if (vis.sameSize) visualLines.push('Pixels: average difference ' + vis.meanDiff.toFixed(2) + ' of 255 (PSNR ' + vis.psnr.toFixed(1) + ' dB)' + (vis.psnr >= 40 ? ' — visually identical.' : vis.psnr >= 32 ? ' — very close to the original.' : ' — noticeable differences possible.'));
    } else if (vis && vis.error) visualLines.push(vis.error);
    visualLines.push('File size: ' + formatBytes(state.bytes.length) + ' → ' + formatBytes(res.bytes.length));
    body.appendChild(el('div', { class: 'section' }, [el('h3', { text: 'Image check' }), el('ul', { class: 'notes' }, visualLines.map((t) => el('li', { text: t })))]));

    if (res.notes.length) {
      body.appendChild(el('div', { class: 'section' }, [el('h3', { text: 'Notes' }), el('ul', { class: 'notes' }, res.notes.map((t) => el('li', { text: t })))]));
    }
    $('resultCard').hidden = false;

    // Compare + download
    const blob = new Blob([res.bytes], { type: res.mime });
    const url = objectUrl(blob);
    $('cmpOriginal').src = $('filePreview').src;
    $('cmpOriginalInfo').textContent = formatBytes(state.bytes.length);
    $('cmpCleaned').src = url;
    $('cmpCleanedInfo').textContent = formatBytes(res.bytes.length);
    $('compareCard').hidden = false;

    const name = cleanName(state.file.name, res.format);
    const a = $('downloadBtn');
    a.href = url;
    a.download = name;
    // The exact bytes that were re-scanned and verified above – used for the preview, the link and the save prompt.
    state.cleanBlob = blob;
    state.cleanName = SAVE_EXT.test(name) ? name : name.replace(/\.[^.]*$/, '') + '.' + EXT[res.format];
    $('downloadStatus').hidden = true;
    $('downloadName').textContent = name + ' · ' + formatBytes(res.bytes.length);
    $('downloadCard').hidden = false;
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setDownloadStatus(text, ok) {
    const p = $('downloadStatus');
    p.textContent = text;
    p.className = 'download-status ' + (ok ? 'ok' : 'warn');
    p.hidden = false;
  }

  async function saveInViewer(e) {
    if (!inViewer || !state.cleanBlob) return; // local use: the normal download link handles it
    e.preventDefault();
    if (!downloadsApi) {
      setDownloadStatus('Saving is not available in this view. Try opening the page in Safari or the Claude app.', false);
      return;
    }
    try {
      await downloadsApi.save({ filename: state.cleanName, data: state.cleanBlob });
      setDownloadStatus('✓ Saved: ' + state.cleanName + ' (' + formatBytes(state.cleanBlob.size) + ')', true);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') setDownloadStatus('Save cancelled.', false);
      else if (code === 'rate_limited') setDownloadStatus('A save prompt is already open. Please wait a moment and try again.', false);
      else setDownloadStatus('The file could not be saved here' + (code ? ' (' + code + ')' : '') + '.', false);
    }
  }

  // ------------------------------------------------------------ multiple files

  /**
   * New selections are ADDED to what is already there (file picker and drag & drop).
   * - nothing selected yet + one file  → the single-image workflow, exactly as before
   * - nothing selected yet + more files → batch mode
   * - one image already open            → it becomes a batch together with the new files
   * - batch already open                → the new files are appended to the batch
   */
  function handleFiles(list) {
    let files = Array.from(list || []);
    if (!files.length) return;

    // Videos (MP4/MOV/M4V) go to the separate video module, one at a time.
    const isVideo = (f) => !!(MC.video && MC.video.isVideoFile(f));
    const videos = files.filter(isVideo);
    if (state.videoMode) {
      showError('A video is open.', 'Use Clear All to start a new selection. Videos are cleaned one at a time.');
      return;
    }
    if (videos.length) {
      if (videos.length === 1 && files.length === 1 && !state.file && !state.batchMode && !state.busy) {
        reset();
        state.videoMode = true;
        updatePicker();
        MC.videoUI.start(files[0]);
        return;
      }
      files = files.filter((f) => !isVideo(f));
      const note = ['Videos are cleaned one at a time.', 'Select a single video on its own (images and videos cannot be mixed in one batch yet). ' + videos.length + ' video' + (videos.length === 1 ? ' was' : 's were') + ' not added.'];
      if (!files.length) { showError(note[0], note[1]); return; }
      handleFiles(files);
      showError(note[0], note[1]);
      return;
    }

    if (state.batchMode) {
      MC.batch.add(files); // allowed while the batch is busy: new images wait in the queue
      updatePicker();
      return;
    }
    if (state.busy) return; // a single image is being cleaned right now
    if (!state.file && files.length === 1) return handleFile(files[0]);
    const current = state.file ? [state.file] : [];
    reset();
    state.batchMode = true;
    setBusy(false);
    MC.batch.add(current.concat(files));
    updatePicker();
  }

  // Shared helpers for js/batch.js (UI only – the cleaning engine is MC.cleaner).
  MC.ui = {
    el, objectUrl, showError, clearError, setBusy, cleanName, unsupportedMessage, state, renderAiBox, fieldTable,
    FORMAT_LABEL, MAX_FILE, inViewer,
    downloads: () => downloadsApi,
    deepNoteDefault: document.getElementById('deepNote').textContent,
  };

  // ------------------------------------------------------------ events

  function init() {
    const dz = $('dropzone');
    const input = $('fileInput');
    $('chooseBtn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = ''; // so the same folder or file can be picked again later
      handleFiles(files);
    });
    $('clearAllBtn').addEventListener('click', (e) => { e.stopPropagation(); reset(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dz.classList.add('dragover'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('dragover'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    $('cleanBtn').addEventListener('click', runClean);
    $('downloadBtn').addEventListener('click', saveInViewer);
    document.querySelectorAll('[data-action="reset"]').forEach((b) => b.addEventListener('click', () => { reset(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  init();
})();
