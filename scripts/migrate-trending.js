/**
 * migrate-trending.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrates existing trending product images to internalApp structure.
 *
 * OLD: uploads/trending/<filename>.jpg
 * NEW: uploads/internalApp/trending/<filename>.jpg
 *
 * USAGE (run from backend/):
 *   node scripts/migrate-trending.js --dry-run
 *   node scripts/migrate-trending.js
 *
 * SAFETY: Files copied, originals kept. MongoDB updated after copy succeeds.
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TrendingProduct = require('../models/TrendingProduct');

const MONGO_URI  = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bizManager';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DRY_RUN    = process.argv.includes('--dry-run');

function printHeader(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function copyFile(oldAbsPath, newAbsPath) {
  if (!fs.existsSync(oldAbsPath)) return { ok: false, error: `Source not found: ${oldAbsPath}` };
  if (DRY_RUN) return { ok: true };
  try {
    const dir = path.dirname(newAbsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(oldAbsPath, newAbsPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  printHeader(DRY_RUN ? 'TRENDING DRY-RUN (no changes)' : 'RUNNING TRENDING MIGRATION');

  await mongoose.connect(MONGO_URI);
  console.log('  Connected to MongoDB.');

  const products = await TrendingProduct.find({
    imageUrl: { $regex: '^/uploads/trending/' }
  });

  console.log(`\n  Found ${products.length} trending products with local images to migrate`);

  let migrated = 0, skipped = 0, failed = 0;

  for (const product of products) {
    if (!product.imageUrl || product.imageUrl.includes('internalApp')) {
      skipped++;
      continue;
    }

    const filename   = path.basename(product.imageUrl);
    const oldAbsPath = path.join(PUBLIC_DIR, product.imageUrl.replace(/^\//, ''));
    const newUrl     = `/uploads/internalApp/trending/${filename}`;
    const newAbsPath = path.join(PUBLIC_DIR, 'uploads', 'internalApp', 'trending', filename);

    console.log(`  [TRENDING] ${product.name?.slice(0, 50)}`);
    console.log(`    old: ${product.imageUrl}`);
    console.log(`    new: ${newUrl}`);

    const { ok, error } = copyFile(oldAbsPath, newAbsPath);

    if (!ok) {
      console.log(`    ✗ FAILED: ${error}`);
      failed++;
    } else {
      console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
      if (!DRY_RUN) {
        await TrendingProduct.findByIdAndUpdate(product._id, { $set: { imageUrl: newUrl } });
        console.log(`    ✓ MongoDB updated`);
      }
      migrated++;
    }
  }

  console.log(`\n  Summary:`);
  console.log(`    migrated : ${migrated}`);
  console.log(`    skipped  : ${skipped}`);
  console.log(`    failed   : ${failed}`);

  printHeader('DONE');
  if (DRY_RUN) {
    console.log('\n  Dry run complete. Run without --dry-run to migrate.');
  } else {
    console.log('\n  Migration complete. Original files NOT deleted.');
    console.log('  Verify images load, then delete: uploads/trending/');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  mongoose.disconnect();
  process.exit(1);
});