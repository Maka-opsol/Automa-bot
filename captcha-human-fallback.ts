'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');

const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');

// Use USER_DATA_DIR (set by render-free-plan.ts to /tmp/.browser-data) instead
// of PROJECT_ROOT (/app/) which is read-only in Docker.
function getSessionDir() {
  return process.env.USER_DATA_DIR || path.join(os.tmpdir(), '.browser-data');
}
let TelegramBot: any;
try { TelegramBot = require('node-telegram-bot-api'); } catch (e: any) { TelegramBot = null; }
const fs = require('fs');

class HumanFallbackCaptcha {
  bot: any;
  pendingRequests: any;

  constructor() {
    this.bot = null;
    this.pendingRequests = new Map(); // chatId -> Array<{resolve, timeout}>
    if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID && TelegramBot) {
      this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
      const self = this;
      this.bot.on('message', (msg: any) => {
        const chatId = String(msg.chat.id); // Telegram API returns number; coerce to string for Map key consistency
        const queue = self.pendingRequests.get(chatId);
        if (queue && queue.length > 0) {
          const { resolve, timeout } = queue.shift();
          clearTimeout(timeout);
          resolve(msg.text);
          if (queue.length === 0) self.pendingRequests.delete(chatId);
        }
      });
    }
  }

  async requestHumanCaptcha(base64Image: any) { 
    if (!this.bot) return null;
    const chatId = String(CONFIG.TELEGRAM_CHAT_ID); // ensure consistent string type
    await this.bot.sendPhoto(chatId, Buffer.from(base64Image, 'base64'), { caption: '🧑‍💻 Solve this CAPTCHA please!' });
    log('📱 Sent CAPTCHA to Telegram for human solving.', 'INFO', 'human-captcha');
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const queue = this.pendingRequests.get(chatId);
        if (queue) {
          const idx = queue.findIndex((r: any) => r.resolve === resolve);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.pendingRequests.delete(chatId);
        }
        resolve(null);
      }, CONFIG.CAPTCHA_HUMAN_TIMEOUT_MS || 300000);
      const queue = this.pendingRequests.get(chatId) || [];
      queue.push({ resolve: (text: any) => { clearTimeout(timeout); resolve(text); }, timeout });
      this.pendingRequests.set(chatId, queue);
    });
  }

  getSessionPool() { 
    const pool = [];
    const sessionDir = getSessionDir();
    try { fs.mkdirSync(sessionDir, { recursive: true }); } catch { /* best-effort */ }
    for (let i = 1; i <= 5; i++) {
      const file = path.join(sessionDir, `session-${i}.json`);
      if (fs.existsSync(file)) { try { pool.push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_e: any) { /* malformed data, skipping */ } }
    }
    return pool;
  }

  saveSessionToPool(storage: any) { 
    const sessionDir = getSessionDir();
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      for (let i = 5; i > 1; i--) {
        const src = path.join(sessionDir, `session-${i-1}.json`);
        const dest = path.join(sessionDir, `session-${i}.json`);
        if (fs.existsSync(src)) fs.renameSync(src, dest);
      }
      fs.writeFileSync(path.join(sessionDir, 'session-1.json'), JSON.stringify(storage, null, 2));
      log('Saved session to pool.', 'INFO', 'session-pool');
    } catch (e: any) {
      // Non-critical — session pool is best-effort; fail silently in read-only envs.
      log(`Session pool write failed: ${e.code || e.message}`, 'WARN', 'session-pool');
    }
  }

  async tryAllSessions(page: any) { 
    const pool = this.getSessionPool();
    for (const session of pool) {
      try {
        await page.context().clearCookies();
      await page.context().addCookies(session.cookies || []);
        await page.goto(CONFIG.APP_URL, { waitUntil: 'domcontentloaded' });
        if (await page.url().includes('/assignments')) return true;
      } catch (_e: any) { /* non-critical, suppressed */ }
    }
    return false;
  }
}

module.exports = Object.assign(new HumanFallbackCaptcha(), { _injectDependencies });
