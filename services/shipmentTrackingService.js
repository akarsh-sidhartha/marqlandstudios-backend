'use strict';
/**
 * backend/services/shipmentTrackingService.js
 *
 * PRIMARY PROVIDER: trackcourier.io (unified aggregator)
 *   - Covers Blue Dart, DTDC, DP World, Delhivery, Ekart, etc. via one API
 *   - API key stored in process.env.TRACKCOURIER_API_KEY
 *
 * FUTURE DIRECT INTEGRATIONS:
 *   When you obtain a direct API from a courier partner, add a handler in
 *   DIRECT_HANDLERS keyed by the partner name (must match what's saved in
 *   the ShippingPartner collection). Direct handlers are tried first;
 *   trackcourier.io is the fallback for everything else.
 *
 * POLLING INTERVALS (to avoid unnecessary API calls):
 *   Pending          → poll after 8 hrs
 *   Booked           → poll after 8 hrs
 *   In Transit       → poll after 4 hrs
 *   Out for Delivery → poll after 4 hrs
 *   Delivered        → never poll  (terminal)
 *   Returned         → never poll  (terminal)
 *   Exception        → never poll  (terminal)
 *
 * The scheduler runs every 30 minutes but each shipment is only actually
 * polled when its minimum interval has elapsed since lastTrackedAt.
 * This way fast-moving shipments (Out for Delivery) are checked more
 * frequently than idle ones (Pending/Booked).
 */

const Shipment        = require('../models/Shipment');
const ShippingPartner = require('../models/ShippingPartner');
const axios           = require('axios');
const logger          = require('../utils/logger').child({ module: 'shipmentTrackingService' });

// ── Polling interval config ───────────────────────────────────────────────────
// Returns the minimum number of milliseconds that must have passed since
// lastTrackedAt before we poll again. Null = never poll.
const POLL_INTERVAL_MS = {
  'Pending':           8 * 60 * 60 * 1000,   // 8 hours
  'Booked':            8 * 60 * 60 * 1000,   // 8 hours
  'In Transit':        4 * 60 * 60 * 1000,   // 4 hours
  'Out for Delivery':  4 * 60 * 60 * 1000,   // 4 hours
  'Delivered':         null,                  // terminal — skip
  'Completed':         null,                  // terminal — skip
  'Returned':          null,                  // terminal — skip
  'Exception':         null,                  // terminal — skip
};

const shouldPoll = (shipment) => {
  const interval = POLL_INTERVAL_MS[shipment.status];
  if (interval === null || interval === undefined) return false;    // terminal
  if (!shipment.lastTrackedAt) return true;                        // never polled yet
  return (Date.now() - new Date(shipment.lastTrackedAt).getTime()) >= interval;
};

// ── trackcourier.io status normaliser ────────────────────────────────────────
// Maps trackcourier.io "status" strings to our internal enum.
// Full status list: https://docs.trackcourier.io/reference/statuses
const normaliseTrackCourier = (raw = '') => {
  const s = raw.toLowerCase().trim();

  // Machine values (ShipmentState) and human values (MostRecentStatus) — cover both
  // DTDC-specific: "delivered", "out for delivery", "in transit", "booked"
  if (s === 'delivered'     || s === 'dlv'
    || s === 'shipment delivered')                                   return 'Delivered';
  if (s === 'out_for_delivery' || s === 'out for delivery'
    || s === 'outfordelivery'  || s === 'ofd'
    || s === 'out-for-delivery')                                     return 'Out for Delivery';
  if (s === 'in_transit'    || s === 'in transit'
    || s === 'intransit'    || s === 'transit'
    || s === 'in-transit')                                           return 'In Transit';
  if (s === 'picked_up'     || s === 'pickedup'
    || s === 'booked'       || s === 'manifested'
    || s === 'info_received'|| s === 'inforeceived'
    || s === 'registered'   || s === 'shipment booked')              return 'Booked';
  if (s === 'returned'      || s === 'rto'
    || s === 'return_to_origin' || s === 'return to origin')        return 'Returned';
  if (s === 'exception'     || s === 'failed'
    || s === 'lost'         || s === 'undelivered'
    || s === 'delivery_failed' || s === 'misrouted')                 return 'Exception';
  if (s === 'pending'       || s === 'not_found'
    || s === 'notfound'     || s === 'no information')               return 'Pending';

  // Substring fallback
  if (s.includes('deliver') && !s.includes('out') && !s.includes('fail') && !s.includes('un')) return 'Delivered';
  if (s.includes('out') && (s.includes('deliver') || s.includes('ofd'))) return 'Out for Delivery';
  if (s.includes('transit') || s.includes('in-transit'))             return 'In Transit';
  if (s.includes('pick') || s.includes('book') || s.includes('manifest')) return 'Booked';
  if (s.includes('return') || s.includes('rto'))                     return 'Returned';
  if (s.includes('exception') || s.includes('fail') || s.includes('lost') || s.includes('undeliver')) return 'Exception';

  return null;
};

// ── Partner name → trackcourier.io slug map ───────────────────────────────────
// The API requires the courier's exact slug (not a freeform name).
// Keys must match what's stored in the ShippingPartner collection (case-insensitive).
// Get the full list from: GET https://api.trackcourier.io/v1/couriers
const COURIER_SLUG_MAP = {
  'blue dart':          'bluedart',
  'bluedart':           'bluedart',
  'dtdc':               'dtdc',
  'delhivery':          'delhivery',
  'ekart':              'ekart',
  'ekart logistics':    'ekart',
  'ecom express':       'ecom-express',
  'xpressbees':         'xpressbees',
  'shadowfax':          'shadowfax',
  'gati':               'gati',
  'gati kwe':           'gati-kwe',
  'fedex':              'fedex',
  'fedex india':        'fedex',
  'dhl':                'dhl-express',
  'dhl express':        'dhl-express',
  'aramex':             'aramex',
  'ups':                'ups',
  'india post':         'india-post-domestic',
  'speed post':         'india-post-domestic',
  'professional courier': 'professional-courier',
  'tci express':        'tci-express',
  'spoton':             'spoton',
  'safexpress':         'safexpress',
  'trackon':            'trackon',
  'first flight':       'first-flight',
  'dp world':           'dp-world',
};

const toCourierSlug = (name = '') => {
  const key = name.toLowerCase().trim();
  return COURIER_SLUG_MAP[key] || null; // null = let API auto-detect
};

// ── trackcourier.io API call ──────────────────────────────────────────────────
// Correct endpoint: GET https://api.trackcourier.io/v1/track
//   Query params:   courier=<slug>  (optional, improves accuracy)
//                   tracking_number=<id>
// Auth header:      X-API-Key: <key>   (NOT "api-key")
// Response shape:   { success, data: { status, MostRecentStatus, ... }, usage }
const fetchFromTrackCourier = async (trackingId, courierName = '') => {
  const apiKey = process.env.TRACKCOURIER_API_KEY;
  if (!apiKey) throw new Error('TRACKCOURIER_API_KEY not set in environment');

  const slug = toCourierSlug(courierName);

  // courier param is REQUIRED — API returns 422 without it
  if (!slug) {
    logger.warn('No courier slug mapped — skipping shipment', { courierName, trackingId });
    return null;
  }

  const res = await axios.get(
    'https://api.trackcourier.io/v1/track',
    {
      headers: { 'X-API-Key': apiKey },
      params:  { tracking_number: trackingId, courier: slug },
      timeout: 10000,
    }
  );

  const data = res.data;
  const d    = data?.data;

  logger.debug('TrackCourier response', { trackingId, slug, result: d?.Result, state: d?.ShipmentState, mostRecent: d?.MostRecentStatus, isEmpty: d?.isEmptyTable });

  if (!data?.success) return null;

  // When courier has no data yet, don't overwrite the current status
  if (d?.Result === 'failure' || d?.isEmptyTable) {
    logger.debug('TrackCourier returned no data — keeping current status', { trackingId });
    return null;
  }

  // Real API returns ShipmentState (machine value) — docs incorrectly show "status"
  // Fall back to MostRecentStatus if ShipmentState is missing
  const rawState = d?.ShipmentState || d?.MostRecentStatus || '';
  if (!rawState) return null;

  const normalised = normaliseTrackCourier(rawState);
  if (!normalised) {
    logger.warn('Unknown TrackCourier ShipmentState — add to normaliseTrackCourier()', { rawState, trackingId });
  }
  return normalised;
};

// ── DIRECT HANDLERS (future cost-saving integrations) ────────────────────────
// Add an entry here when you get a direct API contract with a courier partner.
// Key must match the partner name stored in the ShippingPartner collection.
// Each handler receives (trackingId, partnerDoc) and returns a status string or null.
//
// Example (uncomment and fill in when ready):
//
// const DIRECT_HANDLERS = {
//   'Blue Dart': async (trackingId, partner) => {
//     const res = await axios.get(`${partner.apiEndpoint}/${trackingId}`, {
//       headers: { Authorization: `Bearer ${partner.apiKey}` },
//       timeout: 8000,
//     });
//     return normaliseTrackCourier(res.data?.ShipmentTrackingNumber?.[0]?.Status || '');
//   },
// };
//
const DIRECT_HANDLERS = {};  // empty until direct integrations are added

// ── Core: poll a single shipment ─────────────────────────────────────────────
const pollShipment = async (shipment, partnerMap) => {
  // 1. Try direct integration first (cheaper)
  const directHandler = DIRECT_HANDLERS[shipment.shippingPartner];
  if (directHandler) {
    const partnerDoc = partnerMap[shipment.shippingPartner];
    if (partnerDoc) {
      return directHandler(shipment.trackingId, partnerDoc);
    }
  }

  // 2. Fall back to trackcourier.io
  return fetchFromTrackCourier(shipment.trackingId, shipment.shippingPartner);
};

// ── Main refresh function ─────────────────────────────────────────────────────
// Called by the scheduler and by POST /api/shipments/refresh-status (manual trigger).
const refreshShipmentStatuses = async () => {
  // Fetch all non-terminal shipments that have a tracking ID
  const candidates = await Shipment.find({
    status:     { $nin: ['Delivered', 'Completed', 'Returned', 'Exception'] },
    trackingId: { $nin: ['', null] },
  }).lean();

  if (candidates.length === 0) {
    logger.debug('No active shipments to poll');
    return { updated: 0, skipped: 0, errors: 0, total: 0 };
  }

  // Filter to only those whose polling interval has elapsed
  const due = candidates.filter(shouldPoll);

  logger.info('Shipment tracking poll starting', { active: candidates.length, due: due.length });
  if (due.length === 0) {
    logger.debug('No shipments due for polling yet');
    return { updated: 0, skipped: candidates.length, errors: 0, total: candidates.length };
  }

  // Load partner docs once (for direct handlers)
  const partnerDocs = await ShippingPartner.find().lean();
  const partnerMap  = Object.fromEntries(partnerDocs.map(p => [p.name, p]));

  let updated = 0, skipped = 0, errors = 0;

  await Promise.allSettled(due.map(async (shipment) => {
    try {
      const newStatus = await pollShipment(shipment, partnerMap);

      if (newStatus && newStatus !== shipment.status) {
        await Shipment.findByIdAndUpdate(shipment._id, {
          status:        newStatus,
          lastTrackedAt: new Date(),
        });
        logger.info('Shipment status updated', { trackingId: shipment.trackingId, from: shipment.status, to: newStatus });
        updated++;
      } else {
        // No status change — just update the poll timestamp
        await Shipment.findByIdAndUpdate(shipment._id, { lastTrackedAt: new Date() });
      }
    } catch (err) {
      logger.error('Shipment poll error', { trackingId: shipment.trackingId, error: err.message, stack: err.stack });
      errors++;
    }
  }));

  const summary = { updated, skipped: candidates.length - due.length, errors, total: candidates.length };
  logger.info('Shipment tracking poll complete', summary);
  return summary;
};

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Runs every 30 minutes in PRODUCTION only.
// In development, the scheduler is disabled by default to avoid burning API
// quota — both environments share the same MongoDB so both would otherwise
// poll the same shipments simultaneously.
//
// To enable polling in development, set ENABLE_TRACKING_SCHEDULER=true in .env
//
// Call startTrackingScheduler() once from server.js at startup.
const startTrackingScheduler = () => {
  const isProd    = process.env.NODE_ENV === 'production';
  const forceOn   = process.env.ENABLE_TRACKING_SCHEDULER === 'true';

  if (!isProd && !forceOn) {
    logger.info('Shipment tracking scheduler disabled in development', { tip: 'Set ENABLE_TRACKING_SCHEDULER=true to override' });
    return;
  }

  const TICK = 30 * 60 * 1000; // 30 minutes
  logger.info('Shipment tracking scheduler started', { mode: isProd ? 'production' : 'dev-forced', intervalMinutes: 30 });

  // Run once immediately on startup to catch anything overdue
  refreshShipmentStatuses().catch(err =>
    logger.error('Shipment tracking startup poll failed', { error: err.message })
  );

  setInterval(() => {
    logger.debug('Shipment tracking scheduled tick');
    refreshShipmentStatuses().catch(err =>
      logger.error('Shipment tracking scheduler tick failed', { error: err.message })
    );
  }, TICK);
};

module.exports = { refreshShipmentStatuses, startTrackingScheduler };