/* Video UI: one video at a time. Analyze → Clean Metadata → Verify → Download.
   Uses MC.video (js/video/mp4.js) for all parsing/cleaning and a few shared UI
   helpers from js/app.js. Metadata text is always inserted with textContent. */
(function () {
  'use strict';

  const MC = window.MetaClean;
  const V = MC.video;
  const ui = MC.ui;
  const el = ui.el;
  const $ = (id) => document.getElementById(id);

  const CATS = [
    ['Location', 'Location / GPS'], ['Dates', 'Dates'], ['Device', 'Device / camera'], ['Software', 'Software / encoder'],
    ['Text', 'Title, description & credits'], ['XMP', 'XMP'], ['C2PA', 'C2PA / Content Credentials'], ['Cover art', 'Cover art / previews'],
    ['Timed metadata', 'Timed metadata tracks'], ['Vendor data', 'Vendor data'], ['Hidden data', 'Hidden data'], ['Other', 'Other metadata'],
  ];
  const FORMAT = { mp4: 'MP4', mov: 'MOV', m4v: 'M4V' };

  let run = 0;
  let cur = null; // { file, analysis, out, url, previewUrl }
  const urls = [];

  function objectUrl(blob) {
    const u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  }

  function show(ids, on) {
    for (const id of ids) $(id).hidden = !on;
  }

  function pill(text, cls) {
    const p = $('videoStatus');
    p.textContent = text;
    p.className = 'pill pill-' + cls;
  }

  // ------------------------------------------------------------ start / analyze

  async function start(file) {
    const myRun = ++run;
    cur = { file };
    $('dropzone').classList.add('compact');
    $('videoName').textContent = file.name;
    $('videoSize').textContent = V.fmtBytes(file.size);
    $('videoFormat').textContent = '…';
    $('videoDuration').textContent = '…';
    $('videoRes').textContent = '…';
    $('videoCodec').textContent = '…';
    pill('Analyzing', 'analyzing');
    show(['videoCard'], true);
    show(['videoReportCard', 'videoCleanCard', 'videoResultCard', 'videoDownloadCard'], false);
    setPreview(file);

    const limit = V.maxBytes();
    if (file.size > limit) {
      pill('Too large', 'failed');
      ui.showError('This video is too large for this device (' + V.fmtBytes(file.size) + ').', 'The limit is ' + V.fmtBytes(limit) + (V.isAppleMobile() ? ' on iPhone/iPad.' : ' on this device.'));
      return;
    }

    let a;
    try {
      a = await V.analyze(file, file.name);
    } catch (e) {
      if (myRun !== run) return;
      console.error(e);
      pill('Failed', 'failed');
      ui.showError('The video could not be analyzed.', (e && e.message) || 'It may be damaged or use an unsupported structure.');
      return;
    }
    if (myRun !== run) return;
    cur.analysis = a;
    renderInfo(a);
    renderReport(a);
    if (a.unsupported) {
      pill('Unsupported', 'failed');
      ui.showError(a.unsupported.message, 'The original file was not modified. You can clear it and choose another file.');
      return;
    }
    pill('Ready', 'ready');
    show(['videoCleanCard'], true);
  }

  function setPreview(file) {
    const v = $('videoPreview');
    const note = $('videoNoPreview');
    note.hidden = true;
    v.hidden = false;
    v.onerror = () => { v.hidden = true; note.hidden = false; };
    v.src = objectUrl(file);
  }

  function renderInfo(a) {
    const p = a.props || {};
    $('videoFormat').textContent = FORMAT[a.format] || 'Video';
    $('videoDuration').textContent = p.duration ? V.formatDuration(p.duration) : '—';
    if (p.video) {
      const rot = p.video.rotation === 90 || p.video.rotation === 270;
      $('videoRes').textContent = (rot ? p.video.height + ' × ' + p.video.width : p.video.width + ' × ' + p.video.height) + (p.video.fps ? ' · ' + (Math.round(p.video.fps * 100) / 100) + ' fps' : '') + (p.video.hdr ? ' · HDR' : '');
    } else $('videoRes').textContent = '—';
    $('videoCodec').textContent = [p.video && p.video.codec, p.audio && p.audio.codec].filter(Boolean).join(' + ') || '—';
  }

  function groupsFor(fields) {
    const wrap = el('div', { class: 'groups' });
    for (const [cat, lbl] of CATS) {
      const fs = fields.filter((f) => f.category === cat);
      if (!fs.length) continue;
      const names = Array.from(new Set(fs.map((f) => f.name + (cat === 'Location' || cat === 'C2PA' || cat === 'Device' ? ': ' + f.value : ''))));
      const shown = names.slice(0, 6);
      const sensitive = cat === 'Location' || cat === 'C2PA' || cat === 'Timed metadata';
      wrap.appendChild(el('div', { class: 'group' + (sensitive ? ' sensitive' : '') + (cat === 'C2PA' ? ' wide' : '') }, [
        el('h3', null, [lbl, el('span', { class: 'count', text: fs.length + (fs.length === 1 ? ' field' : ' fields') })]),
        el('ul', null, shown.map((t) => el('li', { text: t })).concat(names.length > shown.length ? [el('li', { class: 'more', text: '+ ' + (names.length - shown.length) + ' more' })] : [])),
      ]));
    }
    return wrap;
  }

  function remainingBox(fields, title) {
    if (!fields.length) return null;
    return el('div', { class: 'alert alert-warn section' }, [
      el('p', null, [el('strong', { text: title })]),
    ].concat(fields.map((f) => el('p', { text: '• ' + f.name + ' — ' + (f.reason || 'remaining') + (f.value ? ': ' + f.value.slice(0, 140) : '') }))));
  }

  function renderReport(a) {
    const body = $('videoReport');
    body.replaceChildren();
    const fields = a.removable;
    if (!fields.length && !a.remainingFields.length && !a.ai.found) {
      body.appendChild(el('div', { class: 'empty-state' }, [el('strong', { text: 'No removable metadata detected.' }), 'This video already looks clean.']));
    } else {
      body.appendChild(el('p', { class: 'mode-used', text: fields.length + ' removable metadata ' + (fields.length === 1 ? 'field' : 'fields') + ' found in this video.' }));
      if (fields.length) body.appendChild(groupsFor(fields));
      const ai = ui.renderAiBox(a.ai);
      if (ai) body.appendChild(ai);
      const rem = remainingBox(a.remainingFields, 'Will remain after cleaning:');
      if (rem) body.appendChild(rem);
      if (fields.length) body.appendChild(el('details', { class: 'fields' }, [el('summary', { text: 'Show all ' + fields.length + ' fields' }), ui.fieldTable(fields)]));
    }
    show(['videoReportCard'], true);
  }

  // ------------------------------------------------------------ clean + verify

  function setProgress(text, frac) {
    const box = $('videoProgress');
    if (text == null) { box.hidden = true; return; }
    box.hidden = false;
    $('videoProgressText').textContent = text;
    $('videoBar').style.width = Math.round(Math.max(0, Math.min(1, frac || 0)) * 100) + '%';
  }

  /** Load a blob into a hidden <video>. Resolves with what the browser could read. */
  function probe(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.setAttribute('playsinline', '');
      v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none';
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        try { v.load(); } catch (e) { /* ignore */ }
        v.remove();
        URL.revokeObjectURL(url);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 10000);
      v.addEventListener('error', () => finish({ ok: false, reason: 'error' }));
      v.addEventListener('loadedmetadata', () => {
        const meta = { ok: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
        if (v.readyState >= 2) return finish(Object.assign(meta, { decoded: true }));
        v.addEventListener('loadeddata', () => finish(Object.assign(meta, { decoded: true })), { once: true });
        setTimeout(() => finish(Object.assign(meta, { decoded: false })), 4000);
      });
      document.body.appendChild(v);
      v.src = url;
    });
  }

  async function playbackCheck(original, output) {
    const [a, b] = await Promise.all([probe(original), probe(output)]);
    if (!a.ok && !b.ok) return { state: 'unsupported', text: 'Playback not checked: this browser cannot play this codec. The structure checks above still apply.' };
    if (a.ok && !b.ok) return { state: 'failed', text: 'Playback check failed: the browser plays the original but not the cleaned file.' };
    const same = Math.abs(a.duration - b.duration) < 0.05 && a.width === b.width && a.height === b.height;
    if (!same) return { state: 'failed', text: 'Playback check failed: the browser reports different duration or size (' + b.width + ' × ' + b.height + ', ' + b.duration.toFixed(2) + ' s).' };
    return { state: 'ok', text: 'Playback verified: the browser loaded the cleaned video (' + b.width + ' × ' + b.height + ', ' + V.formatDuration(b.duration) + ')' + (b.decoded ? ' and decoded a frame.' : '.') };
  }

  async function runClean() {
    if (!cur || !cur.analysis || ui.state.busy) return;
    const myRun = run;
    const btn = $('videoCleanBtn');
    ui.clearError();
    ui.state.busy = true;
    btn.disabled = true;
    btn.replaceChildren(el('span', { class: 'spinner' }), el('span', { class: 'btn-label', text: 'Cleaning…' }));
    show(['videoResultCard', 'videoDownloadCard'], false);
    pill('Cleaning', 'cleaning');
    try {
      setProgress('Cleaning metadata…', 0.02);
      await new Promise((r) => setTimeout(r, 30));
      const out = V.clean(cur.file, cur.analysis);
      if (myRun !== run) return;
      pill('Verifying', 'verifying');
      setProgress('Verifying: re-reading the cleaned file…', 0.05);
      const v = await V.verify(cur.file, cur.analysis, out, (f) => { if (myRun === run) setProgress('Verifying video and audio data… ' + Math.round(f * 100) + '%', f); });
      if (myRun !== run) return;
      setProgress('Checking playback…', 1);
      const play = await playbackCheck(cur.file, out);
      if (myRun !== run) return;
      setProgress(null);
      cur.out = out;
      renderResult(v, play, out);
    } catch (e) {
      if (myRun !== run) return;
      console.error(e);
      setProgress(null);
      pill('Failed', 'failed');
      ui.showError('The video was not cleaned.', ((e && e.message) || 'Something went wrong.') + ' Your original file was not changed.');
    } finally {
      if (myRun === run) {
        ui.state.busy = false;
        btn.disabled = false;
        btn.replaceChildren(el('span', { class: 'btn-label', text: 'Clean Metadata' }));
      }
    }
  }

  function cleanName(name, format) {
    const m = /^(.*?)(\.[^.]+)?$/.exec(name);
    const base = (m[1] || 'video').replace(/[\\/:*?"<>|]+/g, '_');
    return base + '_clean' + (m[2] || '.' + (format || 'mp4'));
  }

  function renderResult(v, play, out) {
    const a = cur.analysis;
    const after = v.after;
    const before = a.removable.length;
    const left = after.removable.length;
    const leftAll = left + after.remainingFields.length;
    const body = $('videoResult');
    body.replaceChildren();
    const ok = v.ok && play.state !== 'failed';

    body.appendChild(el('p', { class: 'mode-used', text: 'Mode: Clean Metadata (no re-encoding) · verified by re-reading the cleaned file' }));
    body.appendChild(el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(before) }), el('div', { class: 'lbl', text: 'Before' })]),
      el('div', { class: 'stat removed' }, [el('div', { class: 'num', text: String(Math.max(0, before - left)) }), el('div', { class: 'lbl', text: 'Removed' })]),
      el('div', { class: 'stat remaining' + (leftAll ? ' has' : '') }, [el('div', { class: 'num', text: String(leftAll) }), el('div', { class: 'lbl', text: 'Remaining' })]),
    ]));

    body.appendChild(el('h3', { class: 'verify-title', text: v.ok ? '✓ Structure verified' : '⚠ Structure check failed' }));
    body.appendChild(el('ul', { class: 'checks' }, v.checks.map((c) =>
      el('li', { class: c.ok ? 'ok' : 'bad' }, [el('span', { class: 'ic', text: c.ok ? '✓' : '!' }), c.label + (c.detail ? ' (' + c.detail + ')' : '')])
    )));
    body.appendChild(el('div', { class: 'alert section ' + (play.state === 'ok' ? 'alert-ok' : play.state === 'failed' ? 'alert-error' : 'alert-info'), text: play.text }));

    const rem = remainingBox(after.remainingFields, '⚠ Some metadata could not be removed:');
    if (left) body.appendChild(remainingBox(after.removable.map((f) => Object.assign({ reason: 'still present' }, f)), '⚠ Some metadata could not be removed:'));
    else if (rem) body.appendChild(rem);
    else if (ok) body.appendChild(el('div', { class: 'alert alert-ok section', text: '✓ All removable metadata was removed. The cleaned file was read again from scratch and nothing removable was found.' }));

    if (a.ai.aiFound || a.ai.c2pa) {
      body.appendChild(el('div', { class: 'alert alert-info section' }, [
        el('p', { text: 'AI-related metadata and provenance information found inside the file have been removed where technically possible.' }),
        el('p', { text: 'This does not guarantee that social media platforms will stop identifying the video as AI-generated. Invisible watermarks in the picture itself (for example SynthID) are not affected.' }),
      ]));
    }
    body.appendChild(el('div', { class: 'section' }, [el('h3', { text: 'Notes' }), el('ul', { class: 'notes' }, [
      el('li', { text: 'No re-encoding: video and audio data were copied byte-for-byte.' }),
      el('li', { text: 'File size: ' + V.fmtBytes(cur.file.size) + ' → ' + V.fmtBytes(out.size) + ' (removed metadata is replaced by empty padding).' }),
    ])]));
    show(['videoResultCard'], true);

    if (!ok) {
      pill('Failed', 'failed');
      ui.showError('The cleaned video did not pass verification, so it is not offered for download.', 'Your original file was not changed.');
      return;
    }
    pill(leftAll ? 'Verified · warning' : 'Verified', leftAll ? 'warning' : 'verified');
    const name = cleanName(cur.file.name, a.format);
    const link = $('videoDownloadBtn');
    link.href = objectUrl(out);
    link.download = name;
    $('videoDownloadName').textContent = name + ' · ' + V.fmtBytes(out.size);
    $('videoDownloadStatus').hidden = true;
    cur.name = name;
    show(['videoDownloadCard'], true);
    $('videoResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setDownloadStatus(text, good) {
    const p = $('videoDownloadStatus');
    p.textContent = text;
    p.className = 'download-status ' + (good ? 'ok' : 'warn');
    p.hidden = false;
  }

  // Inside the Claude artifact viewer plain download links are blocked; use its save prompt.
  async function saveInViewer(e) {
    if (!ui.inViewer || !cur || !cur.out) return;
    e.preventDefault();
    const api = ui.downloads();
    if (!api) return setDownloadStatus('Saving is not available in this view.', false);
    try {
      await api.save({ filename: cur.name, data: cur.out });
      setDownloadStatus('✓ Saved: ' + cur.name, true);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') setDownloadStatus('Save cancelled.', false);
      else if (code === 'rejected_extension' || code === 'extension_not_enabled') setDownloadStatus('This file type cannot be saved in this view. Open the app in Safari or Chrome instead.', false);
      else setDownloadStatus('The video could not be saved here' + (code ? ' (' + code + ')' : '') + '.', false);
    }
  }

  function reset() {
    run++;
    cur = null;
    const v = $('videoPreview');
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* ignore */ }
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    show(['videoCard', 'videoReportCard', 'videoCleanCard', 'videoResultCard', 'videoDownloadCard', 'videoProgress'], false);
    const btn = $('videoCleanBtn');
    btn.disabled = false;
    btn.replaceChildren(el('span', { class: 'btn-label', text: 'Clean Metadata' }));
  }

  $('videoCleanBtn').addEventListener('click', runClean);
  $('videoDownloadBtn').addEventListener('click', saveInViewer);

  MC.videoUI = { start, reset, current: () => cur };
})();
