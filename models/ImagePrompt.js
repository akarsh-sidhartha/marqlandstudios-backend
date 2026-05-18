/**
 * backend/models/ImagePrompt.js
 *
 * Stores saved image processing prompts per category.
 * Admin can create, edit, delete prompts.
 * Each product category can have one or more named prompts.
 * One prompt per category can be marked as default.
 */

const mongoose = require('mongoose');

const imagePromptSchema = new mongoose.Schema({
  name:       { type: String, required: true },         // e.g. "Studio Dark", "Clean White"
  category:   { type: String, required: true },         // e.g. "Electronics", "Bags", "All"
  prompt:     { type: String, required: true },         // the full AI prompt text
  isDefault:  { type: Boolean, default: false },        // used automatically for this category
}, {
  timestamps: true,
});

// Only one default per category
imagePromptSchema.index({ category: 1, isDefault: 1 });

module.exports = mongoose.model('ImagePrompt', imagePromptSchema);