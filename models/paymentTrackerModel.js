const mongoose = require("mongoose");

// ─────────────────────────────────────────────
// Proforma Invoice (PI) Schema
// ─────────────────────────────────────────────
const proformaInvoiceSchema = new mongoose.Schema(
  {
    piNumber:    { type: String, required: true, unique: true, trim: true },
    vendor:      { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
    piDate:      { type: Date, required: true },
    dueDate:     { type: Date },
    items: [
      {
        description: { type: String, trim: true },
        quantity:    { type: Number, default: 1 },
        unitPrice:   { type: Number, default: 0 },
        amount:      { type: Number, default: 0 },
      },
    ],
    totalAmount:  { type: Number, required: true, min: 0 },
    currency:     { type: String, default: "INR" },
    bankDetails:  { type: String, trim: true },
    notes:        { type: String, trim: true },
    amountPaid:   { type: Number, default: 0 },
    amountDue:    { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "partial", "fully_paid", "invoiced", "cancelled"],
      default: "pending",
    },
    // ✅ FIXED: ref must be "Invoice" (the vault model), NOT "VendorInvoice"
    finalInvoice:   { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    // ── OneDrive attachment (new) ──────────────────────────────────────────────
    // File stored at OneDrive: PI-Attachments/<piNumber>/filename
    attachmentFileId: { type: String, default: '' },
    attachmentUrl:    { type: String, default: '' }, // OneDrive webUrl
    attachmentName:   { type: String, default: '' }, // original filename
    // Legacy base64 (deprecated — kept for backward compat, excluded from queries)
    attachment:     { type: String, select: false },
    attachmentMime: { type: String },
  },
  { timestamps: true }
);

// ✅ FIXED: pre-save hook must NOT overwrite status when it is "invoiced" or "cancelled"
// Previously the hook always reset status, undoing any manual set of "invoiced"
proformaInvoiceSchema.pre("save", function () {
  this.amountDue = Math.max(0, this.totalAmount - this.amountPaid);
  // Only auto-set status for payment-driven states; preserve "invoiced" and "cancelled"
  if (this.status === "invoiced" || this.status === "cancelled") return;
  if (this.amountPaid <= 0)    this.status = "pending";
  else if (this.amountDue > 0) this.status = "partial";
  else                          this.status = "fully_paid";
});

// ─────────────────────────────────────────────
// Payment Schema
// ─────────────────────────────────────────────
const paymentSchema = new mongoose.Schema(
  {
    paymentRef:  { type: String, required: true, unique: true, trim: true },
    vendor:      { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    paymentDate: { type: Date, required: true },
    amount:      { type: Number, required: true, min: 0.01 },
    currency:    { type: String, default: "INR" },
    paymentMode: {
      type: String,
      enum: ["neft", "rtgs", "imps", "upi", "cheque", "cash", "other"],
      default: "other",
    },
    bankRef:  { type: String, trim: true },
    remarks:  { type: String, trim: true },
    mappedTo: {
      type: String,
      enum: ["proforma_invoice", "vendor_invoice", "advance"],
      default: "advance",
    },
    proformaInvoice: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", default: null },
    // ✅ FIXED: ref is "Invoice" (vault model), not "VendorInvoice"
    vendorInvoice:   { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    status: {
      type: String,
      enum: ["recorded", "verified", "reconciled"],
      default: "recorded",
    },
    // ── OneDrive screenshot (new) ──────────────────────────────────────────────
    // File stored at OneDrive: Payments/<paymentRef>/filename
    screenshotFileId: { type: String, default: '' },
    screenshotUrl:    { type: String, default: '' }, // OneDrive webUrl
    screenshotName:   { type: String, default: '' }, // original filename
    // Legacy base64 (deprecated — kept for backward compat, excluded from queries)
    screenshot:     { type: String, select: false },
    screenshotMime: { type: String },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────
// Vendor Invoice Schema (internal use only)
// ─────────────────────────────────────────────
const vendorInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    vendor:        { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
    invoiceDate:   { type: Date, required: true },
    receivedDate:  { type: Date, default: Date.now },
    items: [
      {
        description: { type: String, trim: true },
        quantity:    { type: Number, default: 1 },
        unitPrice:   { type: Number, default: 0 },
        amount:      { type: Number, default: 0 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    currency:    { type: String, default: "INR" },
    payments:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Payment" }],
    proformaInvoice: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", default: null },
    amountPaid:  { type: Number, default: 0 },
    amountDue:   { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "partial", "paid", "overdue"],
      default: "pending",
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

vendorInvoiceSchema.pre("save", function () {
  this.amountDue = Math.max(0, this.totalAmount - this.amountPaid);
  if (this.amountPaid <= 0)    this.status = "pending";
  else if (this.amountDue > 0) this.status = "partial";
  else                          this.status = "paid";
});

// Indexes for efficient sorting on Atlas M0
proformaInvoiceSchema.index({ createdAt: -1 });
proformaInvoiceSchema.index({ vendor: 1, status: 1 });
paymentSchema.index({ paymentDate: -1 });
paymentSchema.index({ vendor: 1, paymentDate: -1 });

const ProformaInvoice = mongoose.model("ProformaInvoice", proformaInvoiceSchema);
const Payment         = mongoose.model("Payment", paymentSchema);
const VendorInvoice   = mongoose.model("VendorInvoice", vendorInvoiceSchema);

module.exports = { ProformaInvoice, Payment, VendorInvoice };