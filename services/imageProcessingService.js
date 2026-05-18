'use strict';
/**
 * backend/services/imageProcessingService.js
 *
 * Studio-quality product image processing using Google Gemini 2.0 Flash.
 * Sends the product image + a studio photography prompt to Gemini,
 * which returns a transformed photorealistic image.
 *
 * Cost: FREE — 15 req/min, 1500/day on free tier
 * Setup: https://aistudio.google.com → Get API key → GEMINI_API_KEY in .env
 *
 * Fallback: if GEMINI_API_KEY not set, uses sharp-only (white background square).
 */

const sharp  = require('sharp');
const axios  = require('axios');
const fs     = require('fs');
const logger = require('../utils/logger').child({ module: 'imageProcessingService' });

// ── Default studio prompt ─────────────────────────────────────────────────────
const DEFAULT_STUDIO_PROMPT =
`Act as a high-end commercial photographer. Take this product image and perform a professional studio staging.
Lighting: Soft gold rim lighting, cinematic shadows.
Environment: Place product on a matte deep charcoal slate surface.
Quality: Enhance textures to look premium, remove any noise or pixelation.
Style: Minimalist B2B catalog, sharp focus, sophisticated atmosphere.
Output: Clean square format, product centred with breathing room, 1024x1024.`;

// ── Per-category fallback prompts ─────────────────────────────────────────────
const CATEGORY_DEFAULT_PROMPTS = {
  'Electronics':
`Professional product photography of this electronics item on a dark slate surface.
Soft blue-tinted rim lighting, cinematic depth of field.
Premium tech catalog style, sharp details, minimalist background. 1024x1024 square output.`,

  'Bags':
`Luxury fashion photography of this bag on smooth marble surface.
Warm natural lighting from the side, subtle shadow underneath.
High-end retail catalog style, clean cream background. 1024x1024 square output.`,

  'Apparel':
`Studio fashion photography of this apparel on a clean neutral background.
Soft diffused lighting, no harsh shadows.
Premium retail catalog, colours accurate and vibrant. 1024x1024 square output.`,

  'Stationery':
`Flat lay product photography of this stationery on a clean wooden desk surface.
Warm natural light, soft shadows. Modern lifestyle brand catalog. 1024x1024 square output.`,

  'Drinkware':
`Professional product photography of this drinkware on a clean white surface.
Soft side lighting highlighting shape and material texture.
Premium catalog style. 1024x1024 square output.`,

  'Awards':
`Luxury product photography of this award on a dark velvet surface.
Golden rim lighting, dramatic shadows, premium finish.
Corporate prestige catalog style. 1024x1024 square output.`,

  'default': DEFAULT_STUDIO_PROMPT,
};

// ── Auto-discover Gemini image models using the API key ──────────────────────
// Called once at startup — populates global._geminiImageModels
async function discoverGeminiImageModels(apiKey) {
  try {
    const res = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { timeout: 10000 }
    );
    const models = res.data?.models || [];

    // Log all available models so we can see exactly what Google returns
    const allNames = models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));

    // Broad filter — any flash model (image gen models are flash variants)
    // Prefer models with 'image' or 'flash' in name, sorted so image-specific ones come first
    const imageModels = allNames
      .filter(n =>
        n.includes('image') ||
        n.includes('imagen') ||
        n.includes('flash-exp') ||
        n.includes('flash-preview')
      )
      .sort((a, b) => {
        // Put image-specific models first
        const aImg = a.includes('image') ? 0 : 1;
        const bImg = b.includes('image') ? 0 : 1;
        return aImg - bImg;
      });

    if (imageModels.length > 0) {
      global._geminiImageModels = imageModels;
    } else if (allNames.length > 0) {
      // Fallback: use all flash models even if no image-specific ones found
      const flashModels = allNames.filter(n => n.includes('flash'));
      global._geminiImageModels = flashModels;
      logger.warn('No image-specific Gemini models found — using flash models', { flashModels });
    } else {
      logger.warn('Could not determine Gemini models — using hardcoded fallback list');
    }
  } catch (e) {
    logger.warn('Could not auto-discover Gemini models', { error: e.message });
  }
}

// Cache for the working Gemini model name — avoids mutating process.env
// which is a shared global and can cause subtle cross-request bugs.
let _workingGeminiModel = process.env.GEMINI_IMAGE_MODEL || null;

// Run discovery when service is first loaded (if API key is set)
if (process.env.GEMINI_API_KEY) {
  discoverGeminiImageModels(process.env.GEMINI_API_KEY);
}

// ── Gemini 2.0 Flash ──────────────────────────────────────────────────────────
async function processWithGemini(imageBuffer, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY not set — using sharp fallback');
    return null;
  }

  // Always normalize through sharp first — converts any input format to
  // a clean standard JPEG. This fixes "unsupported image format" errors
  // when the buffer comes from PDF extraction or unusual sources.
  let normalizedBuffer;
  try {
    normalizedBuffer = await sharp(imageBuffer).jpeg({ quality: 95 }).toBuffer();
  } catch (sharpErr) {
    logger.warn('Sharp normalisation failed — using raw buffer', { error: sharpErr.message });
    normalizedBuffer = imageBuffer; // use as-is if sharp can't handle it
  }

  // Model candidates — env var first, then auto-discovered, then hardcoded fallbacks
  const envModel = _workingGeminiModel || process.env.GEMINI_IMAGE_MODEL;
  const MODEL_CANDIDATES = [
    ...(envModel ? [envModel] : []),
    ...(global._geminiImageModels || []),   // auto-discovered at startup
    'gemini-2.0-flash-exp-image-generation',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-thinking-exp',
    'gemini-2.0-flash',
  ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

  const requestBody = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: normalizedBuffer.toString('base64') } },
        { text: `${prompt}\n\nGenerate a new photorealistic product image based on the product shown. Output only the transformed image, no text.` },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.4,
    },
  };

  for (const model of MODEL_CANDIDATES) {
    try {
      logger.debug('Trying Gemini model', { model });
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        requestBody,
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      );

      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inline_data?.data) {
          logger.info('Gemini image generation succeeded', { model });
          // Cache working model in module variable — never mutate process.env
          _workingGeminiModel = model;
          return Buffer.from(part.inline_data.data, 'base64');
        }
      }
      const textPart = parts.find(p => p.text);
      logger.warn('Gemini returned text only — trying next model', { model, text: textPart?.text?.slice(0, 60) });
      // Text-only response — try next model

    } catch (err) {
      const status  = err.response?.status;
      const message = err.response?.data?.error?.message || err.message;
      if (status === 404) {
        logger.warn('Gemini model not found', { model });
        continue; // try next model
      }
      if (status === 429) {
        logger.warn('Gemini quota exceeded — using sharp fallback', { model });
        return null; // no point trying other models
      }
      logger.error('Gemini model error', { model, status, error: message });
      // For other errors, try next model
    }
  }

  logger.warn('All Gemini models failed — using sharp fallback');
  return null;
}

// ── Sharp fallback ────────────────────────────────────────────────────────────
async function sharpFallback(imageBuffer) {
  const SIZE = 1024, pad = Math.floor(SIZE * 0.82);
  const resized = await sharp(imageBuffer)
    .resize(pad, pad, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const { width, height } = await sharp(resized).metadata();
  const bg = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
  return sharp(bg)
    .composite([{ input: resized, left: Math.round((SIZE-width)/2), top: Math.round((SIZE-height)/2) }])
    .modulate({ brightness: 1.05, saturation: 1.08 })
    .sharpen({ sigma: 1.2, m1: 1.5, m2: 0.7 })
    .webp({ quality: 92 })
    .toBuffer();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function processProductImage(inputBuffer, options = {}) {
  const { category = 'default', promptText = null } = options;
  const prompt = promptText?.trim()
    || CATEGORY_DEFAULT_PROMPTS[category]
    || CATEGORY_DEFAULT_PROMPTS['default'];

  logger.debug('Processing product image', { category, promptPreview: prompt.slice(0, 60) });
  const result = await processWithGemini(inputBuffer, prompt);
  if (result) {
    return sharp(result)
      .resize(1024, 1024, { fit: 'cover', position: 'centre' })
      .webp({ quality: 92 })
      .toBuffer();
  }
  logger.warn('Gemini unavailable — using sharp fallback', { category });
  return sharpFallback(inputBuffer);
}

async function processAndSaveImage(inputPath, outputPath, options = {}) {
  const buffer    = fs.readFileSync(inputPath);
  const processed = await processProductImage(buffer, options);
  const outPath   = outputPath || inputPath.replace(/\.[^.]+$/, '.webp');
  fs.writeFileSync(outPath, processed);
  return outPath;
}

module.exports = { processProductImage, processAndSaveImage, CATEGORY_DEFAULT_PROMPTS, DEFAULT_STUDIO_PROMPT };