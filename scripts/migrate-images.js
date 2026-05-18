/**
 * migrate-images.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrates existing product and property attachment files from the flat
 * uploads/ structure to the new internalApp/ folder structure.
 *
 * NEW STRUCTURE:
 *   Products:    uploads/internalApp/products/<Category>/filename
 *   Properties:  uploads/internalApp/property/day_outing/filename
 *                uploads/internalApp/property/night_stay/filename
 *
 * USAGE:
 *   Place this file in:  backend/scripts/migrate-images.js
 *   Run from backend/:   node scripts/migrate-images.js
 *
 * FLAGS:
 *   --dry-run     Print what would happen without moving any files or
 *                 touching MongoDB. Always run this first.
 *   --products    Migrate only products
 *   --properties  Migrate only properties
 *   (no flag)     Migrate both
 *
 * EXAMPLES:
 *   node scripts/migrate-images.js --dry-run
 *   node scripts/migrate-images.js --dry-run --products
 *   node scripts/migrate-images.js --products
 *   node scripts/migrate-images.js --properties
 *   node scripts/migrate-images.js
 *
 * SAFETY:
 *   - Files are COPIED to the new location, originals are kept
 *   - MongoDB is only updated after the file copy succeeds
 *   - Every action is logged to console AND to migration-log.json
 *   - If a file is not found on disk, the document is skipped with a warning
 *   - Run --dry-run first, review the output, then run for real
 *   - Re-running is safe: already-migrated URLs (containing 'internalApp')
 *     are detected and skipped automatically
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const mongoose  = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─── Models ───────────────────────────────────────────────────────────────────
const Product  = require('../models/product');
const Property = require('../models/Property');

// ─── Config ───────────────────────────────────────────────────────────────────
const MONGO_URI   = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bizManager';
const PUBLIC_DIR  = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const LOG_FILE    = path.join(__dirname, 'migration-log.json');

const DRY_RUN         = process.argv.includes('--dry-run');
const ONLY_PRODUCTS   = process.argv.includes('--products');
const ONLY_PROPERTIES = process.argv.includes('--properties');

// Run both if neither flag given
const RUN_PRODUCTS   = ONLY_PRODUCTS   || (!ONLY_PRODUCTS && !ONLY_PROPERTIES);
const RUN_PROPERTIES = ONLY_PROPERTIES || (!ONLY_PRODUCTS && !ONLY_PROPERTIES);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sanitise a category name to a safe folder name.
 *  Mirrors the logic in the updated productRoutes.js */
function safeFolderName(name) {
  return (name || 'uncategorised')
    .trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_');
}

/** Given an old /uploads/... URL, return the absolute path on disk */
function urlToAbsPath(url) {
  // url is like /uploads/filename.jpg  or  /uploads/property-attachments/file.pdf
  const relative = url.replace(/^\//, '');   // strip leading slash
  return path.join(PUBLIC_DIR, relative);
}

/** Build the new URL for a product image */
function newProductUrl(category, filename) {
  const cat = safeFolderName(category);
  return `/uploads/internalApp/products/${cat}/${filename}`;
}

/** Build the new URL for a property attachment */
function newPropertyUrl(type, filename) {
  const subfolder = type === 'Night Stay' ? 'night_stay' : 'day_outing';
  return `/uploads/internalApp/property/${subfolder}/${filename}`;
}

/** Ensure a directory exists (no-op in dry-run) */
function ensureDir(dir) {
  if (!DRY_RUN && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy a file from oldAbsPath to newAbsPath.
 * Returns { ok, error }.
 * In dry-run mode, just checks that the source exists.
 */
function copyFile(oldAbsPath, newAbsPath) {
  if (!fs.existsSync(oldAbsPath)) {
    return { ok: false, error: `Source not found: ${oldAbsPath}` };
  }
  if (DRY_RUN) {
    return { ok: true, error: null };
  }
  try {
    ensureDir(path.dirname(newAbsPath));
    fs.copyFileSync(oldAbsPath, newAbsPath);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Log accumulator ─────────────────────────────────────────────────────────
const log = {
  dryRun: DRY_RUN,
  startedAt: new Date().toISOString(),
  products: { migrated: [], skipped: [], failed: [] },
  properties: { migrated: [], skipped: [], failed: [] },
};

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

// ─── PRODUCT MIGRATION ────────────────────────────────────────────────────────

async function migrateProducts() {
  printSection('PRODUCTS');

  const products = await Product.find({});
  console.log(`  Found ${products.length} product documents`);

  let migratedCount = 0, skippedCount = 0, failedCount = 0;

  for (const product of products) {
    const id   = product._id.toString();
    const name = product.name || id;
    const cat  = product.category || 'uncategorised';

    // ── Primary image ──────────────────────────────────────────────────────
    if (product.imageUrl) {
      if (product.imageUrl.includes('internalApp')) {
        console.log(`  [SKIP] ${name} — imageUrl already migrated`);
        log.products.skipped.push({ id, name, reason: 'already migrated', url: product.imageUrl });
        skippedCount++;
      } else {
        const oldAbsPath = urlToAbsPath(product.imageUrl);
        const filename   = path.basename(product.imageUrl);
        const newUrl     = newProductUrl(cat, filename);
        const newAbsPath = path.join(PUBLIC_DIR, newUrl.replace(/^\//, ''));

        console.log(`  [PRODUCT] ${name}`);
        console.log(`    category : ${cat}`);
        console.log(`    old url  : ${product.imageUrl}`);
        console.log(`    new url  : ${newUrl}`);

        const { ok, error } = copyFile(oldAbsPath, newAbsPath);

        if (!ok) {
          console.log(`    ✗ FAILED : ${error}`);
          log.products.failed.push({ id, name, field: 'imageUrl', oldUrl: product.imageUrl, newUrl, error });
          failedCount++;
        } else {
          console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);

          // ── Also migrate additionalImages for this product ───────────────
          const newAdditional = [];
          let additionalChanged = false;

          for (const imgUrl of (product.additionalImages || [])) {
            if (imgUrl.includes('internalApp')) {
              newAdditional.push(imgUrl);
              continue;
            }
            const af        = path.basename(imgUrl);
            const newAUrl   = newProductUrl(cat, af);
            const newAPath  = path.join(PUBLIC_DIR, newAUrl.replace(/^\//, ''));
            const oldAPath  = urlToAbsPath(imgUrl);
            const { ok: aOk, error: aErr } = copyFile(oldAPath, newAPath);
            if (aOk) {
              console.log(`    ✓ additionalImage: ${af} -> ${newAUrl}`);
              newAdditional.push(newAUrl);
              additionalChanged = true;
            } else {
              console.log(`    ✗ additionalImage FAILED: ${aErr}`);
              newAdditional.push(imgUrl); // keep old url if copy failed
            }
          }

          // ── Update MongoDB ───────────────────────────────────────────────
          if (!DRY_RUN) {
            const updatePayload = { imageUrl: newUrl };
            if (additionalChanged) updatePayload.additionalImages = newAdditional;
            await Product.findByIdAndUpdate(id, { $set: updatePayload });
            console.log(`    ✓ MongoDB updated`);
          }

          log.products.migrated.push({ id, name, oldUrl: product.imageUrl, newUrl });
          migratedCount++;
        }
      }
    } else {
      console.log(`  [SKIP] ${name} — no imageUrl`);
      log.products.skipped.push({ id, name, reason: 'no imageUrl' });
      skippedCount++;
    }
  }

  console.log(`\n  Products summary:`);
  console.log(`    migrated : ${migratedCount}`);
  console.log(`    skipped  : ${skippedCount}`);
  console.log(`    failed   : ${failedCount}`);
}

// ─── PROPERTY MIGRATION ───────────────────────────────────────────────────────

async function migrateProperties() {
  printSection('PROPERTIES');

  const properties = await Property.find({});
  console.log(`  Found ${properties.length} property documents`);

  let migratedCount = 0, skippedCount = 0, failedCount = 0;

  for (const property of properties) {
    const id   = property._id.toString();
    const name = property.propertyName || id;
    const type = property.type || 'Day Outing'; // 'Day Outing' | 'Night Stay'

    const hasImageUrl   = !!property.imageUrl;
    const hasAttachments = property.attachments && property.attachments.length > 0;

    if (!hasImageUrl && !hasAttachments) {
      console.log(`  [SKIP] ${name} — no imageUrl and no attachments`);
      log.properties.skipped.push({ id, name, reason: 'nothing to migrate' });
      skippedCount++;
      continue;
    }

    console.log(`  [PROPERTY] ${name}  (type: ${type})`);

    const updatePayload = {};
    let anyChanged = false;
    let anyFailed  = false;

    // ── imageUrl ────────────────────────────────────────────────────────────
    // Only migrate local /uploads/... paths — external http URLs are just
    // links and have no file on disk to move.
    if (hasImageUrl) {
      if (property.imageUrl.startsWith('http')) {
        console.log(`    [SKIP] imageUrl is external URL — no file to migrate`);
      } else if (property.imageUrl.includes('internalApp')) {
        console.log(`    [SKIP] imageUrl already migrated`);
      } else {
        const filename   = path.basename(property.imageUrl);
        const oldAbsPath = urlToAbsPath(property.imageUrl);
        const newUrl     = newPropertyUrl(type, filename);
        const newAbsPath = path.join(PUBLIC_DIR, newUrl.replace(/^\//, ''));

        console.log(`    imageUrl old: ${property.imageUrl}`);
        console.log(`    imageUrl new: ${newUrl}`);

        const { ok, error } = copyFile(oldAbsPath, newAbsPath);
        if (!ok) {
          console.log(`    ✗ FAILED: ${error}`);
          anyFailed = true;
          log.properties.failed.push({ id, name, field: 'imageUrl', oldUrl: property.imageUrl, newUrl, error });
          failedCount++;
        } else {
          console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
          updatePayload.imageUrl = newUrl;
          anyChanged = true;
        }
      }
    }

    // ── attachments ─────────────────────────────────────────────────────────
    const newAttachments = [];
    let attachmentsChanged = false;

    for (const att of (property.attachments || [])) {
      if (!att.url) { newAttachments.push(att); continue; }

      if (att.url.includes('internalApp')) {
        console.log(`    [SKIP] attachment ${att.name} — already migrated`);
        newAttachments.push(att);
        continue;
      }

      const filename   = path.basename(att.url);
      const oldAbsPath = urlToAbsPath(att.url);
      const newUrl     = newPropertyUrl(type, filename);
      const newAbsPath = path.join(PUBLIC_DIR, newUrl.replace(/^\//, ''));

      console.log(`    attachment old: ${att.url}`);
      console.log(`    attachment new: ${newUrl}`);

      const { ok, error } = copyFile(oldAbsPath, newAbsPath);
      if (!ok) {
        console.log(`    ✗ FAILED: ${error}`);
        newAttachments.push(att);
        anyFailed = true;
        log.properties.failed.push({ id, name, file: att.name, oldUrl: att.url, newUrl, error });
        failedCount++;
      } else {
        console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
        newAttachments.push({ ...att.toObject(), url: newUrl });
        attachmentsChanged = true;
        anyChanged = true;
      }
    }

    if (attachmentsChanged) updatePayload.attachments = newAttachments;

    if (anyChanged && !DRY_RUN) {
      await Property.findByIdAndUpdate(id, { $set: updatePayload });
      console.log(`    ✓ MongoDB updated`);
    }

    if (anyChanged) {
      log.properties.migrated.push({ id, name, type });
      migratedCount++;
    } else if (!anyFailed) {
      log.properties.skipped.push({ id, name, reason: 'all already migrated' });
      skippedCount++;
    }
  }

  console.log(`\n  Properties summary:`);
  console.log(`    migrated : ${migratedCount}`);
  console.log(`    skipped  : ${skippedCount}`);
  console.log(`    failed   : ${failedCount}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  printHeader(DRY_RUN ? 'MIGRATION DRY-RUN (no changes will be made)' : 'RUNNING MIGRATION');

  console.log(`\n  MongoDB  : ${MONGO_URI}`);
  console.log(`  Uploads  : ${UPLOADS_DIR}`);
  console.log(`  Products : ${RUN_PRODUCTS}`);
  console.log(`  Properties: ${RUN_PROPERTIES}`);
  console.log(`  Dry run  : ${DRY_RUN}`);

  // ── Connect ────────────────────────────────────────────────────────────────
  console.log('\n  Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('  Connected.\n');

  // ── Create base dirs (unless dry-run) ─────────────────────────────────────
  if (!DRY_RUN) {
    ensureDir(path.join(UPLOADS_DIR, 'internalApp', 'products'));
    ensureDir(path.join(UPLOADS_DIR, 'internalApp', 'property', 'day_outing'));
    ensureDir(path.join(UPLOADS_DIR, 'internalApp', 'property', 'night_stay'));
  }

  // ── Run migrations ─────────────────────────────────────────────────────────
  if (RUN_PRODUCTS)   await migrateProducts();
  if (RUN_PROPERTIES) await migrateProperties();

  // ── Write log file ─────────────────────────────────────────────────────────
  log.finishedAt = new Date().toISOString();
  if (!DRY_RUN) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    console.log(`\n  Log written to: ${LOG_FILE}`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  printHeader('DONE');
  if (DRY_RUN) {
    console.log('\n  This was a DRY RUN. No files were moved, no DB changes made.');
    console.log('  Review the output above, then run without --dry-run to migrate.');
  } else {
    console.log('\n  Migration complete. Original files were NOT deleted.');
    console.log('  Verify images load correctly in the app, then you can');
    console.log('  delete the old uploads/ root files and property-attachments/.');
    console.log('\n  Files to clean up after verification:');
    console.log('    backend/public/uploads/*.jpg');
    console.log('    backend/public/uploads/*.webp');
    console.log('    backend/public/uploads/property-attachments/');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n  FATAL ERROR:', err.message);
  mongoose.disconnect();
  process.exit(1);
});