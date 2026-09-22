/**
 * vision-test 服务端（多 Provider 代理模式）
 *
 * 职责：
 * 1. 托管前端页面（public/）和 YOLO 样例数据集（datasets/）
 * 2. GET  /api/samples —— 列出数据集里的样例图片
 * 3. POST /api/detect —— 接收前端传来的图片 + provider + Key + Model + BaseURL，
 *    根据 provider 分发到不同 SDK（Anthropic / OpenAI-compatible），
 *    把模型返回的 JSON（类别 + 边界框）解析后回传给前端渲染。
 *
 * 凭证约定：
 *   - 浏览器无法直连 LLM API（无 CORS），所以前端把 Key 发到这里转发。
 *   - Key 永远只活在内存里（不写日志、不落盘），前端负责 localStorage 缓存。
 *   - .env / 环境变量里的 ANTHROPIC_API_KEY / OPENAI_API_KEY 等仍然生效，
 *     作为 fallback；只要请求里带了对应字段，就用请求里的。
 */
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;

const PORT = process.env.PORT || 3000;

// 默认模型（请求体里没指定时用这个）
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
};

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/datasets', express.static(path.join(__dirname, 'datasets')));

/**
 * 给模型的检测指令。
 * 坐标约定用 0-1000 的归一化整数（左上角是 0,0，右下角是 1000,1000），
 * 这是 Anthropic 官方推荐的写法；OpenAI 我们也沿用同样的约定，模型表现稳定。
 * 前端拿到后再按图片实际宽高换算回像素。
 */
const DETECT_PROMPT = `Detect all notable objects in this image.

Return ONLY a valid JSON array (no markdown fences, no extra text), where each element is:
{"name": "<short object class in English, e.g. person, car, dog>", "bbox_2d": [x1, y1, x2, y2]}

bbox_2d uses integers in the range 0-1000 on both axes:
(0,0) is the top-left corner of the image, (1000,1000) is the bottom-right corner.
x1 < x2, y1 < y2. If no objects are found, return [].`;

/**
 * 从模型的回复文本中解析出检测框数组。
 * 模型偶尔会在 JSON 外面套一层 ```json 代码块或加几句说明，
 * 所以先剥掉围栏，再截取第一个 [ 到最后一个 ] 之间的内容解析。
 */
function parseDetections(text) {
  const stripped = text.replace(/```/g, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error('模型回复里找不到 JSON 数组');
  }
  const arr = JSON.parse(stripped.slice(start, end + 1));

  if (!Array.isArray(arr)) throw new Error('模型回复不是 JSON 数组');

  return arr.map((item, i) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.bbox_2d) ||
      item.bbox_2d.length !== 4 ||
      !item.bbox_2d.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      throw new Error(`第 ${i + 1} 个检测框格式不对：${JSON.stringify(item)}`);
    }
    return { name: item.name, bbox_2d: item.bbox_2d };
  });
}

// ---------- 样例图片列表 ----------
app.get('/api/samples', (req, res) => {
  const datasetDir = path.join(__dirname, 'datasets', 'coco8', 'images');
  const samples = ['train', 'val'].flatMap((split) => {
    const dir = path.join(datasetDir, split);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => ({
        url: `/datasets/coco8/images/${split}/${f}`,
        name: f,
      }));
  });
  res.json(samples);
});

// ============================================================
// Provider 适配层
// ============================================================

/**
 * Anthropic 适配器
 * 输入：data URL、mime、prompt、{apiKey, baseURL, model}
 * 输出：{ text, usage }
 */
async function callAnthropic({ mediaType, base64, prompt, apiKey, baseURL, model }) {
  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const message = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return { text, usage: message.usage };
}

/**
 * OpenAI 兼容适配器
 * 输入同上；image 用 image_url 字段（直接塞 data URL 是 OpenAI 支持的写法）
 * 输出：{ text, usage }
 */
async function callOpenAI({ mediaType, base64, prompt, apiKey, baseURL, model }) {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const dataUrl = `data:${mediaType};base64,${base64}`;
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const choice = response.choices?.[0];
  const text = choice?.message?.content || '';
  return { text, usage: response.usage };
}

// ============================================================
// 检测主接口
// ============================================================

app.post('/api/detect', async (req, res) => {
  // 1. 图片校验
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s.exec(req.body.image || '');
  if (!match) {
    return res.status(400).json({ error: '图片格式不支持，请上传 JPEG / PNG / WebP / GIF' });
  }
  const mediaType = match[1];
  const base64 = match[2];

  // 2. 原图尺寸校验（前端用这个把 0-1000 归一化框换算回原图像素）
  const originalSize = req.body.originalSize;
  if (
    !originalSize ||
    typeof originalSize.width !== 'number' ||
    typeof originalSize.height !== 'number' ||
    originalSize.width <= 0 ||
    originalSize.height <= 0
  ) {
    return res.status(400).json({ error: '缺少 originalSize: { width, height }' });
  }

  // 3. 解析 provider（默认 anthropic，向后兼容老请求）
  const provider = String(req.body.provider || 'anthropic').toLowerCase();
  if (!['anthropic', 'openai'].includes(provider)) {
    return res.status(400).json({ error: `不支持的 provider：${provider}（可选 anthropic / openai）` });
  }

  // 4. 解析 Key（请求体优先，env 兜底）
  let apiKey =
    (req.body.apiKey && String(req.body.apiKey).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return res.status(400).json({
      error: `缺少 ${provider} 的 API Key。请在「设置」里填写，或在服务器 .env 里设置 ${
        provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      }。`,
    });
  }

  // 5. baseURL 和 model
  const baseURL =
    (req.body.baseUrl && String(req.body.baseUrl).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL) ||
    undefined;
  const model =
    (req.body.model && String(req.body.model).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.MODEL) ||
    DEFAULT_MODELS[provider];

  // 6. 调用对应 provider
  try {
    const adapter = provider === 'openai' ? callOpenAI : callAnthropic;
    const { text, usage } = await adapter({
      mediaType,
      base64,
      prompt: DETECT_PROMPT,
      apiKey,
      baseURL,
      model,
    });

    const detections = parseDetections(text);
    res.json({
      detections,
      raw: text,
      model,
      provider,
      usage,
      originalSize,
      configSource: {
        provider: req.body.provider ? 'request' : 'default',
        apiKey: req.body.apiKey ? 'request' : 'env',
        model: req.body.model ? 'request' : (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.MODEL) ? 'env' : 'default',
        baseUrl: req.body.baseUrl ? 'request' : (provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL) ? 'env' : 'default',
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message, raw: err.rawText || null });
  }
});

app.listen(PORT, () => {
  console.log(`vision-test 已启动: http://localhost:${PORT}`);
  console.log(
    `支持 Provider: anthropic${process.env.ANTHROPIC_API_KEY ? ' (Key: .env)' : ''} / ` +
      `openai${process.env.OPENAI_API_KEY ? ' (Key: .env)' : ''}`
  );
  console.log(
    `  → 在页面右上角「设置」里随时切换 provider / 模型 / Key，无需重启`
  );
});
