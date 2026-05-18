const mongoose = require('mongoose');

/**
 * ActivityLog — one document per loggable API action.
 *
 * Captured automatically by the activityLogger middleware in server.js.
 * Also written manually for auth events (login, logout, failed login).
 */
const activityLogSchema = new mongoose.Schema({
  // Who
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userName:  { type: String, default: 'Anonymous' },
  userEmail: { type: String, default: '' },
  userRole:  { type: String, default: '' },

  // What
  action:    { type: String, required: true },   // e.g. "CREATE_ORDER", "LOGIN", "DELETE_CLIENT"
  category:  { type: String, default: 'general' }, // orders | clients | products | auth | portal | admin | system
  method:    { type: String, default: '' },        // GET POST PUT PATCH DELETE
  path:      { type: String, default: '' },        // /api/orders/abc123
  summary:   { type: String, default: '' },        // Human-readable: "Created order INQ-26-27-001"

  // Result
  status:    { type: Number, default: 200 },       // HTTP status code
  success:   { type: Boolean, default: true },

  // Context
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
  duration:  { type: Number, default: 0 },         // ms

  // Optional payload snapshot (never log passwords/tokens)
  meta:      { type: mongoose.Schema.Types.Mixed, default: null },
}, {
  timestamps: true, // createdAt = when it happened
});

// Index for fast queries by user, category, date
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ category: 1, createdAt: -1 });
activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ action: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);