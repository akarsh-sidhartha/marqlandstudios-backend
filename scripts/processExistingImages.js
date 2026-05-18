/**
 * backend/scripts/processExistingImages.js
 *
 * ONE-TIME batch script — processes all existing product images in production.
 * Run it, wait for it to finish, then retire it (delete the file).
 *
 * Usage:
 *   node scripts/processExistingImages.js
 *   node scripts/processExistingImages.js --dry-run        (preview, no changes)
 *   node scripts/processExistingImages.js --limit 20       (process first 20 only)
 *   node scripts/processExistingImages.js --category "Bags"
 *
 * Progress is saved to scripts/process-progress.json so if it's interrupted
 * you can re-run and it will skip already-processed products.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const Product  = require('../models/product');
const { processAndSaveImage } = require('../services/imageProcessingService');

const PROGRESS_FILE = path.join(__dirname, 'process-progress.json');
const PUBLIC_DIR    = path.join(__dirname, '../public');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const limitArg   = args.indexOf('--limit');
const LIMIT      = limitArg   !== -1 ? parseInt(args[limitArg + 1])   : Infinity;
const catArg     = args.indexOf('--category');
const FILTER_CAT = catArg !== -1 ? args[catArg + 1] : null;

// ── Progress tracking ─────────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch { /* ignore corrupt file */ }
  return { processed: [], failed: [], lastRun: null };
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bizManager');
  console.log('✅ Connected to MongoDB');

  const progress = loadProgress();

  const query = {};
  if (FILTER_CAT) query.category = FILTER_CAT;
  const products = await Product.find(query).lean();

  // Skip already processed (.webp) and already done in this run
  const pending = products
    .filter(p =>
      p.imageUrl &&
      !p.imageUrl.endsWith('.webp') &&
      !progress.processed.includes(p._id.toString())
    )
    .slice(0, LIMIT);

  console.log(`\n📦 Total products:    ${products.length}`);
  console.log(`⏳ Pending:           ${pending.length}`);
  console.log(`✅ Already done:      ${progress.processed.length}`);
  console.log(`❌ Previously failed: ${progress.failed.length}`);
  if (FILTER_CAT) console.log(`🔍 Category filter:   ${FILTER_CAT}`);
  if (DRY_RUN)    console.log(`\n🔍 DRY RUN — no changes will be made`);
  console.log('\n' + '─'.repeat(60));

  let done = 0, failed = 0;

  for (const product of pending) {
    const id      = product._id.toString();
    const imgPath = path.join(PUBLIC_DIR, product.imageUrl);
    const outPath = imgPath.replace(/\.[^.]+$/, '-proc.webp');
    const newUrl  = product.imageUrl.replace(/\.[^.]+$/, '-proc.webp');

    const label = `[${done + failed + 1}/${pending.length}] ${product.name} (${product.category})`;
    process.stdout.write(`  ${label} ... `);

    if (!fs.existsSync(imgPath)) {
      console.log('⚠  file not found on disk, skipping');
      progress.failed.push(id);
      saveProgress(progress);
      failed++;
      continue;
    }

    if (DRY_RUN) {
      console.log('(dry run — would process)');
      done++;
      continue;
    }

    try {
      await processAndSaveImage(imgPath, outPath, { category: product.category });
      await Product.findByIdAndUpdate(id, { imageUrl: newUrl });
      progress.processed.push(id);
      saveProgress(progress);
      done++;
      console.log('✅');
    } catch (err) {
      console.log(`❌  ${err.message}`);
      progress.failed.push(id);
      saveProgress(progress);
      failed++;
    }
  }

  progress.lastRun = new Date().toISOString();
  saveProgress(progress);

  console.log('\n' + '─'.repeat(60));
  console.log(`✅ Processed: ${done}`);
  console.log(`❌ Failed:    ${failed}`);
  console.log(`\nProgress saved → scripts/process-progress.json`);
  if (failed > 0) {
    console.log('To retry failed: remove their IDs from "failed" array and re-run.');
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });