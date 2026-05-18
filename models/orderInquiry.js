const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  name:         { type: String },
  type:         { type: String },
  size:         { type: Number },
  lastModified: { type: Number },
  webUrl:       { type: String },
  downloadUrl:  { type: String },
  isOneDrive:   { type: Boolean, default: false },
}, { _id: false });

const orderInquirySchema = new mongoose.Schema({
  title:             { type: String },
  clientName:        { type: String, required: true },
  orderPlacedBy:     { type: String, required: true },
  description:       { type: String },
  refNumber:         { type: String, unique: true, sparse: true },
  invoiceNumber:     { type: String },
  status:            { type: String, enum: ['inquiry', 'ongoing', 'completed'], default: 'inquiry' },
  orderType:         { type: String, enum: ['product', 'offsite'], default: 'product' }, // ← NEW
  attachments:       [attachmentSchema],
  oneDriveFolderUrl: { type: String },
  completedAt:       { type: Date },
}, {
  timestamps: true,
});

// Index on updatedAt for efficient sorting — required for Atlas M0 memory limits
orderInquirySchema.index({ updatedAt: -1 });
orderInquirySchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('OrderInquiry', orderInquirySchema);