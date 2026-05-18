'use strict';
/**
 * backend/utils/invoiceHelpers.js
 * Shared utilities for invoice processing.
 * saveExtractedInvoice now uploads file to OneDrive first,
 * stores only the URL in MongoDB — no more base64 in the DB.
 */

const Invoice = require('../models/Invoice');
const { uploadSingleFile, fyFromDate: graphFyFromDate } = require('../services/msGraphService');

/** Pause for ms milliseconds */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalise FY to short 2-digit format.
 * "2025-2026" → "2025-26" | "2025-26" → unchanged
 */
const normalizeFY = (fy) => {
  if (!fy) return fy;
  return fy.replace(/^(\d{4})-(\d{2,4})$/, (_, y, s) => `${y}-${String(s).slice(-2).padStart(2, '0')}`);
};

/**
 * Derive { fy, month } from a Date object.
 */
const fyFromDate = (d) => {
  const y  = d.getFullYear();
  const sh = (n) => String(n).slice(-2).padStart(2, '0');
  return {
    fy:    d.getMonth() < 3 ? `${y - 1}-${sh(y)}` : `${y}-${sh(y + 1)}`,
    month: d.toLocaleString('default', { month: 'long' }),
  };
};

/**
 * Get { fy, month } from a date string.
 */
const getFinancialDetails = (dateString) => {
  const d = dateString ? new Date(dateString) : new Date();
  if (isNaN(d.getTime())) return { fy: 'Unknown', month: 'Unknown' };
  return fyFromDate(d);
};

/**
 * Check whether an invoice already exists (vendor GSTIN + invoice number).
 */
const checkIfDuplicate = async (vendor_gst, invoice_number) => {
  if (!vendor_gst || !invoice_number) return false;
  return !!(await Invoice.findOne({ vendor_gst, invoice_number }).lean());
};

/**
 * Generate a safe filename for OneDrive upload.
 * e.g. "Acme Corp" + "INV-001" + ".pdf" → "AcmeCorp_INV-001_1234567890.pdf"
 */
const buildInvoiceFilename = (vendorName, invoiceNumber, mimeType) => {
  const ext    = mimeType?.includes('pdf') ? '.pdf' : '.jpg';
  const vendor = (vendorName || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const inv    = (invoiceNumber || 'noinv').replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 20);
  return `${vendor}_${inv}_${Date.now()}${ext}`;
};

/**
 * Save an AI-extracted invoice to the database.
 * Uploads file to OneDrive first, then saves only metadata + URL to MongoDB.
 *
 * OneDrive path: Invoices/<FY>/<Month>/filename
 *
 * @param {object} extraction  - AI result
 * @param {string} base64Data  - raw base64 (no data URI prefix)
 * @param {string} mimeType
 * @param {string} source      - 'whatsapp' | 'outlook' | 'manual'
 * @param {object} metadata    - { notes }
 */
const saveExtractedInvoice = async (extraction, base64Data, mimeType, source, metadata = {}) => {
  const isDup = await checkIfDuplicate(extraction.vendor_gst, extraction.invoice_number);
  if (isDup) return { success: false, reason: 'Duplicate', data: extraction };

  const { fy: autoFY, month: autoMonth } = getFinancialDetails(extraction.date);
  const fy    = normalizeFY(extraction.financialYear) || autoFY;
  const month = extraction.month || autoMonth;

  // ── Upload to OneDrive ──────────────────────────────────────────────────────
  let oneDriveFileId = '';
  let oneDriveUrl    = '';
  let fileName       = '';

  try {
    fileName = buildInvoiceFilename(extraction.vendor_name, extraction.invoice_number, mimeType);
    const result = await uploadSingleFile(
      ['Invoices', fy, month],
      fileName,
      base64Data,
      mimeType
    );
    oneDriveFileId = result.fileId;
    oneDriveUrl    = result.webUrl;
  } catch (uploadErr) {
    // OneDrive upload failed — log but don't block the save
    // invoice will be saved without a OneDrive URL
    console.error('[invoiceHelpers] OneDrive upload failed:', uploadErr.message);
  }

  // ── Save to MongoDB (no base64) ─────────────────────────────────────────────
  const inv = new Invoice({
    ...extraction,
    total_amount:   Number(extraction.total_amount || 0),
    cgst:           Number(extraction.cgst         || 0),
    sgst:           Number(extraction.sgst         || 0),
    igst:           Number(extraction.igst         || 0),
    mimeType,
    receivedVia:    source,
    financialYear:  fy,
    month,
    notes:          metadata.notes || `Auto-processed via ${source}`,
    oneDriveFileId,
    oneDriveUrl,
    fileName,
    createdAt:      new Date(),
    // image field intentionally NOT set — file is in OneDrive
  });

  await inv.save();
  return { success: true, data: inv };
};

module.exports = {
  sleep,
  normalizeFY,
  fyFromDate,
  getFinancialDetails,
  checkIfDuplicate,
  buildInvoiceFilename,
  saveExtractedInvoice,
};