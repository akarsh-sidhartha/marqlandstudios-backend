'use strict';
/**
 * backend/routes/catalogueRoutes.js
 * Mounted at /api/catalogues
 *
 *   GET    /     — list all catalogues (newest first)
 *   POST   /     — create new or update existing (pass id in body to update)
 *   DELETE /:id  — delete by id
 */

const express   = require('express');
const router    = express.Router();
const mongoose  = require('mongoose');
const Catalogue = require('../models/catalogue');
const logger    = require('../utils/logger').child({ module: 'catalogueRoutes' });

// ─── List all catalogues ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const catalogues = await Catalogue.find().sort({ createdAt: -1 }).lean();
    res.json(catalogues);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Create or update catalogue ───────────────────────────────────────────────
// If a valid MongoDB ObjectId is provided in the body as `id`, the matching
// catalogue is updated. Otherwise a new one is created.
router.post('/', async (req, res) => {
  try {
    const { name, subtitle, items, id } = req.body;

    // Only treat `id` as an update key if it looks like a valid ObjectId
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      const updated = await Catalogue.findByIdAndUpdate(
        id,
        { name, subtitle, items },
        { new: true }
      );
      if (!updated) return res.status(404).json({ message: 'Catalogue not found.' });
      logger.info('Catalogue updated', { catalogueId: updated._id, name: updated.name, userId: req.user?.id });
      return res.json(updated);
    }

    const catalogue = new Catalogue({ name, subtitle, items });
    await catalogue.save();
    logger.info('Catalogue created', { catalogueId: catalogue._id, name: catalogue.name, userId: req.user?.id });
    res.status(201).json(catalogue);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ─── Delete catalogue ─────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const catalogue = await Catalogue.findByIdAndDelete(req.params.id);
    if (!catalogue) return res.status(404).json({ message: 'Catalogue not found.' });
    logger.info('Catalogue deleted', { catalogueId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;