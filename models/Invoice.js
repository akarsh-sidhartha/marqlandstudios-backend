const mongoose = require('mongoose');

const InvoiceSchema = new mongoose.Schema({
  // Vendor Identity
  vendor_name: { type: String, default: 'Unknown Vendor' },
  vendor_gst:  { type: String, default: '' },

  // Invoice Specifics
  invoice_number: { type: String, default: '---' },
  date:           { type: String },
  currency:       { type: String, default: 'INR' },

  // Financial Breakdown
  total_amount: { type: Number, default: 0 },
  cgst:         { type: Number, default: 0 },
  sgst:         { type: Number, default: 0 },
  igst:         { type: Number, default: 0 },
  tax_amount:   { type: Number, default: 0 },

  // Organisation/Filing Data
  financialYear: { type: String }, // e.g. "2025-26"
  month:         { type: String }, // e.g. "August"

  // ── OneDrive storage (new) ───────────────────────────────────────────────────
  // File is uploaded to OneDrive → Invoices/<FY>/<Month>/<filename>
  // webUrl is used to open/download the file directly from OneDrive
  oneDriveFileId: { type: String, default: '' },
  oneDriveUrl:    { type: String, default: '' },  // direct webUrl from Graph API
  fileName:       { type: String, default: '' },  // original filename

  // Source of the invoice
  receivedVia: { type: String, default: 'manual' }, // 'whatsapp' | 'outlook' | 'manual'
  notes:       { type: String, default: '' },

  // ── Legacy base64 storage (deprecated — kept for backward compat) ────────────
  // Populated only on old documents before OneDrive migration.
  // New documents will NOT have this field populated.
  // Use oneDriveUrl instead.
  image:    { type: String, select: false }, // excluded from all queries by default
  mimeType: { type: String, default: 'image/jpeg' },

  // Optional itemised details
  items: [{
    description: String,
    quantity:    Number,
    total:       Number,
  }],

  createdAt: { type: Date, default: Date.now },
});

// Index for efficient sorting and filtering — required for Atlas M0 memory limits
InvoiceSchema.index({ createdAt: -1 });
InvoiceSchema.index({ financialYear: 1, month: 1, createdAt: -1 });
InvoiceSchema.index({ vendor_gst: 1, invoice_number: 1 });

module.exports = mongoose.model('Invoice', InvoiceSchema);