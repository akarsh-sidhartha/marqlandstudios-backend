'use strict';
/**
 * backend/routes/sendMessages.js
 * Mounted at /api/messaging
 *
 *   POST /broadcast — send a WhatsApp template + attachments to multiple contacts
 *
 * ENV vars required:
 *   WHATSAPP_VERSION        (default: v21.0)
 *   WHATSAPP_PHONE_NUMBER_ID
 *   WHATSAPP_TOKEN
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const logger  = require('../utils/logger').child({ module: 'sendMessages' });

// ── Helper: send one WhatsApp API request ─────────────────────────────────────
// Env vars are read inside the helper (not at module load) so they're always
// current after dotenv.config() has run.
const waPost = (phoneNumberId, token, version, payload) =>
  axios.post(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

/**
 * POST /api/messaging/broadcast
 * Sends a WhatsApp template message + optional attachments to multiple contacts.
 *
 * Body: {
 *   contacts:    [{ name, phone }]   — required
 *   message:     string              — injected into template body
 *   attachments: [{ url, name, type }]
 * }
 *
 * Contacts are processed sequentially to avoid hitting the WhatsApp API
 * rate limit. Each contact is independent — one failure does not block others.
 */
router.post('/broadcast', async (req, res) => {
  const { contacts, message, attachments } = req.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ message: 'No recipient contacts provided.' });
  }

  // Read env vars at call time — guaranteed to be set after dotenv.config()
  const version      = process.env.WHATSAPP_VERSION       || 'v21.0';
  const phoneId      = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token        = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    logger.error('WhatsApp broadcast config missing', {
      phoneIdSet: !!phoneId,
      tokenSet:   !!token,
    });
    return res.status(503).json({ message: 'WhatsApp is not configured on this server.' });
  }

  logger.info('WhatsApp broadcast started', {
    contactCount:    contacts.length,
    hasAttachments:  !!(attachments?.length),
    userId:          req.user?.id,
  });

  const results = { total: contacts.length, success: [], failed: [] };

  // Sequential — avoids simultaneous API calls that can trigger rate limits
  for (const contact of contacts) {
    const cleanPhone = contact.phone?.replace(/\D/g, '');
    if (!cleanPhone) {
      results.failed.push({ phone: contact.phone, error: 'Invalid phone number.' });
      continue;
    }

    try {
      // Step 1: Send the main text template
      await waPost(phoneId, token, version, {
        messaging_product: 'whatsapp',
        to:                cleanPhone,
        type:              'template',
        template: {
          name:     'product_broadcast', // must exist in Meta dashboard
          language: { code: 'en_US' },
          components: [{
            type:       'body',
            parameters: [
              { type: 'text', text: contact.name  || 'Vendor' },
              { type: 'text', text: message       || 'Please check the following product requirements.' },
            ],
          }],
        },
      });

      // Step 2: Send attachments as follow-up messages
      if (attachments?.length) {
        for (const file of attachments) {
          let mediaType = 'document';
          if (file.type?.startsWith('image/')) mediaType = 'image';
          else if (file.type?.startsWith('video/')) mediaType = 'video';
          else if (file.type?.startsWith('audio/')) mediaType = 'audio';

          await waPost(phoneId, token, version, {
            messaging_product: 'whatsapp',
            to:                cleanPhone,
            type:              mediaType,
            [mediaType]: {
              link:    file.url,
              caption: file.name || 'Product Detail',
            },
          });
        }
      }

      logger.debug('Broadcast sent', { phone: cleanPhone, name: contact.name });
      results.success.push({ phone: cleanPhone, name: contact.name });

    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      logger.warn('Broadcast failed for contact', {
        phone:  cleanPhone,
        name:   contact.name,
        error:  detail,
        status: err.response?.status,
      });
      results.failed.push({ phone: cleanPhone, error: detail });
    }
  }

  logger.info('WhatsApp broadcast complete', {
    success: results.success.length,
    failed:  results.failed.length,
    userId:  req.user?.id,
  });

  res.json({ message: 'Broadcast sequence completed.', summary: results });
});

module.exports = router;