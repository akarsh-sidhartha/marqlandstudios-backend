const mongoose = require('mongoose');

const SampleItemSchema = new mongoose.Schema({
  id: String,
  name: { type: String, required: true },
  qtySent: { type: Number, default: 0 },
  qtyReturned: { type: Number, default: 0 },
  qtyMissing: { type: Number, default: 0 },
  image: String, // Base64
  writeOffRemarks: { type: String, default: '' },
  status: { type: String, default: 'pending' }
});

const ChallanSchema = new mongoose.Schema({
  challanNumber: { type: String, required: true, unique: true },
  clientName: { type: String, required: true },
  orderedBy: { type: String },
  description: { type: String },
  date: { type: Date, default: Date.now },
  samples: [SampleItemSchema],
  // CRITICAL: Explicitly define as an array of objects
  dcAttachments: [{
    name: { type: String },
    type: { type: String },
    data: { type: String }, // Base64 string
    size: { type: String }
  }],
  totalItems: Number,
  status: { 
    type: String, 
    enum: ['open', 'settled', 'archived'], 
    default: 'open' 
  },
  settledAt: Date
}, { timestamps: true });

module.exports = mongoose.model('Challan', ChallanSchema);