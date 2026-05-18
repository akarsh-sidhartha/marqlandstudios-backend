'use strict';
/**
 * backend/routes/paymentTrackerRoutes.js
 * Mounted at /api/payment-tracker
 *
 * INVOICE VAULT:
 *   GET    /gemini-status          — AI provider health check
 *   POST   /invoices/process       — AI extraction only, no save (accounts + admin)
 *   GET    /invoices               — paginated invoice list (?fy=&month=&page=&limit=)
 *   GET    /invoices/:id           — single invoice
 *   POST   /invoices               — manually save invoice to vault
 *   DELETE /invoices/:id           — delete invoice
 *
 * WEBHOOK (no user auth — verified by token):
 *   GET    /whatsapp-webhook       — Meta verification challenge
 *   POST   /whatsapp-webhook       — incoming WhatsApp invoice media
 *
 * OUTLOOK SYNC (admin only):
 *   POST   /outlook-sync           — trigger Outlook mailbox scan
 *
 * PROFORMA INVOICES (PI):
 *   GET    /pi                     — paginated PI list
 *   GET    /pi/:id                 — single PI with payments
 *   POST   /pi                     — create PI
 *   PATCH  /pi/:id                 — update PI
 *   DELETE /pi/:id                 — delete PI + cascade payments
 *
 * PAYMENTS:
 *   GET    /payments               — paginated payments
 *   POST   /payments               — record payment + update PI balance
 *   PATCH  /payments/:id/map       — remap an advance to a PI or invoice
 *   POST   /payments/link-to-invoice — link PI to a vault invoice
 *   DELETE /payments/:id           — delete payment + reverse PI balance
 *
 * VENDOR GST:
 *   GET    /vendor-gst/:vendorId   — fetch vendor GST
 *   PATCH  /vendor-gst/:vendorId   — update vendor GST
 *
 * SUMMARY:
 *   GET    /summary                — aggregate PI + payment stats
 */

const express   = require('express');
const router    = express.Router();
const mongoose  = require('mongoose');

const { ProformaInvoice, Payment, VendorInvoice } = require('../models/paymentTrackerModel');
const Invoice = require('../models/Invoice');
const Vendor  = require('../models/Vendor');
const { authenticate, authorize }                                         = require('../middleware/authMiddleware');
const { extractFromDocument, checkAIStatus }                              = require('../services/aiService');
const { scanMailboxesForAttachments, uploadSingleFile }                   = require('../services/msGraphService');
const { normalizeFY, fyFromDate, checkIfDuplicate, saveExtractedInvoice } = require('../utils/invoiceHelpers');
const logger    = require('../utils/logger').child({ module: 'paymentTrackerRoutes' });

// ── whatsappService is optional — gracefully absent in test/CI environments ────
let whatsappService = null;
try { whatsappService = require('../services/whatsappService'); } catch { /* not available */ }

// ── Shared: AI extract → dedup → save + auto-update vendor GST ────────────────
const handleAutomatedInvoice = async (base64Data, mimeType, source, metadata = {}) => {
  const extraction = await extractFromDocument(base64Data, mimeType);

  if (extraction.vendor_gst && extraction.vendor_name) {
    try {
      const vendor = await Vendor.findOne({ companyName: new RegExp(extraction.vendor_name, 'i') });
      if (vendor && !vendor.gstNumber) {
        vendor.gstNumber = extraction.vendor_gst;
        await vendor.save();
        logger.debug('Vendor GST auto-updated from invoice', { vendorId: vendor._id, gst: extraction.vendor_gst });
      }
    } catch (e) {
      logger.warn('Vendor GST auto-update failed', { error: e.message });
    }
  }

  return saveExtractedInvoice(extraction, base64Data, mimeType, source, metadata);
};


// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE VAULT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/gemini-status', async (req, res) => {
  try {
    res.json(await checkAIStatus());
  } catch (err) {
    res.json({ available: false, reason: err.message });
  }
});

/**
 * POST /invoices/process
 * AI extraction only — no save. Used by upload modals for preview.
 * Requires authentication — each call burns AI API credits.
 */
router.post('/invoices/process', authenticate, authorize(['accounts', 'admin']), async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType)
      return res.status(400).json({ error: 'image and mimeType are required.' });

    const base64 = image.includes(',') ? image.split(',')[1] : image;
    logger.debug('Invoice AI extraction started', { mimeType, userId: req.user.id });
    const result = await extractFromDocument(base64, mimeType);
    logger.info('Invoice AI extraction complete', {
      vendor:        result.vendor_name,
      invoiceNumber: result.invoice_number,
      userId:        req.user.id,
    });
    res.json(result);
  } catch (err) {
    logger.error('Invoice AI extraction failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /invoices
 * Paginated invoice list — never returns base64 image field.
 * Loads current FY + month first; older data on demand.
 */
router.get('/invoices', async (req, res) => {
  try {
    const { fy, month, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (fy)    filter.financialYear = fy;
    if (month) filter.month         = month;

    const [invoices, total, financialYears] = await Promise.all([
      Invoice.find(filter)
        .select('-image')                                 // never return base64 to frontend
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      Invoice.countDocuments(filter),
      Invoice.distinct('financialYear'),
    ]);

    logger.debug('Invoices listed', { total, page, fy, month, userId: req.user?.id });
    res.json({ invoices, total, page: Number(page), limit: Number(limit), financialYears });
  } catch (err) {
    logger.error('Failed to list invoices', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /invoices/:id
 */
router.get('/invoices/:id', async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id).select('-image').lean();
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(inv);
  } catch (err) {
    logger.error('Failed to fetch invoice', { invoiceId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /invoices
 * Manually save an invoice to the vault.
 * Uploads file to OneDrive, deduplicates, auto-links to open PI.
 */
router.post('/invoices', async (req, res) => {
  try {
    const isDup = await checkIfDuplicate(req.body.vendor_gst, req.body.invoice_number);
    if (isDup) {
      logger.warn('Invoice save blocked — duplicate', {
        invoiceNumber: req.body.invoice_number,
        vendorGst:     req.body.vendor_gst,
        userId:        req.user?.id,
      });
      return res.status(409).json({
        duplicate:      true,
        error:          'Invoice already exists in vault.',
        invoice_number: req.body.invoice_number,
        vendor_name:    req.body.vendor_name,
      });
    }

    // Auto-update vendor GST
    if (req.body.vendor_gst && req.body.vendor_name) {
      try {
        const vendor = await Vendor.findOne({ companyName: new RegExp(req.body.vendor_name.trim(), 'i') });
        if (vendor && !vendor.gstNumber) {
          vendor.gstNumber = req.body.vendor_gst;
          await vendor.save();
        }
      } catch (e) {
        logger.warn('Vendor GST auto-update failed on manual save', { error: e.message });
      }
    }

    const d          = req.body.date ? new Date(req.body.date) : new Date();
    const { fy, month } = fyFromDate(d);

    // Upload to OneDrive — non-fatal
    let oneDriveFileId = '', oneDriveUrl = '', fileName = '';
    if (req.body.image) {
      try {
        // Filename = {invoice_number}_{vendor_name}.{ext}
        const ext    = (req.body.mimeType === 'application/pdf') ? 'pdf' : 'jpg';
        const safeNo   = (req.body.invoice_number || 'INVOICE').replace(/[^a-z0-9_\-]/gi, '_');
        const safeVend = (req.body.vendor_name   || '').replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        fileName        = safeVend ? `${safeNo}_${safeVend}.${ext}` : `${safeNo}.${ext}`;
        const upload    = await uploadSingleFile(
          ['Invoices', normalizeFY(req.body.financialYear) || fy, req.body.month || month],
          fileName, req.body.image, req.body.mimeType || 'image/jpeg'
        );
        oneDriveFileId  = upload.fileId;
        oneDriveUrl     = upload.webUrl;
        logger.debug('Invoice uploaded to OneDrive', { fileName, oneDriveUrl });
      } catch (e) {
        logger.warn('Invoice OneDrive upload failed — saving to vault without file link', { error: e.message });
      }
    }

    const inv = new Invoice({
      ...req.body,
      total_amount:  Number(req.body.total_amount || 0),
      financialYear: normalizeFY(req.body.financialYear) || fy,
      month:         req.body.month || month,
      oneDriveFileId,
      oneDriveUrl,
      fileName,
      createdAt:     new Date(),
      image:         undefined, // never store base64 in MongoDB
    });
    await inv.save();

    logger.info('Invoice saved to vault', {
      invoiceId:     inv._id,
      vendor:        inv.vendor_name,
      invoiceNumber: inv.invoice_number,
      amount:        inv.total_amount,
      userId:        req.user?.id,
    });

    // Auto-link to open PI for this vendor
    let piToLink = null;
    try {
      const linkedPiId = req.body.linkedPi || null;
      if (linkedPiId) {
        piToLink = await ProformaInvoice.findById(linkedPiId);
      } else if (req.body.vendor_name) {
        const vendor = await Vendor.findOne({ companyName: new RegExp(req.body.vendor_name.trim(), 'i') });
        if (vendor) {
          piToLink = await ProformaInvoice.findOne({
            vendor:       vendor._id,
            status:       { $in: ['pending', 'partial', 'fully_paid'] },
            finalInvoice: null,
          }).sort({ createdAt: -1 });
        }
      }

      if (piToLink) {
        piToLink.finalInvoice = inv._id;
        if (piToLink.status === 'fully_paid') piToLink.status = 'invoiced';
        await piToLink.save();
        await Payment.updateMany({ proformaInvoice: piToLink._id }, { $set: { vendorInvoice: inv._id } });
        logger.debug('Invoice auto-linked to PI', { invoiceId: inv._id, piId: piToLink._id });
      }
    } catch (linkErr) {
      logger.warn('PI auto-link failed — invoice still saved', { invoiceId: inv._id, error: linkErr.message });
    }

    res.status(201).json({ ...inv.toObject(), _linkedPi: piToLink?._id || null });
  } catch (err) {
    logger.error('Invoice save failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /invoices/:id
 */
router.delete('/invoices/:id', async (req, res) => {
  try {
    const inv = await Invoice.findByIdAndDelete(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    logger.info('Invoice deleted', { invoiceId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Invoice deleted.' });
  } catch (err) {
    logger.error('Invoice delete failed', { invoiceId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK (no user auth — verified by token)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/whatsapp-webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode });
  res.sendStatus(403);
});

router.post('/whatsapp-webhook', async (req, res) => {
  // Always respond 200 immediately — Meta will retry if we're slow
  res.sendStatus(200);

  try {
    const value   = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;

    const msg     = value.messages[0];
    const phoneId = value.metadata?.phone_number_id;
    const from    = msg.from;
    const media   = msg.document || msg.image || null;

    logger.debug('WhatsApp webhook message received', { from, hasMedia: !!media });

    if (!media || !whatsappService) {
      if (whatsappService) {
        await whatsappService.sendReply(phoneId, from, '👋 Please send an Image or PDF of the tax invoice.')
          .catch(e => logger.warn('WhatsApp reply failed', { error: e.message }));
      }
      return;
    }

    await whatsappService.sendReply(phoneId, from, '⏳ Reading invoice...')
      .catch(e => logger.warn('WhatsApp ack reply failed', { error: e.message }));

    const mediaData = await whatsappService.downloadWhatsAppMedia(media.id);
    if (!mediaData) {
      logger.warn('WhatsApp media download returned empty', { mediaId: media.id, from });
      return;
    }

    const result = await handleAutomatedInvoice(
      mediaData.base64, mediaData.mimeType, 'whatsapp',
      { notes: `WhatsApp from: ${from}` }
    );

    const reply = result.success
      ? `✅ Invoice Saved!\n*Vendor:* ${result.data.vendor_name}\n*Inv:* ${result.data.invoice_number}\n*Amount:* ₹${result.data.total_amount}`
      : `⚠️ Duplicate: Invoice #${result.data.invoice_number} already in vault.`;

    if (result.success) {
      logger.info('WhatsApp invoice saved', {
        invoiceId: result.data._id, vendor: result.data.vendor_name,
        invoiceNumber: result.data.invoice_number, from,
      });
    } else {
      logger.info('WhatsApp invoice duplicate skipped', {
        invoiceNumber: result.data.invoice_number, from,
      });
    }

    await whatsappService.sendReply(phoneId, from, reply)
      .catch(e => logger.warn('WhatsApp result reply failed', { error: e.message }));

  } catch (err) {
    logger.error('WhatsApp webhook processing error', { error: err.message, stack: err.stack });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// OUTLOOK SYNC (admin only)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Outlook auto-sync DISABLED ─────────────────────────────────────────────────
// Scanning all mailboxes for invoice-related attachments was producing
// zero-value invoice entries for every email that merely mentions "invoice"
// (newsletters, notifications, etc.).
// The function is kept here so it can be re-enabled later once a subject-line
// or sender allowlist filter is in place.  The manual POST /outlook-sync route
// below still exists but will return a clear "disabled" message.
//
// const syncOutlookInvoices = async () => { ... };
const syncOutlookInvoices = async () => {
  logger.warn('Outlook sync is currently disabled to prevent zero-value invoice creation');
  return {
    success:  false,
    disabled: true,
    message:  'Outlook email scanning is temporarily disabled. ' +
              'Upload invoices manually via the Invoice Vault tab.',
  };
};

router.post('/outlook-sync', authenticate, authorize(['admin']), async (req, res) => {
  logger.info('Manual Outlook sync triggered (currently disabled)', { userId: req.user.id });
  const result = await syncOutlookInvoices();
  // Return 503 so the frontend can display a clear "disabled" message
  res.status(result.disabled ? 503 : 200).json(result);
});


// ═══════════════════════════════════════════════════════════════════════════════
// PROFORMA INVOICES (PI)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/pi', async (req, res) => {
  try {
    const { vendorId, status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (vendorId) filter.vendor = vendorId;
    if (status)   filter.status = status;

    const [pis, total] = await Promise.all([
      ProformaInvoice.find(filter)
        .populate('vendor', 'companyName gstNumber')
        .populate('finalInvoice', 'invoiceNumber status amountPaid amountDue')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      ProformaInvoice.countDocuments(filter),
    ]);

    const piIds = pis.map(p => p._id);
    const pays  = await Payment.find({ proformaInvoice: { $in: piIds } })
      .select('proformaInvoice amount paymentDate paymentMode bankRef status paymentRef')
      .sort({ paymentDate: 1 });

    const byPI = {};
    pays.forEach(p => {
      const k = p.proformaInvoice?.toString();
      if (!byPI[k]) byPI[k] = [];
      byPI[k].push(p);
    });

    res.json({
      data:  pis.map(pi => ({ ...pi.toObject(), payments: byPI[pi._id.toString()] || [] })),
      total,
      page:  Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    logger.error('Failed to list PIs', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/pi/:id', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id)
      .populate('vendor', 'companyName gstNumber')
      .populate('finalInvoice');
    if (!pi) return res.status(404).json({ error: 'PI not found.' });

    const payments = await Payment.find({ proformaInvoice: pi._id }).sort({ paymentDate: 1 });
    res.json({ ...pi.toObject(), payments });
  } catch (err) {
    logger.error('Failed to fetch PI', { piId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/pi', async (req, res) => {
  try {
    const existing = await ProformaInvoice.findOne({ piNumber: req.body.piNumber });
    if (existing) {
      return res.status(409).json({
        duplicate: true,
        error:     `PI number "${req.body.piNumber}" already exists.`,
        piNumber:  req.body.piNumber,
      });
    }

    const pi = new ProformaInvoice({
      ...req.body,
      attachment:     req.body.attachment     || undefined,
      attachmentMime: req.body.attachmentMime || undefined,
    });
    pi.amountPaid = 0;
    pi.amountDue  = pi.totalAmount;
    await pi.save();

    logger.info('PI created', { piId: pi._id, piNumber: pi.piNumber, userId: req.user?.id });
    res.status(201).json(await ProformaInvoice.findById(pi._id).populate('vendor', 'companyName gstNumber'));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        duplicate: true,
        error:     `PI number "${req.body.piNumber}" already exists.`,
        piNumber:  req.body.piNumber,
      });
    }
    logger.error('PI creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

router.patch('/pi/:id', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id);
    if (!pi) return res.status(404).json({ error: 'PI not found.' });
    Object.assign(pi, req.body);
    await pi.save();
    logger.info('PI updated', { piId: req.params.id, userId: req.user?.id });
    res.json(pi);
  } catch (err) {
    logger.error('PI update failed', { piId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/pi/:id', async (req, res) => {
  try {
    const pi = await ProformaInvoice.findById(req.params.id);
    if (!pi) return res.status(404).json({ error: 'PI not found.' });
    await Payment.deleteMany({ proformaInvoice: pi._id });
    await ProformaInvoice.findByIdAndDelete(req.params.id);
    logger.info('PI deleted (cascade payments)', { piId: req.params.id, userId: req.user?.id });
    res.json({ message: 'PI deleted.' });
  } catch (err) {
    logger.error('PI delete failed', { piId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/payments', async (req, res) => {
  try {
    const { vendorId, mappedTo, status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (vendorId) filter.vendor   = vendorId;
    if (mappedTo) filter.mappedTo = mappedTo;
    if (status)   filter.status   = status;

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('vendor',         'companyName')
        .populate('proformaInvoice','piNumber totalAmount amountPaid status')
        .populate('vendorInvoice',  'invoice_number total_amount vendor_name')
        .sort({ paymentDate: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Payment.countDocuments(filter),
    ]);

    res.json({ data: payments, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logger.error('Failed to list payments', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/payments', async (req, res) => {
  try {
    const {
      vendor, paymentDate, amount, currency, paymentMode, bankRef,
      remarks, mappedTo, proformaInvoice: piId, vendorInvoice: viId,
    } = req.body;

    // Collision-proof paymentRef — capped at 10 attempts to prevent infinite loop
    const last    = await Payment.findOne({}, { paymentRef: 1 }).sort({ paymentRef: -1 });
    let nextNum   = 1;
    if (last?.paymentRef) {
      const m = last.paymentRef.match(/PAY-(\d+)/);
      if (m) nextNum = parseInt(m[1], 10) + 1;
    }
    let paymentRef = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = `PAY-${String(nextNum).padStart(5, '0')}`;
      const exists    = await Payment.exists({ paymentRef: candidate });
      if (!exists) { paymentRef = candidate; break; }
      nextNum++;
    }
    if (!paymentRef) throw new Error('Could not generate a unique payment reference — please retry.');

    const payment = new Payment({
      paymentRef,
      vendor:          vendor          || null,
      paymentDate,
      amount:          Number(amount),
      currency,
      paymentMode,
      bankRef,
      remarks,
      mappedTo:        mappedTo        || 'advance',
      proformaInvoice: piId            || null,
      vendorInvoice:   viId            || null,
      screenshot:      req.body.screenshot     || undefined,
      screenshotMime:  req.body.screenshotMime || undefined,
    });
    await payment.save();

    // Update PI balance
    if (piId) {
      const pi = await ProformaInvoice.findById(piId);
      if (!pi) {
        await Payment.findByIdAndDelete(payment._id);
        throw new Error('PI not found.');
      }
      if (pi.amountPaid + Number(amount) > pi.totalAmount) {
        await Payment.findByIdAndDelete(payment._id);
        throw new Error(`Payment exceeds PI balance of ₹${pi.totalAmount - pi.amountPaid}`);
      }
      pi.amountPaid += Number(amount);
      if (pi.amountPaid >= pi.totalAmount && pi.finalInvoice) pi.status = 'invoiced';
      await pi.save();
    }

    // Update balance via vendor invoice → linked PI
    if (viId) {
      const vi = await Invoice.findById(viId);
      if (!vi) {
        await Payment.findByIdAndDelete(payment._id);
        throw new Error('Invoice not found in vault.');
      }
      const linkedPi = await ProformaInvoice.findOne({ finalInvoice: viId });
      if (linkedPi) {
        if (linkedPi.amountPaid + Number(amount) > linkedPi.totalAmount) {
          await Payment.findByIdAndDelete(payment._id);
          throw new Error(`Payment exceeds PI balance of ₹${linkedPi.totalAmount - linkedPi.amountPaid}`);
        }
        linkedPi.amountPaid += Number(amount);
        payment.proformaInvoice = linkedPi._id;
        if (linkedPi.amountPaid >= linkedPi.totalAmount) linkedPi.status = 'invoiced';
        await linkedPi.save();
      }
      if (vi.vendor_name && !vendor) {
        const vendorDoc = await Vendor.findOne({ companyName: new RegExp(vi.vendor_name, 'i') });
        if (vendorDoc) payment.vendor = vendorDoc._id;
      }
      await payment.save();
    }

    logger.info('Payment recorded', {
      paymentRef,
      amount:  Number(amount),
      mappedTo: mappedTo || 'advance',
      piId:    piId || null,
      viId:    viId || null,
      userId:  req.user?.id,
    });

    const populated = await Payment.findById(payment._id)
      .populate('vendor',          'companyName')
      .populate('proformaInvoice', 'piNumber totalAmount amountPaid amountDue status')
      .populate('vendorInvoice',   'invoice_number total_amount vendor_name');

    res.status(201).json(populated);
  } catch (err) {
    logger.error('Payment creation failed', { error: err.message, stack: err.stack, userId: req.user?.id });
    res.status(400).json({ error: err.message });
  }
});

router.patch('/payments/:id/map', async (req, res) => {
  try {
    const { mappedTo, proformaInvoice: piId, vendorInvoice: viId } = req.body;
    const payment = await Payment.findById(req.params.id);
    if (!payment)                       return res.status(404).json({ error: 'Payment not found.' });
    if (payment.mappedTo !== 'advance') return res.status(400).json({ error: 'Only advances can be re-mapped.' });

    if (mappedTo === 'proforma_invoice' && piId) {
      const pi = await ProformaInvoice.findById(piId);
      if (!pi) throw new Error('PI not found.');
      if (pi.amountPaid + payment.amount > pi.totalAmount)
        throw new Error(`Payment exceeds PI balance of ₹${pi.totalAmount - pi.amountPaid}`);
      pi.amountPaid += payment.amount;
      if (pi.amountPaid >= pi.totalAmount && pi.finalInvoice) pi.status = 'invoiced';
      await pi.save();
      payment.mappedTo        = 'proforma_invoice';
      payment.proformaInvoice = piId;
      if (pi.vendor) payment.vendor = pi.vendor;

    } else if (mappedTo === 'vendor_invoice' && viId) {
      const vi = await Invoice.findById(viId);
      if (!vi) throw new Error('Invoice not found in vault.');
      payment.mappedTo      = 'vendor_invoice';
      payment.vendorInvoice = viId;
      if (vi.vendor_name) {
        const vendorDoc = await Vendor.findOne({ companyName: new RegExp(vi.vendor_name, 'i') });
        if (vendorDoc) payment.vendor = vendorDoc._id;
      }
    } else {
      return res.status(400).json({ error: 'Invalid mapping target.' });
    }

    await payment.save();
    logger.info('Payment remapped', { paymentId: req.params.id, mappedTo, userId: req.user?.id });

    const populated = await Payment.findById(payment._id)
      .populate('vendor',          'companyName')
      .populate('proformaInvoice', 'piNumber totalAmount amountPaid amountDue status')
      .populate('vendorInvoice',   'invoice_number total_amount vendor_name');
    res.json(populated);
  } catch (err) {
    logger.error('Payment remap failed', { paymentId: req.params.id, error: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/link-to-invoice', async (req, res) => {
  try {
    const { piId, invoiceId } = req.body;
    if (!piId || !invoiceId)
      return res.status(400).json({ error: 'piId and invoiceId are required.' });

    const [pi, invoice] = await Promise.all([
      ProformaInvoice.findById(piId),
      Invoice.findById(invoiceId),
    ]);
    if (!pi)      return res.status(404).json({ error: 'PI not found.' });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found in vault.' });

    pi.finalInvoice = new mongoose.Types.ObjectId(invoiceId);
    pi.status       = 'invoiced';
    await pi.save();

    const updated = await Payment.updateMany(
      { proformaInvoice: new mongoose.Types.ObjectId(piId) },
      { $set: { vendorInvoice: new mongoose.Types.ObjectId(invoiceId) } }
    );

    logger.info('PI linked to invoice', {
      piId, invoiceId, paymentsUpdated: updated.modifiedCount, userId: req.user?.id,
    });

    res.json({
      success:          true,
      pi:               await ProformaInvoice.findById(pi._id).populate('vendor', 'companyName'),
      paymentsUpdated:  updated.modifiedCount,
    });
  } catch (err) {
    logger.error('PI link-to-invoice failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/payments/:id', async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    // Reverse PI balance
    if (payment.proformaInvoice) {
      const pi = await ProformaInvoice.findById(payment.proformaInvoice);
      if (pi) {
        pi.amountPaid = Math.max(0, pi.amountPaid - payment.amount);
        await pi.save();
      }
    }

    // Reverse vendor invoice balance
    if (payment.vendorInvoice) {
      const vi = await VendorInvoice.findById(payment.vendorInvoice);
      if (vi) {
        vi.amountPaid = Math.max(0, vi.amountPaid - payment.amount);
        vi.payments   = vi.payments.filter(p => p.toString() !== payment._id.toString());
        await vi.save();
      }
    }

    await Payment.findByIdAndDelete(req.params.id);
    logger.info('Payment deleted', {
      paymentId:  req.params.id,
      paymentRef: payment.paymentRef,
      amount:     payment.amount,
      userId:     req.user?.id,
    });
    res.json({ message: 'Payment deleted.' });
  } catch (err) {
    logger.error('Payment delete failed', { paymentId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR GST
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/vendor-gst/:vendorId', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.vendorId).select('companyName gstNumber').lean();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    res.json({ companyName: vendor.companyName, gstNumber: vendor.gstNumber || null });
  } catch (err) {
    logger.error('Failed to fetch vendor GST', { vendorId: req.params.vendorId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/vendor-gst/:vendorId', async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.vendorId,
      { gstNumber: req.body.gstNumber },
      { new: true }
    ).select('companyName gstNumber');
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    logger.info('Vendor GST updated', { vendorId: req.params.vendorId, userId: req.user?.id });
    res.json(vendor);
  } catch (err) {
    logger.error('Vendor GST update failed', { vendorId: req.params.vendorId, error: err.message });
    res.status(400).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
  try {
    const match = req.query.vendorId
      ? { vendor: new mongoose.Types.ObjectId(req.query.vendorId) }
      : {};

    const [piStats, paymentStats] = await Promise.all([
      ProformaInvoice.aggregate([
        { $match: match },
        { $group: {
          _id:         '$status',
          count:       { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' },
          amountPaid:  { $sum: '$amountPaid' },
          amountDue:   { $sum: '$amountDue' },
        }},
      ]),
      Payment.aggregate([
        { $match: match },
        { $group: {
          _id:       '$mappedTo',
          count:     { $sum: 1 },
          totalPaid: { $sum: '$amount' },
        }},
      ]),
    ]);

    res.json({ piStats, paymentStats });
  } catch (err) {
    logger.error('Summary aggregation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, syncOutlookInvoices };