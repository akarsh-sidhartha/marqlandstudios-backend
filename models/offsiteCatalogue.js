
const mongoose = require('mongoose');
/*
// Define the schema for your Catalogue
const CatalogueSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please provide a title'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  items: [{
    name: String,
    price: Number,
    sku: String
  }],
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft'
  },
  progress: {
    type: Number,
    default: 0
  }
}, { 
  timestamps: true // This automatically adds createdAt and updatedAt fields
});

module.exports = mongoose.model('OffsiteCatalogue', CatalogueSchema);

const mongoose = require('mongoose');
*/
/**

Enhanced Schema for Offsite Catalogue

Adding 'strict: false' allows the database to save fields sent from the frontend

even if they aren't explicitly defined here, which fixes the "missing values" issue.
*/
const CatalogueSchema = new mongoose.Schema({
title: {
type: String,
required: [true, 'Please provide a title'],
trim: true
},
description: {
type: String,
trim: true
},
// Explicitly defined items array
items: [{
name: String,
price: Number,
sku: String,
category: String,
quantity: Number
}],
status: {
type: String,
enum: ['draft', 'published', 'archived'],
default: 'draft'
},
progress: {
type: Number,
default: 0
},
// Adding metadata or extra data storage just in case
metadata: {
type: Map,
of: mongoose.Schema.Types.Mixed
}
}, {
timestamps: true,
// CRITICAL: This allows saving fields not defined in the schema
strict: false
});

module.exports = mongoose.model('OffsiteCatalogue', CatalogueSchema);