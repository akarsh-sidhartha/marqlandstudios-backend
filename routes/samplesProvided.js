'use strict';
/**
 * backend/routes/samplesProvided.js
 * Mounted at /api/challans
 *
 *   GET    /      — list all challans
 *   POST   /      — create challan
 *   PUT    /:id   — update challan
 *   DELETE /:id   — delete challan
 */

const express = require('express');
const router  = express.Router();
const Challan = require('../models/samplesprovided');
const logger  = require('../utils/logger').child({ module: 'samplesProvided' });

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const challans = await Challan.find().sort({ createdAt: -1 }).lean();
    logger.debug('Challans listed', { count: challans.length, userId: req.user?.id });
    res.json(challans);
  } catch (err) {
    logger.error('Failed to list challans', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const data = {
      ...req.body,
      dcAttachments: Array.isArray(req.body.dcAttachments) ? req.body.dcAttachments : [],
    };
    const challan = new Challan(data);
    await challan.save();
    logger.info('Challan created', { challanId: challan._id, userId: req.user?.id });
    res.status(201).json(challan);
  } catch (err) {
    logger.error('Challan creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const data = {
      ...req.body,
      dcAttachments: Array.isArray(req.body.dcAttachments) ? req.body.dcAttachments : [],
    };
    const challan = await Challan.findByIdAndUpdate(
      req.params.id,
      data,
      { new: true, runValidators: true }
    );
    if (!challan) return res.status(404).json({ error: 'Challan not found.' });
    logger.info('Challan updated', { challanId: req.params.id, userId: req.user?.id });
    res.json(challan);
  } catch (err) {
    logger.error('Challan update failed', { challanId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const challan = await Challan.findByIdAndDelete(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found.' });
    logger.info('Challan deleted', { challanId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Challan deleted.' });
  } catch (err) {
    logger.error('Challan delete failed', { challanId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;