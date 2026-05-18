'use strict';
/**
 * backend/routes/trendingProductRoutes.js
 * Mounted at /api/trending-products
 *
 *   GET    /                      — list products (paginated, filterable)
 *   GET    /stats                  — counts by industry + status
 *   GET    /industries             — list all available industries
 *   GET    /run/status             — status of running / last discovery run
 *   POST   /run                    — trigger manual discovery run (non-blocking)
 *   POST   /search-by-image        — identify product from image → search (non-blocking)
 *                                    ?sync=true to wait for result
 *   PATCH  /:id/status             — update status: reviewed | promoted | dismissed
 *   DELETE /bulk/dismissed         — purge all dismissed products
 *   DELETE /:id                    — delete one product
 */

const express         = require('express');
const router          = express.Router();
const multer          = require('multer');
const TrendingProduct = require('../models/TrendingProduct');
const { runDiscovery, searchByImage, INDUSTRY_QUERIES } = require('../services/trendingProductService');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const logger          = require('../utils/logger').child({ module: 'trendingProductRoutes' });

const adminOnly   = [authenticate, authorize(['admin', 'inventory'])];
const imageUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
});

/**
 * In-memory run state — tracks the active or last completed discovery run.
 * Single-process only: this resets on server restart, which is acceptable
 * since discovery runs are short-lived background jobs.
 */
let runState = {
  running:    false,
  startedAt:  null,
  progress:   {},
  lastResult: null,
};

// ─── GET / ────────────────────────────────────────────────────────────────────
router.get('/', adminOnly, async (req, res) => {
  try {
    const {
      industry, status = '', search = '',
      page = '1', limit = '24', sort = 'newest',
    } = req.query;

    const filter = {};
    if (industry && industry !== 'all')                       filter.industry     = industry;
    if (status   && status   !== 'all')                       filter.status       = status;
    if (req.query.sourceEngine && req.query.sourceEngine !== 'all') filter.sourceEngine = req.query.sourceEngine;
    if (search) {
      filter.$or = [
        { name:         { $regex: search, $options: 'i' } },
        { description:  { $regex: search, $options: 'i' } },
        { sourceDomain: { $regex: search, $options: 'i' } },
      ];
    }

    const skip    = (parseInt(page) - 1) * parseInt(limit);
    const sortObj = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

    const [products, total] = await Promise.all([
      TrendingProduct.find(filter).sort(sortObj).skip(skip).limit(parseInt(limit)).lean(),
      TrendingProduct.countDocuments(filter),
    ]);

    logger.debug('Trending products listed', { total, page, userId: req.user?.id });
    res.json({ products, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    logger.error('Failed to list trending products', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────
router.get('/stats', adminOnly, async (req, res) => {
  try {
    const [byIndustry, byStatus, total] = await Promise.all([
      TrendingProduct.aggregate([{ $group: { _id: '$industry', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      TrendingProduct.aggregate([{ $group: { _id: '$status',   count: { $sum: 1 } } }]),
      TrendingProduct.countDocuments(),
    ]);
    res.json({ byIndustry, byStatus, total });
  } catch (err) {
    logger.error('Failed to fetch trending product stats', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /industries ──────────────────────────────────────────────────────────
router.get('/industries', adminOnly, (req, res) => {
  res.json(Object.keys(INDUSTRY_QUERIES));
});

// ─── GET /run/status ──────────────────────────────────────────────────────────
router.get('/run/status', adminOnly, (req, res) => {
  res.json(runState);
});

// ─── POST /run — trigger discovery ───────────────────────────────────────────
router.post('/run', adminOnly, async (req, res) => {
  if (runState.running) {
    return res.status(409).json({ message: 'A discovery run is already in progress.', runState });
  }

  const { industries } = req.body;
  const targets = Array.isArray(industries) && industries.length > 0
    ? industries
    : Object.keys(INDUSTRY_QUERIES);

  runState = { running: true, startedAt: new Date(), progress: {}, lastResult: null };
  logger.info('Trending product discovery run started', { industries: targets, userId: req.user?.id });
  res.json({ message: 'Discovery run started.', industries: targets });

  runDiscovery(targets, ({ industry, done, total, saved }) => {
    runState.progress[industry] = { done, total, saved };
  })
    .then(result => {
      runState.running    = false;
      runState.lastResult = result;
      logger.info('Discovery run complete', { result });
    })
    .catch(err => {
      runState.running    = false;
      runState.lastResult = { error: err.message };
      logger.error('Discovery run failed', { error: err.message, stack: err.stack });
    });
});

// ─── POST /search-by-image ────────────────────────────────────────────────────
// ?sync=true → wait for result (up to ~120s); default is non-blocking background job.
router.post('/search-by-image', adminOnly, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No image uploaded.' });

  const sync = req.query.sync === 'true';
  logger.info('Image search triggered', { sync, fileSize: req.file.size, mimeType: req.file.mimetype, userId: req.user?.id });

  if (sync) {
    req.socket.setTimeout(120_000);
    res.setTimeout(120_000);
    try {
      const result = await searchByImage(req.file.buffer);
      logger.info('Image search (sync) complete', { saved: result?.saved });
      if (!res.headersSent) res.json(result);
    } catch (err) {
      logger.error('Image search (sync) failed', { error: err.message, stack: err.stack });
      if (!res.headersSent) res.status(500).json({ message: err.message });
    }
    return;
  }

  // Async (default)
  if (runState.running) {
    return res.status(409).json({ message: 'A discovery run is already in progress.', runState });
  }
  runState = { running: true, startedAt: new Date(), progress: {}, lastResult: null, mode: 'image-search' };
  res.json({ message: 'Image search started. Poll /run/status for progress.' });

  searchByImage(req.file.buffer, ({ stage, message, query }) => {
    runState.progress['Image Search'] = { stage, message, query: query || '' };
  })
    .then(result => {
      runState.running    = false;
      runState.lastResult = result;
      logger.info('Image search (async) complete', { saved: result?.saved });
    })
    .catch(err => {
      runState.running    = false;
      runState.lastResult = { error: err.message };
      logger.error('Image search (async) failed', { error: err.message, stack: err.stack });
    });
});

// ─── PATCH /:id/status ────────────────────────────────────────────────────────
router.patch('/:id/status', adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed    = ['new', 'reviewed', 'promoted', 'dismissed'];
    if (!allowed.includes(status))
      return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });

    const product = await TrendingProduct.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    logger.info('Trending product status updated', { productId: req.params.id, status, userId: req.user?.id });
    res.json(product);
  } catch (err) {
    logger.error('Trending product status update failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /bulk/dismissed ───────────────────────────────────────────────────
// MUST be registered before /:id so Express doesn't match "bulk" as an ID param
router.delete('/bulk/dismissed', adminOnly, async (req, res) => {
  try {
    const result = await TrendingProduct.deleteMany({ status: 'dismissed' });
    logger.info('Dismissed trending products purged', { deleted: result.deletedCount, userId: req.user?.id });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    logger.error('Bulk dismiss purge failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const product = await TrendingProduct.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    logger.info('Trending product deleted', { productId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Trending product delete failed', { productId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;