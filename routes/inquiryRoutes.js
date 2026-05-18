'use strict';
/**
 * backend/routes/inquiryRoutes.js
 * Mounted at /api/inquiries
 *
 * TEAM (authenticated via routeGuard):
 *   POST   /              — create inquiry + notify vendors via WhatsApp
 *   GET    /              — list all inquiries
 *   PUT    /:id           — general update (status, fields)
 *   PUT    /:id/archive   — shorthand: set status → archived
 *   DELETE /:id           — delete inquiry
 *   POST   /broadcast     — broadcast (stub, extend as needed)
 *
 * PUBLIC (no auth — vendor-facing):
 *   GET    /public/:id          — vendor reads the inquiry brief
 *   POST   /public/:id/respond  — vendor submits a quote response
 */

const express  = require('express');
const router   = express.Router();
const Inquiry  = require('../models/Inquiry');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const logger   = require('../utils/logger').child({ module: 'inquiryRoutes' });

// ─── POST / — create inquiry + notify vendors ─────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const inquiry      = new Inquiry(req.body);
    const savedInquiry = await inquiry.save();

    logger.info('Inquiry created', {
      inquiryId:   savedInquiry._id,
      vendorCount: savedInquiry.targetVendors?.length || 0,
      userId:      req.user?.id,
    });

    // Notify each target vendor via WhatsApp
    const appUrl     = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const publicLink = `${appUrl}/respond/${savedInquiry._id}`;

    if (savedInquiry.targetVendors?.length > 0) {
      for (const vendor of savedInquiry.targetVendors) {
        const cleanPhone = vendor.phone.replace(/\D/g, '');
        const message =
          `*New Inquiry from Marqland Studios*\n\n` +
          `*Description:* ${savedInquiry.publicDescription}\n` +
          `*Quantity:* ${savedInquiry.quantity}\n\n` +
          `Submit your quote here:\n${publicLink}`;

        try {
          await sendWhatsAppMessage(cleanPhone, message);
          logger.debug('WhatsApp notification sent', { phone: cleanPhone, inquiryId: savedInquiry._id });
        } catch (waErr) {
          // Non-fatal — log and continue to the next vendor
          logger.warn('WhatsApp notification failed', {
            phone:     cleanPhone,
            inquiryId: savedInquiry._id,
            error:     waErr.message,
          });
        }
      }
    }

    res.status(201).json(savedInquiry);
  } catch (err) {
    logger.error('Inquiry creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ message: err.message });
  }
});

// ─── GET / — list all inquiries ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const inquiries = await Inquiry.find().sort({ createdAt: -1 }).lean();
    logger.debug('Inquiries listed', { count: inquiries.length, userId: req.user?.id });
    res.json(inquiries);
  } catch (err) {
    logger.error('Failed to list inquiries', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id — general update ────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const updated = await Inquiry.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry updated', { inquiryId: req.params.id, userId: req.user?.id });
    res.json(updated);
  } catch (err) {
    logger.error('Inquiry update failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── PUT /:id/archive — shorthand archive ────────────────────────────────────
router.put('/:id/archive', async (req, res) => {
  try {
    const updated = await Inquiry.findByIdAndUpdate(
      req.params.id,
      { status: 'archived' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry archived', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Archived.' });
  } catch (err) {
    logger.error('Inquiry archive failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Inquiry.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry deleted', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Inquiry deleted.' });
  } catch (err) {
    logger.error('Inquiry delete failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /broadcast — stub ───────────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  logger.info('Broadcast triggered (stub)', { userId: req.user?.id });
  res.json({ success: true });
});


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — no auth, vendor-facing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/inquiries/public/:id
 * Vendor reads the public brief for an inquiry.
 * Returns 403 if the inquiry is archived (closed to new responses).
 */
router.get('/public/:id', async (req, res) => {
  try {
    const inq = await Inquiry.findById(req.params.id).lean();

    if (!inq) {
      logger.warn('Public inquiry not found', { inquiryId: req.params.id });
      return res.status(404).json({ message: 'This inquiry does not exist.' });
    }
    if (inq.status === 'archived') {
      logger.debug('Public inquiry access blocked — archived', { inquiryId: req.params.id });
      return res.status(403).json({ message: 'This inquiry has been closed.' });
    }

    res.json({
      publicDescription: inq.publicDescription,
      quantity:          inq.quantity,
      deadline:          inq.deadline,
      attachments:       inq.attachments,
      status:            inq.status,
    });
  } catch (err) {
    // Separate DB errors from "not found" so they don't masquerade as bad links
    logger.error('Public inquiry fetch failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Unable to load inquiry. Please try again.' });
  }
});

/**
 * POST /api/inquiries/public/:id/respond
 * Vendor submits a quote response.
 * Blocked if the inquiry is archived.
 */
router.post('/public/:id/respond', async (req, res) => {
  try {
    const inq = await Inquiry.findById(req.params.id);
    if (!inq)                        return res.status(404).json({ message: 'Inquiry not found.' });
    if (inq.status === 'archived')   return res.status(403).json({ message: 'This inquiry is closed.' });

    inq.responses.push(req.body);
    await inq.save();

    logger.info('Vendor response received', { inquiryId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    logger.error('Vendor response failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;