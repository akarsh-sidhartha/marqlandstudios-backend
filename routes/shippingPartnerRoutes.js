'use strict';
/**
 * backend/routes/shippingPartnerRoutes.js
 * Mounted at /api/shipping-partners
 * Access: courier + admin only (enforced by routeGuard in server.js)
 *
 *   GET    /      — list all shipping partners
 *   POST   /      — create partner
 *   PUT    /:id   — update partner
 *   DELETE /:id   — delete partner
 */

const express        = require('express');
const router         = express.Router();
const ShippingPartner = require('../models/ShippingPartner');
const logger         = require('../utils/logger').child({ module: 'shippingPartnerRoutes' });

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const partners = await ShippingPartner.find().sort({ name: 1 }).lean();
    logger.debug('Shipping partners listed', { count: partners.length, userId: req.user?.id });
    res.json(partners);
  } catch (err) {
    logger.error('Failed to list shipping partners', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const partner = new ShippingPartner(req.body);
    await partner.save();
    logger.info('Shipping partner created', { partnerId: partner._id, name: partner.name, userId: req.user?.id });
    res.status(201).json(partner);
  } catch (err) {
    logger.error('Shipping partner creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const partner = await ShippingPartner.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!partner) return res.status(404).json({ message: 'Shipping partner not found.' });
    logger.info('Shipping partner updated', { partnerId: req.params.id, userId: req.user?.id });
    res.json(partner);
  } catch (err) {
    logger.error('Shipping partner update failed', { partnerId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ message: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const partner = await ShippingPartner.findByIdAndDelete(req.params.id);
    if (!partner) return res.status(404).json({ message: 'Shipping partner not found.' });
    logger.info('Shipping partner deleted', { partnerId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Shipping partner deleted.' });
  } catch (err) {
    logger.error('Shipping partner delete failed', { partnerId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;