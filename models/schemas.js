const mongoose = require('mongoose');

// Product Schema
const ProductSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  category: { type: String, required: true },
  subCategory: { type: String, required: true },
  name: { type: String, required: true },
  description: String,
  purchasePrice: { type: Number, required: true },
  markupPercent: { type: Number, required: true },
  imageUrl: String,
});

// Vendor & Client Schema (Shared logic for contacts)
const ContactSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String
});

const VendorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  state: String,
  description: String,
  contacts: [ContactSchema]
});

const ClientSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  contacts: [ContactSchema]
});

module.exports = {
  Product: mongoose.model('Product', ProductSchema),
  Vendor: mongoose.model('Vendor', VendorSchema),
  Client: mongoose.model('Client', ClientSchema)
};