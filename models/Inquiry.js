const mongoose = require('mongoose');

const inquirySchema = new mongoose.Schema({
  // Internal Details
  clientName: { type: String, required: true },
  internalNotes: String,
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  
  // Public Details (Visible to Vendor)
  publicDescription: { type: String, required: true }, // The "Notes to vendor"
  quantity: String,
  deadline: String,
  attachments: [{
    url: String,
    fileType: String,
    name: String
  }],

  // Vendor Tracking
  targetVendors: [{
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    phone: String,
    companyName: String
  }],

  // Responses received from vendors via the link
  responses: [{
    vendorId: mongoose.Schema.Types.ObjectId,
    companyName: String,
    cost: Number,
    deliveryDate: String,
    notes: String,
    attachments: [String],
    voiceNoteUrl: String,
    receivedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Inquiry', inquirySchema);