/**
 * vision-test frontend logic
 *
 * Flow: pick an image (upload or sample) → display original →
 * click "Detect": compress to MAX_DIM → POST compressed image + original
 * dimensions + current credentials (Key/Model/BaseURL) to /api/detect →
 * backend calls the LLM and returns classes + 0-1000 bbox coords →
 * frontend converts those coords back to pixels using the ORIGINAL
 * image's dimensions and draws the boxes on the original canvas.
 *
 * Key invariants:
 *  - Image sent to the model = compressed image (saves payload/tokens).
 *  - Boxes drawn on        = original image (avoids compression artifacts).
 *  - API Key / Model / BaseURL live in browser localStorage; save once,
 *    live-switch without refresh.
 */

// ---------- DOM references ----------
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const sampleGrid = document.getElementById('sampleGrid');
const detectBtn = document.getElementById('detectBtn');
const maxDimInput = document.getElementById('maxDim');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const detectionsEl = document.getElementById('detections');
const rawOutput = document.getElementById('rawOutput');
const rawText = document.getElementById('rawText');

// Settings panel
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const settingsClose = document.getElementById('settingsClose');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
const modelInput = document.getElementById('modelInput');
const modelHint = document.getElementById('modelHint');
const baseUrlInput = document.getElementById('baseUrlInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const clearSettingsBtn = document.getElementById('clearSettingsBtn');
const settingsHint = document.getElementById('settingsHint');
const providerRadios = document.querySelectorAll('input[name="provider"]');

// Currently selected image
let originalImg = null;
let originalDataUrl = null;
let compressedDataUrl = null;

// ---------- Color palette (same class → same color, deterministic) ----------
const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
];

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

// ============================================================
// Config layer: localStorage read/write
// ============================================================

const LS_KEYS = {
  provider: 'vt:provider',
  apiKey: 'vt:apiKey',
  model: 'vt:model',
  baseUrl: 'vt:baseUrl',
};

const DEFAULT_PROVIDER = 'anthropic';

const ConfigStore = {
  get(key) {
    try {
      return localStorage.getItem(LS_KEYS[key]) || '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem(LS_KEYS[key], value);
      else localStorage.removeItem(LS_KEYS[key]);
    } catch (err) {
      console.warn('localStorage write failed:', err);
    }
  },
  clear() {
    try {
      Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
  },
  snapshot() {
    return {
      provider: this.get('provider') || DEFAULT_PROVIDER,
      apiKey: this.get('apiKey'),
      model: this.get('model'),
      baseUrl: this.get('baseUrl'),
    };
  },
};

// ============================================================
// Settings panel
// ============================================================

function openSettings() {
  // Pre-fill with current config
  const cfg = ConfigStore.snapshot();
  const provider = cfg.provider || DEFAULT_PROVIDER;
  for (const r of providerRadios) r.checked = r.value === provider;

  apiKeyInput.value = cfg.apiKey;
  modelInput.value = cfg.model;
  baseUrlInput.value = cfg.baseUrl;

  settingsPanel.hidden = false;
  setTimeout(() => apiKeyInput.focus(), 0);
}

function closeSettings() {
  settingsPanel.hidden = true;
  settingsHint.textContent = '';
}

settingsBtn.addEventListener('click', openSettings);
// Close button: use mousedown (not click) — some browsers swallow click after
// a mouseup that happens on a DOM that's about to be removed. Also
// stopPropagation so the "click backdrop to close" handler doesn't fire.
settingsClose.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  closeSettings();
});
// Backdrop click closes (only when target is the backdrop itself)
settingsPanel.addEventListener('click', (e) => {
  if (e.target === settingsPanel) closeSettings();
});

// Show/hide the key in plain text (default: hidden)
toggleKeyVisibility.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  toggleKeyVisibility.textContent = apiKeyInput.type === 'password' ? 'Show' : 'Hide';
});

saveSettingsBtn.addEventListener('click', () => {
  // Determine selected provider
  let provider = DEFAULT_PROVIDER;
  for (const r of providerRadios) {
    if (r.checked) {
      provider = r.value;
      break;
    }
  }

  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();

  if (!apiKey) {
    settingsHint.textContent = '❌ API Key is required';
    settingsHint.className = 'settings-hint error';
    return;
  }
  if (!model) {
    settingsHint.textContent = '❌ Model is required';
    settingsHint.className = 'settings-hint error';
    return;
  }
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    settingsHint.textContent = '❌ Base URL must start with http:// or https://';
    settingsHint.className = 'settings-hint error';
    return;
  }

  ConfigStore.set('provider', provider);
  ConfigStore.set('apiKey', apiKey);
  ConfigStore.set('model', model);
  ConfigStore.set('baseUrl', baseUrl); // empty string removes the key

  settingsHint.textContent = `✅ Saved (${provider}). Changes apply on next detection.`;
  settingsHint.className = 'settings-hint success';

  refreshDetectButton();

  setTimeout(closeSettings, 1500);
});

clearSettingsBtn.addEventListener('click', () => {
  if (!confirm('Clear saved Provider / API Key / Model / Base URL?')) return;
  ConfigStore.clear();
  for (const r of providerRadios) r.checked = r.value === DEFAULT_PROVIDER;
  apiKeyInput.value = '';
  modelInput.value = '';
  baseUrlInput.value = '';
  settingsHint.textContent = 'Cleared. Server .env values still apply as fallback.';
  settingsHint.className = 'settings-hint';
  refreshDetectButton();
});

function refreshDetectButton() {
  const hasKey = !!ConfigStore.get('apiKey');
  if (!originalDataUrl) return; // no image selected → leave the button alone
  detectBtn.disabled = !hasKey;
  if (!hasKey) {
    setStatus('Image selected, but no API Key configured. Click ⚙ Settings to add one.', true);
  }
}

// ============================================================
// Image loading + compression
// ============================================================

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

async function urlToDataURL(url) {
  const blob = await (await fetch(url)).blob();
  return blobToDataURL(blob);
}

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = dataUrl;
  });
}

/**
 * Downscale the original image so its longest edge ≤ maxDim, encoded as JPEG.
 * Preserves aspect ratio. If maxDim is invalid (NaN/≤0) or image already
 * fits, returns the original unchanged.
 */
async function compressImage(originalDataUrl, maxDim) {
  const img = await dataUrlToImage(originalDataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const longest = Math.max(w, h);

  const dim = Number(maxDim);
  if (!Number.isFinite(dim) || dim <= 0 || longest <= dim) {
    return { dataUrl: originalDataUrl, width: w, height: h, scaled: false };
  }

  const scale = dim / longest;
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').drawImage(img, 0, 0, tw, th);
  // JPEG 0.85 is the "barely-noticeable but much smaller" sweet spot
  return {
    dataUrl: c.toDataURL('image/jpeg', 0.85),
    width: tw,
    height: th,
    scaled: true,
  };
}

// ---------- Display the original image ----------

function showOriginalImage(dataUrl) {
  dataUrlToImage(dataUrl).then((img) => {
    originalImg = img;
    originalDataUrl = dataUrl;
    compressedDataUrl = null;

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    canvas.hidden = false;
    placeholder.hidden = true;
    detectionsEl.innerHTML = '';
    rawOutput.hidden = true;

    const hasKey = !!ConfigStore.get('apiKey');
    if (hasKey) {
      const provider = ConfigStore.get('provider') || DEFAULT_PROVIDER;
      setStatus(
        `Loaded original ${img.naturalWidth}×${img.naturalHeight}. ` +
          `On Detect it will be downscaled to max edge ${maxDimInput.value}px ` +
          `and sent to ${provider} model ${ConfigStore.get('model') || '(default)'}.`
      );
      detectBtn.disabled = false;
    } else {
      setStatus('Image selected, but no API Key configured. Click ⚙ Settings to add one.', true);
      detectBtn.disabled = true;
    }
  }).catch(() => setStatus('Image decode failed — try another file.', true));
}

// ---------- Local upload: click + drag-drop ----------

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Only image files are supported.', true);
    return;
  }
  showOriginalImage(await blobToDataURL(file));
}

// ---------- Sample thumbnails ----------

async function loadSamples() {
  const res = await fetch('/api/samples');
  const samples = await res.json();
  for (const s of samples) {
    const thumb = document.createElement('img');
    thumb.src = s.url;
    thumb.title = s.name;
    thumb.alt = s.name;
    thumb.addEventListener('click', () => showOriginalImageFromUrl(s.url));
    sampleGrid.appendChild(thumb);
  }
}

async function showOriginalImageFromUrl(url) {
  try {
    const dataUrl = await urlToDataURL(url);
    showOriginalImage(dataUrl);
  } catch (err) {
    setStatus(`Failed to load sample image: ${err.message}`, true);
  }
}

maxDimInput.addEventListener('change', () => {
  if (originalImg) {
    compressedDataUrl = null;
    setStatus(`Max edge set to ${maxDimInput.value}px — will apply on next Detect.`);
  }
});

// ============================================================
// Detect
// ============================================================

detectBtn.addEventListener('click', async () => {
  if (!originalDataUrl) return;

  // Re-read config live (user may have edited it in the settings panel)
  const cfg = ConfigStore.snapshot();
  if (!cfg.apiKey) {
    setStatus('Please fill in your API Key in ⚙ Settings first.', true);
    openSettings();
    return;
  }

  detectBtn.disabled = true;
  try {
    // 1. Compress (if not already)
    if (!compressedDataUrl) {
      setStatus(`Compressing to max edge ${maxDimInput.value}px…`);
      const r = await compressImage(originalDataUrl, maxDimInput.value);
      compressedDataUrl = r.dataUrl;
      const ratioKB = (compressedDataUrl.length / 1024).toFixed(0);
      setStatus(
        r.scaled
          ? `Compressed ${originalImg.naturalWidth}×${originalImg.naturalHeight} → ${r.width}×${r.height} (~${ratioKB} KB). Calling ${cfg.model}…`
          : `Image already ≤ ${maxDimInput.value}px, no compression needed. Calling ${cfg.model}…`
      );
    } else {
      setStatus(`Calling ${cfg.model}…`);
    }

    // 2. POST: compressed image + original size + current config (incl. provider)
    const res = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: compressedDataUrl,
        originalSize: {
          width: originalImg.naturalWidth,
          height: originalImg.naturalHeight,
        },
        provider: cfg.provider || DEFAULT_PROVIDER,
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl || undefined, // don't send empty string
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    renderDetections(data);
    setStatus(
      `Found ${data.detections.length} objects · [${data.provider}] ${data.model} ` +
        `(${data.configSource?.model || '?'})` +
        ` · input ${data.usage.input_tokens} tokens / output ${data.usage.output_tokens} tokens`
    );
  } catch (err) {
    setStatus(`Detection failed: ${err.message}`, true);
  } finally {
    detectBtn.disabled = !ConfigStore.get('apiKey');
  }
});

// ============================================================
// Render boxes (on the original image)
// ============================================================

function renderDetections(data) {
  ctx.drawImage(originalImg, 0, 0);
  const W = canvas.width;
  const H = canvas.height;

  const lineW = Math.max(2, W / 300);
  const fontSize = Math.max(14, Math.round(W / 45));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';

  data.detections.forEach((d, i) => {
    // 0-1000 normalized → pixel coords on the ORIGINAL image
    const x1 = (d.bbox_2d[0] / 1000) * W;
    const y1 = (d.bbox_2d[1] / 1000) * H;
    const x2 = (d.bbox_2d[2] / 1000) * W;
    const y2 = (d.bbox_2d[3] / 1000) * H;
    const color = colorFor(d.name);

    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    const label = `${i + 1}. ${d.name}`;
    const tw = ctx.measureText(label).width;
    // If label would overflow the top, push it inside the box
    const labelY = y1 - fontSize - 8 >= 0 ? y1 - fontSize - 8 : y1;
    ctx.fillStyle = color;
    ctx.fillRect(x1, labelY, tw + 10, fontSize + 8);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x1 + 5, labelY + 4);
  });

  detectionsEl.innerHTML = '';
  for (const d of data.detections) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorFor(d.name);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(d.name));
    detectionsEl.appendChild(chip);
  }

  rawText.textContent = data.raw;
  rawOutput.hidden = false;
}

// Esc closes the settings panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsPanel.hidden) closeSettings();
});

loadSamples();
