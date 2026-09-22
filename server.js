/**
 * vision-test backend (multi-provider proxy mode)
 *
 * Responsibilities:
 * 1. Serve the frontend (public/) and the COCO8 sample dataset (datasets/).
 * 2. GET  /api/samples — list sample images for the thumbnails.
 * 3. POST /api/detect  — accept image + provider + Key + Model + BaseURL,
 *    dispatch to the matching SDK (Anthropic / OpenAI-compatible),
 *    parse the JSON (classes + bboxes) the model returns,
 *    and forward it to the frontend for rendering.
 *
 * Credential handling:
 *   - Browsers cannot hit LLM APIs directly (CORS), so the frontend
 *     forwards the API key here.
 *   - Keys live in memory only (never logged, never persisted on disk).
 *     The frontend owns localStorage caching.
 *   - .env / process.env values (ANTHROPIC_API_KEY / OPENAI_API_KEY …)
 *     act as fallback: if the request carries a value, it wins.
 */
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;

const PORT = process.env.PORT || 3000;

// Default models (used when the request body doesn't specify one)
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
};

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/datasets', express.static(path.join(__dirname, 'datasets')));

/**
 * Detection prompt sent to the model.
 * Box coordinates use 0-1000 normalized integers
 * (top-left = 0,0; bottom-right = 1000,1000). This is the convention
 * Anthropic officially recommends, and OpenAI models handle it well too.
 * The frontend scales these back to pixels using the original image's
 * actual dimensions.
 */
const DETECT_PROMPT = `Detect all notable objects in this image.

Return ONLY a valid JSON array (no markdown fences, no extra text), where each element is:
{"name": "<short object class in English, e.g. person, car, dog>", "bbox_2d": [x1, y1, x2, y2]}

bbox_2d uses integers in the range 0-1000 on both axes:
(0,0) is the top-left corner of the image, (1000,1000) is the bottom-right corner.
x1 < x2, y1 < y2. If no objects are found, return [].`;

/**
 * Parse the model's reply text into an array of detections.
 * Models occasionally wrap the JSON in ```json fences or add a sentence
 * around it, so we strip the fences and slice from the first [ to the
 * last ] before parsing.
 */
function parseDetections(text) {
  const stripped = text.replace(/```/g, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error('No JSON array found in model reply');
  }
  const arr = JSON.parse(stripped.slice(start, end + 1));

  if (!Array.isArray(arr)) throw new Error('Model reply is not a JSON array');

  return arr.map((item, i) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.bbox_2d) ||
      item.bbox_2d.length !== 4 ||
      !item.bbox_2d.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      throw new Error(`Detection #${i + 1} has the wrong shape: ${JSON.stringify(item)}`);
    }
    return { name: item.name, bbox_2d: item.bbox_2d };
  });
}

// ---------- Sample image listing ----------
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
// Provider adapters
// ============================================================

/**
 * Anthropic adapter
 * Input: data URL, mime, prompt, {apiKey, baseURL, model}
 * Output: { text, usage }
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
 * OpenAI-compatible adapter
 * Same inputs as the Anthropic one; the image uses image_url (a data URL
 * is a valid value OpenAI accepts).
 * Output: { text, usage }
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
// Detect endpoint
// ============================================================

app.post('/api/detect', async (req, res) => {
  // 1. Validate image (data URL → mime + base64)
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s.exec(req.body.image || '');
  if (!match) {
    return res.status(400).json({ error: 'Unsupported image format. Please upload JPEG / PNG / WebP / GIF.' });
  }
  const mediaType = match[1];
  const base64 = match[2];

  // 2. Validate originalSize (frontend uses it to scale 0-1000 bboxes
  //    back to original-image pixel coords)
  const originalSize = req.body.originalSize;
  if (
    !originalSize ||
    typeof originalSize.width !== 'number' ||
    typeof originalSize.height !== 'number' ||
    originalSize.width <= 0 ||
    originalSize.height <= 0
  ) {
    return res.status(400).json({ error: 'Missing originalSize: { width, height }' });
  }

  // 3. Resolve provider (default 'anthropic' for backwards compatibility)
  const provider = String(req.body.provider || 'anthropic').toLowerCase();
  if (!['anthropic', 'openai'].includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider: ${provider} (allowed: anthropic / openai)` });
  }

  // 4. Resolve API key (request body wins, env is fallback)
  let apiKey =
    (req.body.apiKey && String(req.body.apiKey).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return res.status(400).json({
      error: `Missing API key for ${provider}. Please fill it in via the in-app Settings (⚙), or set ${
        provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      } in the server's .env file.`,
    });
  }

  // 5. baseURL and model
  const baseURL =
    (req.body.baseUrl && String(req.body.baseUrl).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL) ||
    undefined;
  const model =
    (req.body.model && String(req.body.model).trim()) ||
    (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.MODEL) ||
    DEFAULT_MODELS[provider];

  // 6. Dispatch to the right provider
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
  console.log(`vision-test running at: http://localhost:${PORT}`);
  console.log(
    `Providers available: anthropic${process.env.ANTHROPIC_API_KEY ? ' (key: .env)' : ''} / ` +
      `openai${process.env.OPENAI_API_KEY ? ' (key: .env)' : ''}`
  );
  console.log(
    `  → Switch provider / model / key anytime in the in-app Settings (⚙) — no restart needed.`
  );
});
