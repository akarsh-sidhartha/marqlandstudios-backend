'use strict';
/**
 * backend/routes/logRoutes.js
 * Mounted at /api/logs
 * All routes require admin role (enforced below via router.use).
 *
 *   GET    /        — paginated activity log with filters
 *   GET    /stats   — summary stats for the last 7 days
 *   DELETE /purge   — delete logs older than N days (min 7, default 90)
 */

const express     = require('express');
const router      = express.Router();
const ActivityLog = require('../models/ActivityLog');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const logger      = require('../utils/logger').child({ module: 'logRoutes' });

// All log routes require admin — applied once here rather than on each handler
router.use(authenticate, authorize(['admin']));

// ─── GET / — paginated activity log ──────────────────────────────────────────
/**
 * Query params:
 *   page      (default 1)
 *   limit     (default 50, max 200)
 *   category  filter by category
 *   action    filter by action keyword (regex)
 *   userId    filter by user ID
 *   success   true | false
 *   from      ISO date — createdAt >= from
 *   to        ISO date — createdAt <= to
 *   search    text search across summary, userEmail, userName, path
 */
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;
    const filter = {};

    if (req.query.category)            filter.category = req.query.category;
    if (req.query.action)              filter.action   = { $regex: req.query.action, $options: 'i' };
    if (req.query.userId)              filter.userId   = req.query.userId;
    if (req.query.success !== undefined) {
      filter.success = req.query.success === 'true';
    }

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }

    if (req.query.search) {
      const re    = { $regex: req.query.search, $options: 'i' };
      filter.$or  = [{ summary: re }, { userEmail: re }, { userName: re }, { path: re }];
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    logger.debug('Activity logs fetched', {
      page, limit, total, filters: Object.keys(filter), userId: req.user?.id,
    });

    res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('Failed to fetch activity logs', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /stats — dashboard summary ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

    const [totalLast7, byCategory, byUser, failedLast7, recentActions] = await Promise.all([
      ActivityLog.countDocuments({ createdAt: { $gte: since } }),

      ActivityLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      ActivityLog.aggregate([
        { $match: { createdAt: { $gte: since }, userId: { $ne: null } } },
        { $group: {
          _id:   '$userId',
          name:  { $first: '$userName' },
          email: { $first: '$userEmail' },
          role:  { $first: '$userRole' },
          count: { $sum: 1 },
        }},
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      ActivityLog.countDocuments({ createdAt: { $gte: since }, success: false }),

      ActivityLog.find({ createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('summary userName userRole createdAt category success')
        .lean(),
    ]);

    logger.debug('Activity log stats fetched', { totalLast7, failedLast7, userId: req.user?.id });

    res.json({ totalLast7, byCategory, byUser, failedLast7, recentActions });
  } catch (err) {
    logger.error('Failed to fetch activity log stats', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /purge — remove old logs ─────────────────────────────────────────
/**
 * Query params:
 *   days  Number of days to retain (default 90, minimum 7).
 *         The floor of 7 prevents accidentally deleting recent logs.
 */
router.delete('/purge', async (req, res) => {
  try {
    const requested = parseInt(req.query.days) || 90;
    const days      = Math.max(7, requested); // safety floor — never purge last 7 days

    if (requested < 7) {
      logger.warn('Log purge days floored to 7', { requested, userId: req.user?.id });
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await ActivityLog.deleteMany({ createdAt: { $lt: cutoff } });

    logger.info('Activity logs purged', {
      days,
      cutoff:       cutoff.toISOString(),
      deletedCount: result.deletedCount,
      userId:       req.user?.id,
    });

    res.json({
      message:      `Purged ${result.deletedCount} log entries older than ${days} days.`,
      deletedCount: result.deletedCount,
      cutoff:       cutoff.toISOString(),
    });
  } catch (err) {
    logger.error('Log purge failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;