/**
 * migrate-vendors-portal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrates existing vendor and portal attachment files to internalApp structure.
 *
 * NEW STRUCTURE:
 *   Vendors: uploads/internalApp/vendors/
 *   Portal:  uploads/internalApp/portal/
 *
 * USAGE (run from backend/):
 *   node scripts/migrate-vendors-portal.js --dry-run
 *   node scripts/migrate-vendors-portal.js --vendors
 *   node scripts/migrate-vendors-portal.js --portal
 *   node scripts/migrate-vendors-portal.js
 *
 * SAFETY:
 *   - Files are COPIED, originals kept until you verify
 *   - MongoDB updated only after file copy succeeds
 *   - Already-migrated URLs skipped automatically (safe to re-run)
 *   - Log written to scripts/migration-vendors-portal-log.json
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Vendor      = require('../models/Vendor');
const ClientPortal = require('../models/ClientPortal');

const MONGO_URI  = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bizManager';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LOG_FILE   = path.join(__dirname, 'migration-vendors-portal-log.json');

const DRY_RUN       = process.argv.includes('--dry-run');
const ONLY_VENDORS  = process.argv.includes('--vendors');
const ONLY_PORTAL   = process.argv.includes('--portal');
const RUN_VENDORS   = ONLY_VENDORS  || (!ONLY_VENDORS && !ONLY_PORTAL);
const RUN_PORTAL    = ONLY_PORTAL   || (!ONLY_VENDORS && !ONLY_PORTAL);

const log = {
  dryRun: DRY_RUN,
  startedAt: new Date().toISOString(),
  vendors: { migrated: [], skipped: [], failed: [] },
  portal:  { migrated: [], skipped: [], failed: [] },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function urlToAbsPath(url) {
  return path.join(PUBLIC_DIR, url.replace(/^\//, ''));
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

function newVendorUrl(filename) {
  return `/uploads/internalApp/vendors/${filename}`;
}

function newPortalUrl(filename) {
  return `/uploads/internalApp/portal/${filename}`;
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

// ─── VENDOR MIGRATION ─────────────────────────────────────────────────────────
async function migrateVendors() {
  printSection('VENDORS');

  const vendors = await Vendor.find({});
  console.log(`  Found ${vendors.length} vendor documents`);

  let migratedCount = 0, skippedCount = 0, failedCount = 0;

  for (const vendor of vendors) {
    const id   = vendor._id.toString();
    const name = vendor.companyName || id;

    if (!vendor.media || vendor.media.length === 0) {
      console.log(`  [SKIP] ${name} — no media files`);
      log.vendors.skipped.push({ id, name, reason: 'no media' });
      skippedCount++;
      continue;
    }

    console.log(`  [VENDOR] ${name} (${vendor.media.length} media files)`);

    const newMedia = [];
    let anyChanged = false;
    let anyFailed  = false;

    for (const item of vendor.media) {
      if (!item.url) { newMedia.push(item); continue; }

      if (item.url.includes('internalApp')) {
        console.log(`    [SKIP] ${item.name} — already migrated`);
        newMedia.push(item);
        continue;
      }

      const filename   = path.basename(item.url);
      const oldAbsPath = urlToAbsPath(item.url);
      const newUrl     = newVendorUrl(filename);
      const newAbsPath = path.join(PUBLIC_DIR, newUrl.replace(/^\//, ''));

      console.log(`    old: ${item.url}`);
      console.log(`    new: ${newUrl}`);

      const { ok, error } = copyFile(oldAbsPath, newAbsPath);

      if (!ok) {
        console.log(`    ✗ FAILED: ${error}`);
        newMedia.push(item);
        anyFailed = true;
        log.vendors.failed.push({ id, name, file: item.name, oldUrl: item.url, newUrl, error });
        failedCount++;
      } else {
        console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
        const updated = item.toObject ? item.toObject() : { ...item };
        newMedia.push({ ...updated, url: newUrl });
        anyChanged = true;
      }
    }

    if (anyChanged && !DRY_RUN) {
      await Vendor.findByIdAndUpdate(id, { $set: { media: newMedia } });
      console.log(`    ✓ MongoDB updated`);
    }

    if (anyChanged) {
      log.vendors.migrated.push({ id, name, fileCount: newMedia.length });
      migratedCount++;
    } else if (!anyFailed) {
      log.vendors.skipped.push({ id, name, reason: 'all already migrated' });
      skippedCount++;
    }
  }

  console.log(`\n  Vendors summary:`);
  console.log(`    migrated : ${migratedCount}`);
  console.log(`    skipped  : ${skippedCount}`);
  console.log(`    failed   : ${failedCount}`);
}

// ─── PORTAL MIGRATION ─────────────────────────────────────────────────────────
// Portal message attachments — both team and client attachments
// stored in messages[].attachments[].url
async function migratePortal() {
  printSection('PORTAL MESSAGE ATTACHMENTS');

  const portals = await ClientPortal.find({});
  console.log(`  Found ${portals.length} portal documents`);

  let migratedCount = 0, skippedCount = 0, failedCount = 0;

  for (const portal of portals) {
    const id  = portal._id.toString();
    const ref = portal.orderRef || portal.slug || id;

    const messages = portal.messages || [];
    const hasAttachments = messages.some(m =>
      m.attachments && m.attachments.some(a => a.url && !a.url.includes('internalApp'))
    );

    if (!hasAttachments) {
      console.log(`  [SKIP] ${ref} — no attachments to migrate`);
      log.portal.skipped.push({ id, ref, reason: 'no attachments' });
      skippedCount++;
      continue;
    }

    console.log(`  [PORTAL] ${ref}`);

    let anyChanged = false;
    let anyFailed  = false;

    const newMessages = messages.map(msg => {
      if (!msg.attachments || msg.attachments.length === 0) return msg;

      const newAttachments = msg.attachments.map(att => {
        if (!att.url || att.url.includes('internalApp')) return att;

        const filename   = path.basename(att.url);
        const oldAbsPath = urlToAbsPath(att.url);
        const newUrl     = newPortalUrl(filename);
        const newAbsPath = path.join(PUBLIC_DIR, newUrl.replace(/^\//, ''));

        console.log(`    [${msg.sender}] old: ${att.url}`);
        console.log(`    [${msg.sender}] new: ${newUrl}`);

        const { ok, error } = copyFile(oldAbsPath, newAbsPath);

        if (!ok) {
          console.log(`    ✗ FAILED: ${error}`);
          anyFailed = true;
          log.portal.failed.push({ id, ref, file: att.name, oldUrl: att.url, newUrl, error });
          failedCount++;
          return att; // keep old on failure
        }

        console.log(`    ✓ ${DRY_RUN ? 'DRY-RUN OK' : 'copied'}`);
        anyChanged = true;
        const updated = att.toObject ? att.toObject() : { ...att };
        return { ...updated, url: newUrl };
      });

      const msgObj = msg.toObject ? msg.toObject() : { ...msg };
      return { ...msgObj, attachments: newAttachments };
    });

    if (anyChanged && !DRY_RUN) {
      await ClientPortal.findByIdAndUpdate(id, { $set: { messages: newMessages } });
      console.log(`    ✓ MongoDB updated`);
    }

    if (anyChanged) {
      log.portal.migrated.push({ id, ref });
      migratedCount++;
    } else if (!anyFailed) {
      log.portal.skipped.push({ id, ref, reason: 'all already migrated' });
      skippedCount++;
    }
  }

  console.log(`\n  Portal summary:`);
  console.log(`    migrated : ${migratedCount}`);
  console.log(`    skipped  : ${skippedCount}`);
  console.log(`    failed   : ${failedCount}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  printHeader(DRY_RUN ? 'MIGRATION DRY-RUN (no changes)' : 'RUNNING MIGRATION');

  console.log(`\n  MongoDB   : ${MONGO_URI}`);
  console.log(`  Vendors   : ${RUN_VENDORS}`);
  console.log(`  Portal    : ${RUN_PORTAL}`);
  console.log(`  Dry run   : ${DRY_RUN}`);

  await mongoose.connect(MONGO_URI);
  console.log('\n  Connected to MongoDB.');

  if (!DRY_RUN) {
    ensureDir(path.join(PUBLIC_DIR, 'uploads', 'internalApp', 'vendors'));
    ensureDir(path.join(PUBLIC_DIR, 'uploads', 'internalApp', 'portal'));
  }

  if (RUN_VENDORS) await migrateVendors();
  if (RUN_PORTAL)  await migratePortal();

  log.finishedAt = new Date().toISOString();
  if (!DRY_RUN) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    console.log(`\n  Log written to: ${LOG_FILE}`);
  }

  printHeader('DONE');
  if (DRY_RUN) {
    console.log('\n  Dry run complete. No files moved, no DB changes.');
    console.log('  Review output above then run without --dry-run.');
  } else {
    console.log('\n  Migration complete. Original files NOT deleted.');
    console.log('  Verify files load correctly, then clean up:');
    console.log('    backend/public/uploads/vendors/');
    console.log('    backend/public/uploads/portal/');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  mongoose.disconnect();
  process.exit(1);
});