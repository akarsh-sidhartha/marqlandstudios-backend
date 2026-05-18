const mongoose = require('mongoose');

const ShippingPartnerSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, unique: true },
  trackingUrl:  { type: String, default: '' },   // base URL — append tracking ID
  apiEndpoint:  { type: String, default: '' },   // REST endpoint for status polling
  apiKey:       { type: String, default: '' },   // API key / Bearer token
}, { timestamps: true });

module.exports = mongoose.models.ShippingPartner || mongoose.model('ShippingPartner', ShippingPartnerSchema);