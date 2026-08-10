'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
// @ts-expect-error
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] ?? process.env[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

const fetch: any = globalThis.fetch;

let ntfyTopic = process.env.NTFY_TOPIC || null;
let mailTransporter: any = null;

function getMailTransporter() { 
  if (mailTransporter) return mailTransporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  try {
    const nodemailer = require('nodemailer');
    mailTransporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user, pass },
      connectionTimeout: 5000,   // 5s — fail fast on blocked ports (Render free tier)
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  } catch (e: any) {
    logError('Failed to create mail transporter', e);
    return null;
  }
  return mailTransporter;
}

async function sendNtfyAlert(message: any, title = 'MathU Bot Alert', priority = 3) { 
  if (!ntfyTopic) return;
  if (!fetch) { log('ntfy alert skipped: fetch not available', 'WARN', 'alerting'); return; }
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': String(priority),
        'Tags': 'warning',
        'Click': getCONFIG.APP_URL || 'https://app.mathu.co.za/',
      },
      body: message,
    });
    log(`📢 Sent ntfy alert to topic "${ntfyTopic}"`, 'DEBUG', 'alerting');
  } catch (e: any) {
    logError('Failed to send ntfy alert', e);
  }
}

async function sendEmailAlert(message: any) { 
  const to = process.env.ALERT_EMAIL_TO;
  if (!to) return;
  const transporter = getMailTransporter();
  if (!transporter) return;
  try {
    // FIX: Wrap in timeout to prevent ETIMEDOUT hanging the alert pipeline.
    // Render free tier blocks outbound SMTP — fail fast instead of hanging.
    await Promise.race([
      transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: 'MathU Bot Alert',
        text: message,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('EMAIL_TIMEOUT')), 8000)),
    ]);
    log(`Sent email alert to ${to}`, 'DEBUG', 'alerting');
  } catch (e: any) {
    // Render free tier blocks outbound SMTP (ports 25/587/465).
    // Log at DEBUG (was WARN) to avoid triggering alert cascades.
    // The ETIMEDOUT in logs was generating secondary alerts.
    log(`Email alert skipped: ${e.code || e.message}`, 'DEBUG', 'alerting');
  }
}

async function sendSlackAlert(message: any) { 
  if (!getCONFIG.SLACK_WEBHOOK_URL) return;
  if (!fetch) { log('Slack alert skipped: fetch not available', 'WARN', 'alerting'); return; }
  try {
    await fetch(getCONFIG.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 MathU Bot Alert: ${message}` }),
    });
  } catch (e: any) {
    logError('Failed to send Slack alert', e);
  }
}

async function sendTelegramAlert(message: any) { 
  const token = getCONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = getCONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  if (!fetch) { log('Telegram alert skipped: fetch not available', 'WARN', 'alerting'); return; }
  try {
    // Token is required in the URL path by the Telegram Bot API.
    // The logger's redactSensitive() will scrub it from log output.
    // chat_id is sent in the POST body (not URL) to limit token exposure.
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚨 MathU Bot Alert: ${message}`,
      }),
    });
  } catch (e: any) {
    logError('Failed to send Telegram alert', e);
  }
}

// FIX: Track recently sent alert hashes to suppress exact duplicates.
// The logs show the same alert firing twice (e.g. auth failure logged twice
// from parallel workers). Dedup by message hash.
const _recentAlertHashes = new Map<string, number>(); // hash -> timestamp
const ALERT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

let alertRateLimiter = {
  lastAlertTime: 0,
  minIntervalMs: 60000,
  maxAlertsPerHour: 10,
  alertCount: 0,
  resetTime: Date.now(),
};

function canSendAlert() { 
  const now = Date.now();
  if (now - alertRateLimiter.resetTime > 3600000) {
    alertRateLimiter.alertCount = 0;
    alertRateLimiter.resetTime = now;
  }
  if (alertRateLimiter.alertCount >= alertRateLimiter.maxAlertsPerHour) {
    return false;
  }
  if (now - alertRateLimiter.lastAlertTime < alertRateLimiter.minIntervalMs) {
    return false;
  }
  return true;
}

// v6-fix: Rotate critical-alerts.log at 5MB — over 5 years, append-only = disk full.
const ALERT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ALERT_LOG_ROTATE_COUNT = 3;

function _rotateAlertLog(alertLog: string) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(alertLog)) return;
    const stat = fs.statSync(alertLog);
    if (stat.size < ALERT_LOG_MAX_BYTES) return;
    for (let i = ALERT_LOG_ROTATE_COUNT; i >= 1; i--) {
      const newer = `${alertLog}.${i}`;
      const older = i < ALERT_LOG_ROTATE_COUNT ? `${alertLog}.${i + 1}` : null;
      if (older) { try { fs.renameSync(newer, older); } catch {} }
      try { fs.renameSync(alertLog, newer); } catch {}
    }
  } catch {}
}

function _alertHash(msg: string): string {
  // Simple hash: take first 100 chars (enough to identify alert type)
  const key = String(msg).substring(0, 100);
  let hash = 0;
  for (let i = 0; i < key.length; i++) { hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0; }
  return String(hash);
}

async function sendAlert(message: any, priority = 3) { 
  // FIX: Deduplicate alerts — suppress if identical alert sent recently
  const hash = _alertHash(String(message));
  const lastSent = _recentAlertHashes.get(hash);
  if (lastSent && (Date.now() - lastSent) < ALERT_DEDUP_WINDOW_MS) {
    log(`Alert deduplicated: ${message}`, 'DEBUG', 'alerting');
    return;
  }
  _recentAlertHashes.set(hash, Date.now());
  // Prune old entries
  if (_recentAlertHashes.size > 100) {
    const cutoff = Date.now() - ALERT_DEDUP_WINDOW_MS;
    for (const [k, v] of _recentAlertHashes) { if (v < cutoff) _recentAlertHashes.delete(k); }
  }

  if (!canSendAlert()) {
    log(`Alert suppressed due to rate limiting: ${message}`, 'DEBUG', 'alerting');
    return;
  }
  alertRateLimiter.lastAlertTime = Date.now();
  alertRateLimiter.alertCount++;

  const { redactSensitive } = require('./logger');
  const fullMessage = `[${new Date().toISOString()}] ${redactSensitive(String(message))}`;
  log(`ALERT: ${message}`, 'WARN', 'alerting');

  await Promise.allSettled([
    sendNtfyAlert(fullMessage, 'MathU Bot Alert', priority),
    sendEmailAlert(fullMessage),
    sendSlackAlert(fullMessage),
    sendTelegramAlert(fullMessage),
  ]);

  if (priority <= 2) {
    try {
      const fs = require('fs');
      const path = require('path');
      const alertLog = path.join(getCONFIG.LOG_DIR || '.', 'critical-alerts.log');
      _rotateAlertLog(alertLog);
      fs.appendFileSync(alertLog, fullMessage + '\n');
    } catch (e: any) { log('Failed to write critical alert to log file', 'WARN', 'alerting'); }
  }
}

function setNtfyTopic(topic: any) { 
  ntfyTopic = topic;
}

module.exports = {
  sendAlert,
  sendNtfyAlert,
  sendEmailAlert,
  sendSlackAlert,
  sendTelegramAlert,
  setNtfyTopic,
  canSendAlert,
  _injectDependencies,
};
