const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  contacts: [{
    name: String,
    phone: String,
    email: String
  }]
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);