const mongoose = require('mongoose');

const catalogueSchema = new mongoose.Schema({
  name: { type: String, required: true },
  subtitle: { type: String }, // Added to match frontend
  items: [{
    _id: { type: String }, // Allow string IDs from frontend
    name: String,
    imageUrl: String,
    description: String,
    price: String
  }],
}, { timestamps: true });

module.exports = mongoose.model('Catalogue', catalogueSchema);