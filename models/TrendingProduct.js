'use strict';
/**
 * backend/models/TrendingProduct.js
 *
 * Stores products discovered by the trending-product discovery service.
 * One document per unique product URL — re-runs upsert so duplicates don't accumulate.
 *
 * Fields
 * ──────
 * name          Product title as found on the source page
 * description   Short description / snippet from the search result
 * industry      Which gifting vertical this belongs to (IT, Pharma, Cement, Paints, etc.)
 * imageUrl      Local path  /uploads/trending/<filename>.jpg  (saved to disk)
 * sourceUrl     Original page URL where the product was found
 * sourceDomain  e.g. "amazon.in", "indiamart.com"
 * supplier      { name, website, email, phone, country } — whatever we could extract
 * searchQuery   The exact query string that found this product
 * status        "new" | "reviewed" | "promoted" | "dismissed"
 * runDate       Which daily run discovered / last refreshed this product
 */

const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name:    { type: String, default: '' },
  website: { type: String, default: '' },
  email:   { type: String, default: '' },
  phone:   { type: String, default: '' },
  country: { type: String, default: '' },
}, { _id: false });

const trendingProductSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  industry:    { type: String, required: true },  // 'IT' | 'Pharma' | 'Cement' | 'Paints' | ...
  imageUrl:    { type: String, default: '' },      // local saved path
  imageSrcUrl: { type: String, default: '' },      // original remote image URL
  sourceUrl:   { type: String, default: '' },      // product page URL
  sourceDomain:{ type: String, default: '' },
  supplier:    { type: supplierSchema, default: () => ({}) },
  searchQuery:  { type: String, default: '' },
  sourceEngine: { type: String, default: 'google_images_in' }, // which engine found this
  status:      { type: String, enum: ['new','reviewed','promoted','dismissed'], default: 'new' },
  runDate:     { type: Date, default: Date.now },
}, {
  timestamps: true,
});

// Unique on sourceUrl so re-runs upsert rather than duplicate
trendingProductSchema.index({ sourceUrl: 1 }, { unique: true, sparse: true });
trendingProductSchema.index({ industry: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('TrendingProduct', trendingProductSchema);