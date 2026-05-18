/**
 * backend/models/StoreCategory.js
 *
 * Represents a top-level collection on the public www.marqland.com portfolio.
 * Each category has:
 *   - A cover image (isCover: true) used in the homepage bento grid
 *   - Generic (non-cover) images shown when the category is selected
 *   - Subcategories, each with their own ordered image arrays
 */

const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema({
  url:         { type: String, required: true },  // /uploads/store/... relative path
  filename:    { type: String, required: true },
  isCover:     { type: Boolean, default: false },
  aspectRatio: { type: Number },                  // naturalWidth/naturalHeight, stored on upload
  order:       { type: Number, default: 0 },
}, { _id: true });

const subcategorySchema = new mongoose.Schema({
  name:   { type: String, required: true },
  order:  { type: Number, default: 0 },
  images: [imageSchema],
}, { _id: true });

const storeCategorySchema = new mongoose.Schema({
  name:          { type: String, required: true },
  order:         { type: Number, default: 0 },
  images:        [imageSchema],        // generic + cover images
  subcategories: [subcategorySchema],
}, {
  timestamps: true,
});

module.exports = mongoose.model('StoreCategory', storeCategorySchema);