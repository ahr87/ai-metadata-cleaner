/* Looks for AI-generator / editing-software traces and generation parameters
   inside metadata that was already extracted by the format parsers. */
(function (root) {
  'use strict';

  const MC = (root.MetaClean = root.MetaClean || {});
  const { clip } = MC.bin;

  const TOOLS = [
    // AI image generators
    ['ai', 'Midjourney', /midjourney|\bJob ID:\s*[0-9a-f]{8}-/i],
    ['ai', 'DALL·E / OpenAI', /\bdall[\s·\-_.]?e\b|openai|chatgpt|gpt-?4o|gpt-image/i],
    ['ai', 'Stable Diffusion', /stable[\s_-]?diffusion|\bsdxl\b|stability[\s.]?ai|\bsd[\s_-]?(1\.5|2\.1|3\.5|3)\b/i],
    ['ai', 'Automatic1111 / Forge WebUI', /automatic1111|stable-diffusion-webui|sd-webui|webui[\s_-]?forge/i],
    ['ai', 'ComfyUI', /comfyui/i],
    ['ai', 'Flux (Black Forest Labs)', /\bflux[\s._-]?(1|dev|schnell|pro|kontext)|black[\s_-]?forest[\s_-]?labs/i],
    ['ai', 'Adobe Firefly', /firefly/i],
    ['ai', 'Runway', /runwayml|runway[\s_-]?(gen|ml|ai)\b/i],
    ['ai', 'NovelAI', /novelai/i],
    ['ai', 'InvokeAI', /invoke[\s_-]?ai/i],
    ['ai', 'Fooocus', /fooocus/i],
    ['ai', 'Leonardo.Ai', /leonardo[\s.]?ai/i],
    ['ai', 'Ideogram', /ideogram/i],
    ['ai', 'Google Imagen / Gemini', /\bimagen\b|gemini|synthid|made with google ai/i],
    ['ai', 'Microsoft Designer / Bing Image Creator', /bing image creator|microsoft designer|copilot designer/i],
    ['ai', 'Meta AI', /\bmeta[\s_-]?ai\b|imagined with ai/i],
    ['ai', 'Grok / xAI', /\bgrok\b|\bx\.ai\b/i],
    ['ai', 'Krea', /\bkrea(\.ai)?\b/i],
    ['ai', 'Playground AI', /playground[\s_-]?(ai|v\d)/i],
    ['ai', 'Draw Things', /draw[\s_-]?things/i],
    ['ai', 'DreamStudio', /dreamstudio/i],
    ['ai', 'NightCafe', /nightcafe/i],
    ['ai', 'Recraft', /recraft/i],
    ['ai', 'Civitai', /civitai/i],
    ['ai', 'Generic AI-generation reference', /\bai[\s_-]?generated\b|generative[\s_-]?ai|text[\s_-]?to[\s_-]?image|\btxt2img\b|\bimg2img\b/i],
    // Editing software
    ['editor', 'Adobe Photoshop', /photoshop/i],
    ['editor', 'Adobe Lightroom', /lightroom/i],
    ['editor', 'Adobe (other)', /adobe (camera raw|bridge|express|illustrator|xmp core)/i],
    ['editor', 'Canva', /\bcanva\b/i],
    ['editor', 'GIMP', /\bgimp\b/i],
    ['editor', 'Affinity', /affinity[\s_-]?(photo|designer)/i],
    ['editor', 'Pixelmator', /pixelmator/i],
    ['editor', 'Snapseed', /snapseed/i],
    ['editor', 'Picsart', /picsart/i],
    ['editor', 'Capture One', /capture[\s_-]?one/i],
    ['editor', 'Luminar', /luminar/i],
    ['editor', 'Topaz', /topaz/i],
    ['editor', 'CapCut', /capcut/i],
    ['editor', 'Meitu', /meitu/i],
    ['editor', 'Remini', /remini/i],
    ['editor', 'FaceApp', /faceapp/i],
    ['editor', 'Facetune', /facetune/i],
    ['editor', 'VSCO', /\bvsco\b/i],
    ['editor', 'Fotor', /\bfotor\b/i],
    ['editor', 'Pixlr', /pixlr/i],
    ['editor', 'Krita', /\bkrita\b/i],
    ['editor', 'Paint.NET', /paint\.net/i],
    ['editor', 'ImageMagick', /imagemagick/i],
    ['editor', 'Picasa', /picasa/i],
  ];

  const MARKERS = [
    [/compositeWithTrainedAlgorithmicMedia/i, 'IPTC Digital Source Type: composite with AI-generated content'],
    [/(^|[^e])trainedAlgorithmicMedia/i, 'IPTC Digital Source Type: AI-generated media (trainedAlgorithmicMedia)'],
    [/(^|[^d])algorithmicMedia/i, 'IPTC Digital Source Type: algorithmic media'],
    [/c2pa\.ai_generat|ai_generative_training|"?generativeAI"?/i, 'C2PA AI-generation assertion'],
  ];

  // ---------------------------------------------------------------- parameters

  function parseA1111(t) {
    if (!/(^|\n)\s*Steps:\s*\d+,/.test(t)) return null;
    const lines = t.split(/\r?\n/);
    let stepsIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (/^\s*Steps:\s*\d+,/.test(lines[i])) { stepsIdx = i; break; }
    const head = lines.slice(0, stepsIdx).join('\n');
    const negIdx = head.indexOf('Negative prompt:');
    const out = [];
    const prompt = (negIdx >= 0 ? head.slice(0, negIdx) : head).trim();
    if (prompt) out.push(['Prompt', prompt]);
    if (negIdx >= 0) out.push(['Negative prompt', head.slice(negIdx + 16).trim()]);
    const settings = lines.slice(stepsIdx).join(' ');
    const pairs = {};
    const re = /\s*([\w ]+?):\s*("(?:[^"\\]|\\.)*"|[^,]*)(,|$)/g;
    let m;
    while ((m = re.exec(settings)) && m[0]) pairs[m[1].trim()] = m[2].trim();
    const map = [['Seed', 'Seed'], ['Model', 'Model'], ['Model hash', 'Model hash'], ['Sampler', 'Sampler'], ['Schedule type', 'Scheduler'], ['Steps', 'Steps'], ['CFG scale', 'CFG scale'], ['Size', 'Size'], ['VAE', 'VAE'], ['Lora hashes', 'LoRA']];
    for (const [k, label] of map) if (pairs[k]) out.push([label, pairs[k]]);
    out.push(['Generation parameters', settings]);
    return { tool: 'Automatic1111 / Forge WebUI', params: out };
  }

  function tryJson(t) {
    const s = t.trim();
    if (s[0] !== '{' && s[0] !== '[') return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function comfyPrompt(obj) {
    const nodes = Object.values(obj).filter((n) => n && typeof n === 'object' && n.class_type && n.inputs);
    if (!nodes.length) return null;
    const out = [];
    const textOf = (ref) => {
      const n = Array.isArray(ref) ? obj[ref[0]] : null;
      return n && n.inputs && typeof n.inputs.text === 'string' ? n.inputs.text : null;
    };
    for (const n of nodes) {
      const i = n.inputs;
      if (/sampler/i.test(n.class_type)) {
        const pos = textOf(i.positive), neg = textOf(i.negative);
        if (pos) out.push(['Prompt', pos]);
        if (neg) out.push(['Negative prompt', neg]);
        if (i.seed != null || i.noise_seed != null) out.push(['Seed', String(i.seed != null ? i.seed : i.noise_seed)]);
        if (i.sampler_name) out.push(['Sampler', String(i.sampler_name)]);
        if (i.steps != null) out.push(['Steps', String(i.steps)]);
        if (i.cfg != null) out.push(['CFG scale', String(i.cfg)]);
      }
      for (const k of ['ckpt_name', 'unet_name', 'model_name']) if (typeof i[k] === 'string') out.push(['Model', i[k]]);
    }
    if (!out.some((p) => p[0] === 'Prompt')) {
      const texts = nodes.filter((n) => /CLIPTextEncode/i.test(n.class_type) && typeof n.inputs.text === 'string');
      if (texts[0]) out.push(['Prompt', texts[0].inputs.text]);
    }
    out.push(['Workflow information', 'ComfyUI graph with ' + nodes.length + ' nodes']);
    return { tool: 'ComfyUI', params: out };
  }

  const GENERIC_KEYS = [
    [/^(prompt|positive_prompt|positivePrompt|Description)$/, 'Prompt'],
    [/^(negative_prompt|negativePrompt|uc|negative)$/, 'Negative prompt'],
    [/^(seed|noise_seed)$/, 'Seed'],
    [/^(model|base_model|model_name|checkpoint|sd_model_name)$/, 'Model'],
    [/^(model_hash|sd_model_hash)$/, 'Model hash'],
    [/^(sampler|sampler_name|scheduler)$/, 'Sampler'],
    [/^(steps)$/, 'Steps'],
    [/^(cfg|cfg_scale|scale|guidance_scale)$/, 'CFG scale'],
  ];

  function genericJson(obj) {
    const out = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 4) return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v == null) continue;
        if (typeof v !== 'object') {
          for (const [re, label] of GENERIC_KEYS) {
            if (re.test(k) && String(v).trim()) { out.push([label, String(v)]); break; }
          }
        } else if (!Array.isArray(v) && (k === 'model' || k === 'main_model') && v.name) {
          out.push(['Model', String(v.name)]);
        } else walk(v, depth + 1);
      }
    };
    walk(obj, 0);
    return out.length ? { tool: null, params: out } : null;
  }

  function parseParams(t, key) {
    const results = [];
    const a = parseA1111(t);
    if (a) results.push(a);
    const json = tryJson(t);
    if (json && typeof json === 'object') {
      if (Array.isArray(json.nodes) && (json.links || json.last_node_id != null)) {
        results.push({ tool: 'ComfyUI', params: [['Workflow information', 'ComfyUI workflow with ' + json.nodes.length + ' nodes']] });
      } else {
        const c = comfyPrompt(json);
        if (c) results.push(c);
        else {
          const g = genericJson(json);
          if (g) results.push(g);
        }
      }
    }
    if (/--(ar|v|niji|stylize|chaos|seed)\s/.test(t) && (/description/i.test(key || '') || /Job ID/i.test(t))) {
      const prompt = t.split(/\s--/)[0].trim();
      if (prompt) results.push({ tool: 'Midjourney', params: [['Prompt', prompt]] });
    }
    const job = /Job ID:\s*([0-9a-f-]{36})/i.exec(t);
    if (job) results.push({ tool: 'Midjourney', params: [['Midjourney Job ID', job[1]]] });
    if (key === 'workflow' && !json) results.push({ tool: 'ComfyUI', params: [['Workflow information', 'present']] });
    return results;
  }

  /**
   * @param analysis result from MC.formats.analyzeBytes
   * @returns {{ai: Array, editors: Array, markers: Array, params: Array, found: boolean}}
   */
  function detect(analysis) {
    const sources = [];
    for (const f of analysis.fields) {
      if (f.keep || f.derived) continue;
      sources.push({ where: f.category + ' › ' + f.name, text: f.fullValue, key: f.key || (f.name.split(':')[1] || f.name) });
    }
    for (const b of analysis.blobs) {
      if (b.key === 'XML:com.adobe.xmp' || b.key) continue; // already covered by fields
      sources.push({ where: b.source, text: b.text });
    }

    const tools = new Map();
    const markers = new Set();
    const params = [];
    const seenParam = new Set();

    const addTool = (kind, name, where) => {
      if (!tools.has(name)) tools.set(name, { kind, name, where: new Set() });
      tools.get(name).where.add(where);
    };

    for (const s of sources) {
      const t = String(s.text || '');
      if (!t) continue;
      for (const [kind, name, re] of TOOLS) if (re.test(t)) addTool(kind, name, s.where);
      for (const [re, label] of MARKERS) if (re.test(t)) markers.add(label);
      for (const r of parseParams(t, s.key)) {
        if (r.tool) addTool('ai', r.tool, s.where);
        for (const [name, value] of r.params) {
          const k = name + '\u0000' + value;
          if (seenParam.has(k)) continue;
          seenParam.add(k);
          params.push({ name, value: clip(value, 600), where: s.where });
        }
      }
    }
    // A1111-style parameters imply Stable Diffusion.
    if (tools.has('Automatic1111 / Forge WebUI') && !tools.has('Stable Diffusion')) addTool('ai', 'Stable Diffusion', 'generation parameters');
    if (markers.has('IPTC Digital Source Type: composite with AI-generated content')) {
      markers.delete('IPTC Digital Source Type: AI-generated media (trainedAlgorithmicMedia)');
      markers.delete('IPTC Digital Source Type: algorithmic media');
    } else if (markers.has('IPTC Digital Source Type: AI-generated media (trainedAlgorithmicMedia)')) {
      markers.delete('IPTC Digital Source Type: algorithmic media');
    }

    const list = Array.from(tools.values()).map((t) => ({ kind: t.kind, name: t.name, where: Array.from(t.where) }));
    const ai = list.filter((t) => t.kind === 'ai');
    const editors = list.filter((t) => t.kind === 'editor');
    const c2pa = analysis.fields.some((f) => f.category === 'C2PA');
    return {
      ai,
      editors,
      markers: Array.from(markers),
      params,
      c2pa,
      found: ai.length > 0 || editors.length > 0 || markers.size > 0 || params.length > 0 || c2pa,
      aiFound: ai.length > 0 || markers.size > 0 || params.length > 0,
    };
  }

  MC.ai = { detect, parseParams };
})(typeof window !== 'undefined' ? window : globalThis);
