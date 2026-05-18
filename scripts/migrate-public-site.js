/**
 * migrate-public-site.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrates existing store images from flat uploads/store/ into the new
 * category/subcategory folder structure under uploads/publicApp/.
 *
 * OLD: uploads/store/filename.jpg
 * NEW:
 *   Category images:    uploads/publicApp/category/<CategoryName>/filename
 *   Subcategory images: uploads/publicApp/category/<CategoryName>/<SubName>/filename
 *   Testimonials:       uploads/publicApp/testimonials/  (no existing files to move)
 *
 * USAGE (run from backend/):
 *   node scripts/migrate-public-site.js --dry-run
 *   node scripts/migrate-public-site.js
 *
 * SAFETY:
 *   - Files are COPIED, originals kept until you verify
 *   - MongoDB updated only after file copy succeeds
 *   - Already-migrated URLs (containing publicApp) are skipped automatically
 *   - Log written to scripts/migration-public-site-log.json
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const StoreCategory = require('../models/public-site/StoreCategory');

const MONGO_URI  = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bizManager';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LOG_FILE   = path.join(__dirname, 'migration-public-site-log.json');
const DRY_RUN    = process.argv.includes('--dry-run');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeName(name) {
  return (name || 'uncategorised')
    .trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_');
}

function ensureDir(dir) {
  if (!DRY_RUN && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(oldAbsPath, newAbsPath) {
  if (!fs.existsSync(oldAbsPath)) return { ok: false, error: `Source not found: ${oldAbsPath}` };
  if (DRY_RUN) return { ok: true };
  try {
    ensureDir(path.dirname(newAbsPath));
    fs.copyFileSync(oldAbsPath, newAbsPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function printHeader(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function printSection(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

// ─── MIGRATION ────────────────────────────────────────────────────────────────

const log = {
  dryRun: DRY_RUN,
  startedAt: new Date().toISOString(),
  categories: [],
  summary: { migrated: 0, skipped: 0, failed: 0 },
};

async function migrateCategory(cat) {
  const catName    = cat.name;
  const safeCatDir = path.join(PUBLIC_DIR, 'uploads', 'publicApp', 'category', safeName(catName));
  let catMigrated  = 0, catSkipped = 0, catFailed = 0;

  console.log(`\n  [CATEGORY] ${catName}`);

  // ── Category-level images ──────────────────────────────────────────────────
  const newImages = [];
  let imagesChanged = false;

  for (const img of (cat.images || [])) {
    if (!img.url || img.url.includes('publicApp')) {
      console.log(`    [SKIP] ${img.filename || img.url} — already migrated`);
      newImages.push(img);
      catSkipped++;
      continue;
    }

    const filename   = path.basename(img.url);
    const oldAbsPath = path.join(PUBLIC_DIR, img.url.replace(/^\//, ''));
    const newUrl     = `/uploads/publicApp/category/${safeName(catName)}/${filename}`;
    const newAbsPath = path.join(safeCatDir, filename);

    console.log(`    [img] old: ${img.url}`);
    console.log(`    [img] new: ${newUrl}`);

    const { ok, error } = copyFile(oldAbsPath, newAbsPath);
    if (!ok) {
      console.log(`    ✗ FAILED: ${error}`);
      newImages.push(img);
      catFailed++;
    } else {
      console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
      const updated = img.toObject ? img.toObject() : { ...img };
      newImages.push({ ...updated, url: newUrl });
      imagesChanged = true;
      catMigrated++;
    }
  }

  // ── Subcategory images ─────────────────────────────────────────────────────
  const newSubcategories = [];
  let subsChanged = false;

  for (const sub of (cat.subcategories || [])) {
    const subName    = sub.name;
    const safeSubDir = path.join(safeCatDir, safeName(subName));
    const newSubImages = [];
    let subImagesChanged = false;

    console.log(`    [SUBCATEGORY] ${catName} / ${subName}`);

    for (const img of (sub.images || [])) {
      if (!img.url || img.url.includes('publicApp')) {
        console.log(`      [SKIP] ${img.filename || img.url} — already migrated`);
        newSubImages.push(img);
        catSkipped++;
        continue;
      }

      const filename   = path.basename(img.url);
      const oldAbsPath = path.join(PUBLIC_DIR, img.url.replace(/^\//, ''));
      const newUrl     = `/uploads/publicApp/category/${safeName(catName)}/${safeName(subName)}/${filename}`;
      const newAbsPath = path.join(safeSubDir, filename);

      console.log(`      [img] old: ${img.url}`);
      console.log(`      [img] new: ${newUrl}`);

      const { ok, error } = copyFile(oldAbsPath, newAbsPath);
      if (!ok) {
        console.log(`      ✗ FAILED: ${error}`);
        newSubImages.push(img);
        catFailed++;
      } else {
        console.log(`      ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
        const updated = img.toObject ? img.toObject() : { ...img };
        newSubImages.push({ ...updated, url: newUrl });
        subImagesChanged = true;
        catMigrated++;
      }
    }

    const subObj = sub.toObject ? sub.toObject() : { ...sub };
    if (subImagesChanged) {
      newSubcategories.push({ ...subObj, images: newSubImages });
      subsChanged = true;
    } else {
      newSubcategories.push(subObj);
    }
  }

  // ── Update MongoDB ─────────────────────────────────────────────────────────
  if ((imagesChanged || subsChanged) && !DRY_RUN) {
    const updatePayload = {};
    if (imagesChanged)  updatePayload.images        = newImages;
    if (subsChanged)    updatePayload.subcategories  = newSubcategories;
    await StoreCategory.findByIdAndUpdate(cat._id, { $set: updatePayload });
    console.log(`    ✓ MongoDB updated`);
  }

  log.categories.push({
    name: catName,
    migrated: catMigrated,
    skipped:  catSkipped,
    failed:   catFailed,
  });

  log.summary.migrated += catMigrated;
  log.summary.skipped  += catSkipped;
  log.summary.failed   += catFailed;
}

async function main() {
  printHeader(DRY_RUN ? 'PUBLIC SITE DRY-RUN (no changes)' : 'RUNNING PUBLIC SITE MIGRATION');

  console.log(`\n  MongoDB : ${MONGO_URI}`);
  console.log(`  Dry run : ${DRY_RUN}`);

  await mongoose.connect(MONGO_URI);
  console.log('  Connected to MongoDB.');

  // Create base dirs
  if (!DRY_RUN) {
    ensureDir(path.join(PUBLIC_DIR, 'uploads', 'publicApp', 'category'));
    ensureDir(path.join(PUBLIC_DIR, 'uploads', 'publicApp', 'testimonials'));
  }

  printSection('STORE CATEGORIES');

  const categories = await StoreCategory.find({});
  console.log(`  Found ${categories.length} categories`);

  for (const cat of categories) {
    await migrateCategory(cat);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n  Summary:`);
  console.log(`    migrated : ${log.summary.migrated}`);
  console.log(`    skipped  : ${log.summary.skipped}`);
  console.log(`    failed   : ${log.summary.failed}`);

  log.finishedAt = new Date().toISOString();
  if (!DRY_RUN) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    console.log(`\n  Log written to: ${LOG_FILE}`);
  }

  printHeader('DONE');
  if (DRY_RUN) {
    console.log('\n  Dry run complete. Run without --dry-run to migrate.');
  } else {
    console.log('\n  Migration complete. Original files in uploads/store/ NOT deleted.');
    console.log('  Verify images load on www.marqland.com, then clean up:');
    console.log('    backend/public/uploads/store/');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  mongoose.disconnect();
  process.exit(1);
});