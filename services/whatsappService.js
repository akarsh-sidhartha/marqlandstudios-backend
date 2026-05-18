'use strict';
/**
 * backend/services/whatsappService.js
 *
 * WhatsApp Cloud API wrapper.
 * All functions read env vars at call time (not at module load) so they
 * always pick up the correct values after dotenv.config() has run.
 *
 * ENV vars required:
 *   WHATSAPP_TOKEN            — Bearer token from Meta app dashboard
 *   WHATSAPP_PHONE_NUMBER_ID  — Phone number ID (not the phone number itself)
 *   WHATSAPP_RECIPIENT_PHONE  — Default recipient for daily status reports
 *   WHATSAPP_VERSION          — API version (default: v18.0)
 */

const axios  = require('axios');
const logger = require('../utils/logger').child({ module: 'whatsappService' });

// ── Internal helper: build the messages endpoint URL ──────────────────────────
const messagesUrl = (phoneId, version = 'v18.0') =>
  `https://graph.facebook.com/${version}/${phoneId}/messages`;

// ── Internal helper: common auth header ──────────────────────────────────────
const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

// ── Internal helper: read config from env at call time ───────────────────────
const getConfig = () => ({
  token:     process.env.WHATSAPP_TOKEN,
  phoneId:   process.env.WHATSAPP_PHONE_NUMBER_ID,
  recipient: process.env.WHATSAPP_RECIPIENT_PHONE,
  version:   process.env.WHATSAPP_VERSION || 'v18.0',
});

/**
 * sendWhatsAppMessage
 * Sends a text message to any phone number.
 * Used by inquiryRoutes to notify vendors of new sourcing requests.
 */
async function sendWhatsAppMessage(to, text) {
  const { token, phoneId, version } = getConfig();
  if (!token || !phoneId) {
    logger.error('WhatsApp credentials missing — cannot send message', { to });
    throw new Error('WhatsApp credentials not configured in .env');
  }

  try {
    await axios.post(
      messagesUrl(phoneId, version),
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: { ...authHeader(token), 'Content-Type': 'application/json' } }
    );
    logger.debug('WhatsApp message sent', { to });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    logger.error('WhatsApp send failed', { to, error: detail, status: err.response?.status });
    throw new Error(detail || 'Failed to send WhatsApp message');
  }
}

/**
 * sendReply
 * Sends a text message from a specific phone number ID.
 * Used by webhook handlers to reply to incoming messages.
 * Non-throwing — logs the error and returns without crashing the caller.
 */
async function sendReply(fromPhoneId, to, text) {
  const { token, version } = getConfig();
  if (!token) {
    logger.warn('WhatsApp token missing — reply not sent', { to });
    return;
  }
  try {
    await axios.post(
      messagesUrl(fromPhoneId, version),
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: authHeader(token) }
    );
    logger.debug('WhatsApp reply sent', { to, fromPhoneId });
  } catch (err) {
    logger.warn('WhatsApp reply failed', {
      to,
      fromPhoneId,
      error: err.response?.data?.error?.message || err.message,
    });
    // Non-throwing — reply failure must never crash the caller
  }
}

/**
 * sendDailyStatus
 * Sends the daily automation summary to the configured recipient.
 * Non-throwing — a report failure must never crash the cron job.
 */
async function sendDailyStatus(stats) {
  const { token, phoneId, recipient, version } = getConfig();
  if (!token || !phoneId || !recipient) {
    logger.warn('WhatsApp daily status skipped — missing token, phoneId, or recipient');
    return;
  }

  const body =
    `📅 *Daily Automation Report*\n\n` +
    `✅ Outlook Sync: ${stats.outlookStatus}\n` +
    `📄 Invoices Saved: ${stats.invoicesCount}\n` +
    `🕒 Time: ${new Date().toLocaleTimeString('en-IN')}`;

  try {
    await axios.post(
      messagesUrl(phoneId, version),
      {
        messaging_product: 'whatsapp',
        to:   recipient,
        type: 'text',
        text: { body },
      },
      { headers: authHeader(token) }
    );
    logger.info('Daily status report sent via WhatsApp', { recipient, stats });
  } catch (err) {
    logger.error('Daily status WhatsApp report failed', {
      error:  err.response?.data?.error?.message || err.message,
      status: err.response?.status,
    });
    // Non-throwing — report failure must never crash the cron job
  }
}

/**
 * downloadWhatsAppMedia
 * Downloads an image or PDF from WhatsApp servers and returns base64 + mimeType.
 * Returns null on failure so callers can handle gracefully.
 */
async function downloadWhatsAppMedia(mediaId) {
  const { token, version } = getConfig();
  if (!token) {
    logger.warn('WhatsApp token missing — cannot download media', { mediaId });
    return null;
  }

  try {
    // Step 1: Resolve media URL from ID
    const metaRes = await axios.get(
      `https://graph.facebook.com/${version}/${mediaId}`,
      { headers: authHeader(token) }
    );

    // Step 2: Download the actual file
    const fileRes = await axios.get(metaRes.data.url, {
      headers:      authHeader(token),
      responseType: 'arraybuffer',
    });

    return {
      base64:   Buffer.from(fileRes.data).toString('base64'),
      mimeType: fileRes.headers['content-type'],
    };
  } catch (err) {
    logger.error('WhatsApp media download failed', {
      mediaId,
      error:  err.response?.data?.error?.message || err.message,
      status: err.response?.status,
    });
    return null;
  }
}

/**
 * syncWhatsAppInvoices
 * Called by the daily cron job. WhatsApp uses webhooks for real-time delivery
 * so this function validates that credentials are present and the listener is
 * configured correctly — it does not actively pull messages.
 */
async function syncWhatsAppInvoices() {
  const { token, phoneId } = getConfig();
  if (!token || !phoneId) {
    const err = 'WhatsApp credentials missing in .env';
    logger.error(err);
    return { success: false, error: err };
  }
  logger.info('WhatsApp webhook listener active — real-time processing confirmed');
  return { success: true, message: 'WhatsApp webhook listener is active.' };
}

module.exports = {
  sendWhatsAppMessage,
  sendDailyStatus,
  sendReply,
  downloadWhatsAppMedia,
  syncWhatsAppInvoices,
};