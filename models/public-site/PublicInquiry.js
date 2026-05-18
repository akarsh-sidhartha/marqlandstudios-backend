/**
 * backend/models/public-site/PublicInquiry.js
 * Contact/inquiry form submissions from www.marqland.com
 */

const mongoose = require('mongoose');

const publicInquirySchema = new mongoose.Schema({
  name:       { type: String, required: true },
  company:    { type: String, default: '' },
  email:      { type: String, required: true },
  phone:      { type: String, default: '' },
  message:    { type: String, default: '' },
  hearAbout:  { type: String, default: '' },  // how they heard about us
  read:       { type: Boolean, default: false },
}, {
  timestamps: true,
});

module.exports = mongoose.model('PublicInquiry', publicInquirySchema);