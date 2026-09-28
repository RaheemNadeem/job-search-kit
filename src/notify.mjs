/**
 * notify.mjs — optional notifications. If NOTIFY_WEBHOOK_URL is set, events
 * are POSTed there as JSON: { event, subject, text, html, jobs? }.
 *
 * Point it at an n8n Webhook node (see n8n/notifications.json) to turn events
 * into email, Slack, Discord, Telegram… Without it, events are only logged.
 */
import { SETTINGS } from './config.mjs';

export async function notify(event, { subject, text = '', html = '', ...extra }) {
  console.error(`[notify] ${event}: ${subject}`);
  if (!SETTINGS.notifyWebhook) return;
  try {
    await fetch(SETTINGS.notifyWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, subject, text, html, ...extra }),
    });
  } catch (e) {
    console.error(`[notify] webhook failed: ${e.message}`);
  }
}
