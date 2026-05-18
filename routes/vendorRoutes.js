'use strict';
/**
 * backend/routes/vendorRoutes.js
 * Mounted at /api/vendors
 *
 *   GET    /                    — list all vendors
 *   POST   /                    — create vendor (with optional media files)
 *   PUT    /:id                 — update vendor (with optional new media + keepMediaIds)
 *   DELETE /:id/media/:mediaId  — delete one media file from a vendor
 *   DELETE /:id                 — delete vendor + all media files
 *   POST   /scan-card           — AI business card scan → prefill vendor fields
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Vendor   = require('../models/Vendor');
const { extractFromBusinessCard } = require('../services/aiService');
const logger   = require('../utils/logger').child({ module: 'vendorRoutes' });

// ─── Upload configuration ─────────────────────────────────────────────────────
const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'vendors');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg', 'video/3gpp',
]);

const upload = multer({
  storage,
  limits:     { fileSize: 500 * 1024 * 1024 }, // 500 MB — supports large video recordings
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not supported: ${file.mimetype}`));
  },
});

// ─── Helper: map multer file → vendor media shape ─────────────────────────────
const toMediaItem = (f) => ({
  name:     f.originalname,
  url:      `/uploads/internalApp/vendors/${f.filename}`,
  mimeType: f.mimetype,
  size:     f.size,
  label:    '',
});

// ─── Helper: delete a file from disk, non-fatal ───────────────────────────────
const deleteFileSafe = (url) => {
  const fp = path.join(process.cwd(), 'public', url);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  catch (e) { logger.warn('File delete failed', { path: fp, error: e.message }); }
};

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ companyName: 1 }).lean();
    logger.debug('Vendors listed', { count: vendors.length, userId: req.user?.id });
    res.json(vendors);
  } catch (err) {
    logger.error('Failed to list vendors', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST / — create vendor ───────────────────────────────────────────────────
router.post('/', upload.array('mediaFiles', 20), async (req, res) => {
  try {
    const { companyName, state, category, suppliedProducts, description, gstNumber } = req.body;
    if (!companyName?.trim())
      return res.status(400).json({ message: 'Company name is required.' });

    let contacts = [];
    if (req.body.contacts) {
      try {
        contacts = JSON.parse(req.body.contacts);
      } catch (parseErr) {
        logger.warn('Vendor contacts JSON parse failed — defaulting to empty', {
          raw:   req.body.contacts?.slice(0, 100),
          error: parseErr.message,
        });
      }
    }

    const vendor = await Vendor.create({
      companyName: companyName.trim(),
      state, category, suppliedProducts, description, gstNumber,
      contacts,
      media: (req.files || []).map(toMediaItem),
    });

    logger.info('Vendor created', { vendorId: vendor._id, name: vendor.companyName, userId: req.user?.id });
    res.status(201).json(vendor);
  } catch (err) {
    logger.error('Vendor creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── PUT /:id — update vendor ─────────────────────────────────────────────────
// Accepts new files via multipart AND a `keepMediaIds` list (comma-separated _ids).
// Any existing media ID NOT in keepMediaIds is deleted from disk and DB.
router.put('/:id', upload.array('mediaFiles', 20), async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    const { companyName, state, category, suppliedProducts, description, gstNumber, keepMediaIds } = req.body;

    // Determine which existing media IDs to retain
    const keepIds = keepMediaIds
      ? keepMediaIds.split(',').map(s => s.trim()).filter(Boolean)
      : vendor.media.map(m => m._id.toString()); // keep all if not specified

    // Delete removed files from disk
    vendor.media.forEach(m => {
      if (!keepIds.includes(m._id.toString())) {
        deleteFileSafe(m.url);
      }
    });

    let contacts = vendor.contacts;
    if (req.body.contacts) {
      try {
        contacts = JSON.parse(req.body.contacts);
      } catch (parseErr) {
        logger.warn('Vendor contacts JSON parse failed on update — keeping existing', {
          vendorId: req.params.id,
          error:    parseErr.message,
        });
      }
    }

    const retainedMedia = vendor.media.filter(m => keepIds.includes(m._id.toString()));
    const newMedia      = (req.files || []).map(toMediaItem);

    const updated = await Vendor.findByIdAndUpdate(
      req.params.id,
      {
        companyName:      companyName?.trim()    ?? vendor.companyName,
        state:            state                  ?? vendor.state,
        category:         category               ?? vendor.category,
        suppliedProducts: suppliedProducts        ?? vendor.suppliedProducts,
        description:      description             ?? vendor.description,
        gstNumber:        gstNumber               ?? vendor.gstNumber,
        contacts,
        media: [...retainedMedia, ...newMedia],
      },
      { new: true }
    );

    logger.info('Vendor updated', {
      vendorId:       req.params.id,
      newFiles:       newMedia.length,
      removedFiles:   vendor.media.length - retainedMedia.length,
      userId:         req.user?.id,
    });
    res.json(updated);
  } catch (err) {
    logger.error('Vendor update failed', { vendorId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ message: err.message });
  }
});

// ─── DELETE /:id/media/:mediaId — remove one media file ──────────────────────
router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    const media = vendor.media.id(req.params.mediaId);
    if (!media) return res.status(404).json({ message: 'Media not found.' });

    deleteFileSafe(media.url);
    media.deleteOne();
    await vendor.save();

    logger.info('Vendor media deleted', { vendorId: req.params.id, mediaId: req.params.mediaId, userId: req.user?.id });
    res.json({ message: 'Media deleted.' });
  } catch (err) {
    logger.error('Vendor media delete failed', { vendorId: req.params.id, mediaId: req.params.mediaId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /:id — delete vendor + all media ─────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

    (vendor.media || []).forEach(m => deleteFileSafe(m.url));
    await Vendor.findByIdAndDelete(req.params.id);

    logger.info('Vendor deleted', { vendorId: req.params.id, name: vendor.companyName, mediaCount: vendor.media?.length, userId: req.user?.id });
    res.json({ message: 'Vendor deleted.' });
  } catch (err) {
    logger.error('Vendor delete failed', { vendorId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /scan-card — AI business card scan ──────────────────────────────────
router.post('/scan-card', async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image) return res.status(400).json({ message: 'Image is required.' });
    logger.debug('Business card scan started', { mimeType, userId: req.user?.id });
    const result = await extractFromBusinessCard(image);
    logger.info('Business card scan complete', { company: result?.companyName, userId: req.user?.id });
    res.json(result);
  } catch (err) {
    logger.error('Business card scan failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(500).json({ message: 'Card scan failed.', error: err.message });
  }
});

module.exports = router;