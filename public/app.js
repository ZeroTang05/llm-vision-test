/**
 * vision-test 前端逻辑
 *
 * 流程：选图（本地上传 或 点数据集缩略图）→ 展示原图 →
 * 点「开始检测」时：先按 MAX_DIM 压缩原图 → 把压缩图 + 原图尺寸 + 当前凭证（Key/Model/BaseURL） 一起发到 /api/detect →
 * 后端调用 Claude 拿回 类别 + 边界框（坐标是 0-1000 归一化，相对压缩图）→
 * 前端用 **原图** 的宽高换算回像素，把框画到原图 canvas 上。
 *
 * 关键不变量：
 *  - 模型看到的图 = 压缩图（节省 payload / token）
 *  - 框画回 = 原图（避免压缩重采样带来的几何误差）
 *  - API Key / Model / BaseURL 存在浏览器 localStorage；改完保存即时生效，无需刷新
 */

// ---------- DOM 引用 ----------
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

// 设置面板相关
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

// 当前选中的图片
let originalImg = null;
let originalDataUrl = null;
let compressedDataUrl = null;

// ---------- 配色 ----------
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
// 配置层：localStorage 读写
// ============================================================

const LS_KEYS = {
  provider: 'vt:provider',
  apiKey: 'vt:apiKey',
  model: 'vt:model',
  baseUrl: 'vt:baseUrl',
};

const DEFAULT_PROVIDER = 'anthropic';

// 已知常用模型（UI 下拉；想用别的可以直接在「自定义」里填）

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
      console.warn('localStorage 写入失败：', err);
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
      apiKey: this.get('apiKey'),
      model: this.get('model'),
      baseUrl: this.get('baseUrl'),
    };
  },
};

// ============================================================
// 设置面板 UI
// ============================================================

function openSettings() {
  // 回填当前配置
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
// 关闭按钮：用 mousedown 而不是 click，避免某些浏览器里 click 被吞。
// 同时 stopPropagation 防止冒泡到 .modal 时被"点遮罩关闭"那条逻辑处理。
settingsClose.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  e.preventDefault(); // 阻止默认的 focus 行为，避免按钮拿到 focus 时有奇怪的 :focus 样式干扰
  closeSettings();
});
// 点遮罩关闭（只在 e.target 严格等于遮罩时）
settingsPanel.addEventListener('click', (e) => {
  if (e.target === settingsPanel) closeSettings();
});

// 显示/隐藏 Key 明文（默认遮住）
toggleKeyVisibility.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  toggleKeyVisibility.textContent = apiKeyInput.type === 'password' ? '显示' : '隐藏';
});

saveSettingsBtn.addEventListener('click', () => {
  // 取选中的 provider
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
    settingsHint.textContent = '❌ API Key 不能为空';
    settingsHint.className = 'settings-hint error';
    return;
  }
  if (!model) {
    settingsHint.textContent = '❌ 模型不能为空';
    settingsHint.className = 'settings-hint error';
    return;
  }
  // baseUrl 留空就当作"走官方"
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    settingsHint.textContent = '❌ Base URL 必须以 http:// 或 https:// 开头';
    settingsHint.className = 'settings-hint error';
    return;
  }

  ConfigStore.set('provider', provider);
  ConfigStore.set('apiKey', apiKey);
  ConfigStore.set('model', model);
  ConfigStore.set('baseUrl', baseUrl); // 空字符串会移除键

  settingsHint.textContent = `✅ 已保存（${provider}），下次检测立即生效`;
  settingsHint.className = 'settings-hint success';

  refreshDetectButton();

  setTimeout(closeSettings, 1500);
});

clearSettingsBtn.addEventListener('click', () => {
  if (!confirm('清空保存的 Provider / API Key / Model / Base URL？')) return;
  ConfigStore.clear();
  for (const r of providerRadios) r.checked = r.value === DEFAULT_PROVIDER;
  apiKeyInput.value = '';
  modelInput.value = '';
  baseUrlInput.value = '';
  settingsHint.textContent = '已清空。服务器 .env 里的配置仍然生效（兜底）。';
  settingsHint.className = 'settings-hint';
  refreshDetectButton();
});

function refreshDetectButton() {
  const hasKey = !!ConfigStore.get('apiKey');
  if (!originalDataUrl) return; // 还没选图时不动按钮的 disabled
  detectBtn.disabled = !hasKey;
  if (!hasKey) {
    setStatus('已选图，但还没配 API Key。点右上角「设置」填写后即可检测。', true);
  }
}

// ============================================================
// 图片读取 + 压缩
// ============================================================

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
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
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

/**
 * 把原图缩到最长边 ≤ maxDim，编码成 JPEG dataURL。
 * 长宽比保持不变；maxDim 不合法（NaN / ≤0）或已经 ≤ maxDim 时返回原图。
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
  return {
    dataUrl: c.toDataURL('image/jpeg', 0.85),
    width: tw,
    height: th,
    scaled: true,
  };
}

// ---------- 展示原图 ----------

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
        `已载入 ${img.naturalWidth}×${img.naturalHeight} 的原图，按「开始检测」时按 ` +
          `最长边 ${maxDimInput.value}px 压缩后调用 ${provider} 模型 ${ConfigStore.get('model') || '默认'}`
      );
      detectBtn.disabled = false;
    } else {
      setStatus('已选图，但还没配 API Key。点右上角「设置」填写后即可检测。', true);
      detectBtn.disabled = true;
    }
  }).catch(() => setStatus('图片解码失败，换一张试试', true));
}

// ---------- 本地上传：点击 + 拖拽 ----------

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
    setStatus('只支持图片文件', true);
    return;
  }
  showOriginalImage(await blobToDataURL(file));
}

// ---------- 数据集缩略图 ----------

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
    setStatus(`读取数据集图片失败：${err.message}`, true);
  }
}

maxDimInput.addEventListener('change', () => {
  if (originalImg) {
    compressedDataUrl = null;
    setStatus(`已切换最长边 ${maxDimInput.value}px，下次检测时生效`);
  }
});

// ============================================================
// 检测
// ============================================================

detectBtn.addEventListener('click', async () => {
  if (!originalDataUrl) return;

  // 实时从 localStorage 取最新配置（用户可能在设置面板改了没刷新）
  const cfg = ConfigStore.snapshot();
  if (!cfg.apiKey) {
    setStatus('请先在右上角「设置」里填写 API Key', true);
    openSettings();
    return;
  }

  detectBtn.disabled = true;
  try {
    // 1. 压缩
    if (!compressedDataUrl) {
      setStatus(`按最长边 ${maxDimInput.value}px 压缩中…`);
      const r = await compressImage(originalDataUrl, maxDimInput.value);
      compressedDataUrl = r.dataUrl;
      const ratioKB = (compressedDataUrl.length / 1024).toFixed(0);
      setStatus(
        r.scaled
          ? `压缩完成：${originalImg.naturalWidth}×${originalImg.naturalHeight} → ${r.width}×${r.height}（约 ${ratioKB} KB），正在调模型 ${cfg.model}…`
          : `图片已 ≤ ${maxDimInput.value}px，无需压缩，正在调模型 ${cfg.model}…`
      );
    } else {
      setStatus(`正在调模型 ${cfg.model}…`);
    }

    // 2. 调接口：压缩图 + 原图尺寸 + 当前配置（含 provider）
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
        baseUrl: cfg.baseUrl || undefined, // 空字符串就别发了
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
    renderDetections(data);
    setStatus(
      `检出 ${data.detections.length} 个目标 · [${data.provider}] ${data.model} ` +
        `(${data.configSource?.model || '?'})` +
        ` · 输入 ${data.usage.input_tokens} tokens / 输出 ${data.usage.output_tokens} tokens`
    );
  } catch (err) {
    setStatus(`检测失败：${err.message}`, true);
  } finally {
    detectBtn.disabled = !ConfigStore.get('apiKey');
  }
});

// ============================================================
// 渲染边界框（按原图尺寸）
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

// Esc 关设置面板
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsPanel.hidden) closeSettings();
});

loadSamples();
