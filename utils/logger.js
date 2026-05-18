'use strict';
/**
 * backend/utils/logger.js
 *
 * Centralised Winston logger. Import this everywhere instead of console.log.
 *
 * USAGE:
 *   const logger = require('../utils/logger').child({ module: 'authRoutes' });
 *   logger.info('User logged in', { userId, role });
 *   logger.warn('Sync skipped', { reason: err.message });
 *   logger.error('DB query failed', { error: err.message, stack: err.stack });
 *
 * LOG LEVELS (lowest number = highest priority):
 *   error  0 — caught exceptions, DB failures, auth rejections
 *   warn   1 — recoverable issues, skipped steps, degraded behaviour
 *   info   2 — successful key operations (login, save, email sent)
 *   http   3 — HTTP request/response (handled by requestLogger middleware)
 *   debug  4 — detailed internals (disabled in production)
 *
 * OUTPUT:
 *   logs/error.log    — error level only, 30-day rotation
 *   logs/combined.log — info and above, 14-day rotation
 *   Console           — coloured in dev, JSON in production
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOG_DIR       = path.join(process.cwd(), 'logs');

// ── Custom log format for console (dev) ──────────────────────────────────────
// Example: 2025-01-15 10:32:45 [INFO] [authRoutes] User logged in { userId: '...' }
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
    const moduleTag = mod ? ` [${mod}]` : '';
    const metaStr   = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level}${moduleTag} ${message}${metaStr}`;
  })
);

// ── JSON format for files and prod console ────────────────────────────────────
// Machine-readable — easy to grep, pipe to log aggregators, or import into tools.
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }), // includes stack traces on Error objects
  winston.format.json()
);

// ── Transports ────────────────────────────────────────────────────────────────

const transports = [
  // Console
  new winston.transports.Console({
    format: IS_PRODUCTION ? jsonFormat : devFormat,
    level:  IS_PRODUCTION ? 'info' : 'debug',
  }),

  // errors only — long retention for post-incident analysis
  new DailyRotateFile({
    dirname:        LOG_DIR,
    filename:       'error-%DATE%.log',
    datePattern:    'YYYY-MM-DD',
    level:          'error',
    maxFiles:       '30d',
    zippedArchive:  true,
    format:         jsonFormat,
  }),

  // everything info+ — general operational log
  new DailyRotateFile({
    dirname:        LOG_DIR,
    filename:       'combined-%DATE%.log',
    datePattern:    'YYYY-MM-DD',
    level:          'info',
    maxFiles:       '14d',
    zippedArchive:  true,
    format:         jsonFormat,
  }),
];

// In development, also write a debug log with all levels
if (!IS_PRODUCTION) {
  transports.push(new DailyRotateFile({
    dirname:      LOG_DIR,
    filename:     'debug-%DATE%.log',
    datePattern:  'YYYY-MM-DD',
    level:        'debug',
    maxFiles:     '3d',
    zippedArchive: false,
    format:       jsonFormat,
  }));
}

// ── Root logger ───────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  levels: winston.config.npm.levels,
  transports,
  exitOnError: false,
});

module.exports = logger;