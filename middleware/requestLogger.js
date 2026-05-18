'use strict';
/**
 * backend/middleware/requestLogger.js
 *
 * HTTP request logger middleware.
 * Logs every request with method, path, status code, duration, and user context.
 * Mount this in server.js AFTER cookieParser and BEFORE routes.
 *
 * Each request gets a unique requestId so you can trace all log lines for
 * one request across multiple modules (e.g. authMiddleware → productRoutes → DB).
 *
 * USAGE in server.js:
 *   const { requestLogger, attachRequestId } = require('./middleware/requestLogger');
 *   app.use(attachRequestId);   // assigns req.requestId
 *   app.use(requestLogger);     // logs req start + end
 */

const crypto = require('crypto');
const logger  = require('../utils/logger').child({ module: 'http' });

/**
 * attachRequestId
 * Adds a short unique ID to every request.
 * Downstream middleware/routes can include req.requestId in their own logs
 * so you can grep a single request across the entire log file.
 */
const attachRequestId = (req, res, next) => {
  req.requestId = crypto.randomBytes(4).toString('hex'); // e.g. "a3f9b2c1"
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/**
 * requestLogger
 * Logs the incoming request immediately (so you can see it even if the handler crashes),
 * then logs the completed response once it finishes with status + duration.
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Skip logging for static file requests — too noisy and not useful for debugging
  if (req.url.startsWith('/uploads') || req.url.startsWith('/public')) {
    return next();
  }

  // Log incoming request
  logger.http('→ Incoming request', {
    requestId: req.requestId,
    method:    req.method,
    path:      req.path,
    query:     Object.keys(req.query).length ? req.query : undefined,
    ip:        req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Log outgoing response
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level    = res.statusCode >= 500 ? 'error'
                   : res.statusCode >= 400 ? 'warn'
                   : 'http';

    logger[level]('← Response sent', {
      requestId: req.requestId,
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      duration:  `${duration}ms`,
      // Attach user context if auth middleware has run
      userId:    req.user?.id,
      userRole:  req.user?.role,
    });
  });

  next();
};

module.exports = { attachRequestId, requestLogger };