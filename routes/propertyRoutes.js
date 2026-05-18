'use strict';
/**
 * backend/routes/propertyRoutes.js
 * Mounted at /api/properties
 *
 *   GET    /                    — list all properties
 *   POST   /                    — create property
 *   PUT    /:id                 — update property
 *   DELETE /:id                 — delete property
 *   POST   /upload-attachment   — upload a property attachment (PDF, image, doc)
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Property = require('../models/Property');
const logger   = require('../utils/logger').child({ module: 'propertyRoutes' });

// ─── Upload directory helpers ─────────────────────────────────────────────────
// Property type from schema enum: 'Day Outing' | 'Night Stay'
const PROPERTY_TYPE_DIRS = {
  'Day Outing': 'day_outing',
  'Night Stay': 'night_stay',
};

const getPropertyDir = (type) => {
  const subfolder = PROPERTY_TYPE_DIRS[type] || 'day_outing';
  const dir       = path.join(process.cwd(), 'public', 'uploads', 'internalApp', 'property', subfolder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getPropertyUrl = (type, filename) => {
  const subfolder = PROPERTY_TYPE_DIRS[type] || 'day_outing';
  return `/uploads/internalApp/property/${subfolder}/${filename}`;
};

// ─── Multer configuration ─────────────────────────────────────────────────────
// Reads req.body.type to route into the correct day_outing/ or night_stay/ subfolder.
const attachStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getPropertyDir(req.body.type)),
  filename:    (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});
const uploadAttachment = multer({ storage: attachStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── GET / — list all properties ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const properties = await Property.find().sort({ propertyName: 1 }).lean();
    logger.debug('Properties listed', { count: properties.length, userId: req.user?.id });
    res.json(properties);
  } catch (err) {
    logger.error('Failed to list properties', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST / — create property ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    logger.info('Property created', { propertyId: property._id, name: property.propertyName, userId: req.user?.id });
    res.status(201).json(property);
  } catch (err) {
    logger.error('Property creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── PUT /:id — update property ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!property) return res.status(404).json({ message: 'Property not found.' });
    logger.info('Property updated', { propertyId: req.params.id, name: property.propertyName, userId: req.user?.id });
    res.json(property);
  } catch (err) {
    logger.error('Property update failed', { propertyId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ message: err.message });
  }
});

// ─── DELETE /:id — delete property ───────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const property = await Property.findByIdAndDelete(req.params.id);
    if (!property) return res.status(404).json({ message: 'Property not found.' });
    logger.info('Property deleted', { propertyId: req.params.id, name: property.propertyName, userId: req.user?.id });
    res.json({ message: 'Property deleted.' });
  } catch (err) {
    logger.error('Property delete failed', { propertyId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /upload-attachment ──────────────────────────────────────────────────
// Upload a single property attachment (PDF, image, doc).
// Body must include: type: 'Day Outing' | 'Night Stay'
// Returns: { url, name, mimeType, size }
router.post('/upload-attachment', uploadAttachment.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided.' });
    const propertyType = req.body.type || 'Day Outing';
    const url          = getPropertyUrl(propertyType, req.file.filename);
    logger.debug('Property attachment uploaded', { propertyType, filename: req.file.filename, userId: req.user?.id });
    res.json({
      url,
      name:     req.file.originalname,
      mimeType: req.file.mimetype,
      size:     req.file.size,
    });
  } catch (err) {
    logger.error('Property attachment upload failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;