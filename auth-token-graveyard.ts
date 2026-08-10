// Token Lifecycle Management — with cycle integration
'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || {}; }
function log(msg: string, level: string = 'INFO', mod: string = 'token-graveyard') {
  try { const logger = _deps.logger; if (logger?.log) { logger.log(msg, level, mod); return; } } catch {}
  console.log(`[${level}] [${mod}] ${msg}`);
}

interface TokenRecord {
  type: string;
  issuedAt: number;
  expiresAt: number | null;
  refreshCount: number;
  lastRefreshAt: number | null;
  lastRefreshResult: 'success' | 'failure' | null;
  needsRelogin: boolean;
}

const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;

const _tokens: Map<string, TokenRecord> = new Map();
let _totalRefreshes = 0;
let _totalRelogins = 0;
let _checkInterval: ReturnType<typeof setInterval> | null = null;
let _started = false;

function _getRefreshBeforeExpiryMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.TOKEN_GRAVEYARD_REFRESH_BEFORE_EXPIRY_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
}

function trackToken(tokenName: string, expiresAt?: number | null): void {
  const now = Date.now();
  _tokens.set(tokenName, {
    type: tokenName.includes('refresh') ? 'refresh' : tokenName.includes('session') ? 'session' : 'access',
    issuedAt: now, expiresAt: expiresAt || null,
    refreshCount: 0, lastRefreshAt: null, lastRefreshResult: null, needsRelogin: false,
  });
  const expiryStr = expiresAt ? new Date(expiresAt).toISOString() : 'unknown';
  log(`Tracking "${tokenName}" (issued: ${new Date(now).toISOString()}, expires: ${expiryStr})`, 'INFO');
}

function recordRefresh(tokenName: string, newExpiresAt?: number | null): void {
  const token = _tokens.get(tokenName);
  if (!token) return;
  token.refreshCount++;
  token.lastRefreshAt = Date.now();
  token.lastRefreshResult = 'success';
  token.needsRelogin = false;
  if (newExpiresAt) token.expiresAt = newExpiresAt;
  _totalRefreshes++;
  log(`"${tokenName}" refreshed (#${token.refreshCount}, expires: ${newExpiresAt ? new Date(newExpiresAt).toISOString() : 'unchanged'})`, 'INFO');
}

function recordRefreshFailure(tokenName: string): void {
  const token = _tokens.get(tokenName);
  if (!token) return;
  token.lastRefreshAt = Date.now();
  token.lastRefreshResult = 'failure';
  token.needsRelogin = true;
  log(`"${tokenName}" refresh FAILED — re-login required`, 'ERROR');
  try {
    const alerting = _deps.alerting;
    if (alerting?.sendAlert) alerting.sendAlert('Token Refresh Failed', `Token "${tokenName}" refresh failed (#${token.refreshCount} prior). Re-login required.`);
  } catch {}
}

async function checkAndRefresh(authModule: any): Promise<{ needsRefresh: string[]; needsRelogin: boolean }> {
  const needsRefresh: string[] = [];
  let needsRelogin = false;
  const now = Date.now();
  const refreshBefore = _getRefreshBeforeExpiryMs();

  for (const [name, token] of _tokens) {
    if (token.needsRelogin) { needsRelogin = true; continue; }
    if (token.expiresAt === null) continue;
    const timeToExpiry = token.expiresAt - now;
    if (timeToExpiry <= 0) {
      token.needsRelogin = true; needsRelogin = true;
      log(`"${name}" EXPIRED ${Math.abs(timeToExpiry) / 1000}s ago`, 'ERROR');
      continue;
    }
    if (timeToExpiry <= refreshBefore) {
      needsRefresh.push(name);
      log(`"${name}" needs refresh (expires in ${Math.round(timeToExpiry / 1000)}s)`, 'WARN');
    }
  }

  if (needsRefresh.length > 0 && authModule) {
    for (const name of needsRefresh) {
      try {
        if (typeof authModule.refreshAccessToken === 'function') {
          await authModule.refreshAccessToken(name);
          recordRefresh(name);
        }
      } catch (err) {
        recordRefreshFailure(name);
        needsRelogin = true;
      }
    }
  }

  return { needsRefresh, needsRelogin };
}

function getTokenStatus(tokenName: string): TokenRecord | null { return _tokens.get(tokenName) || null; }
function isReloginRequired(): boolean { for (const [, t] of _tokens) { if (t.needsRelogin) return true; } return false; }
function clearTokens(): void { _tokens.clear(); _totalRelogins++; log('All tokens cleared (re-login completed)', 'INFO'); }

function getStatus() {
  const now = Date.now();
  const tokens: Record<string, any> = {};
  for (const [name, token] of _tokens) {
    tokens[name] = { type: token.type, issuedAt: token.issuedAt, expiresAt: token.expiresAt, timeToExpiryMs: token.expiresAt ? token.expiresAt - now : null, refreshCount: token.refreshCount, lastRefreshAt: token.lastRefreshAt, needsRelogin: token.needsRelogin };
  }
  return { trackedTokens: _tokens.size, totalRefreshes: _totalRefreshes, totalRelogins: _totalRelogins, reloginRequired: isReloginRequired(), tokens };
}

/**
 * FIX: Start the token graveyard with automatic cycle integration.
 * Periodically checks tokens and triggers refresh/re-login via the auth module.
 */
function start(): void {
  if (_started) return;
  _started = true;
  log('Token graveyard started', 'INFO');

  const checkMs = 60000; // Check every 60 seconds
  _checkInterval = setInterval(async () => {
    try {
      if (_tokens.size === 0) return; // Nothing to track
      const auth = _deps.auth;
      if (!auth) return;
      const result = await checkAndRefresh({
        refreshAccessToken: async (tokenName: string) => {
          // Use the auth module's refreshSession if available
          if (typeof auth.refreshSession === 'function') {
            // Create a dummy page context for refresh
            try {
              const page = _deps.browser?.browserManager?.pageInstance;
              if (page) await auth.refreshSession(page);
            } catch {}
          }
        }
      });
      if (result.needsRelogin) {
        log('Token graveyard: re-login required — notifying cycle manager', 'WARN');
        try {
          // Track in calibration so cycle-auth-guard can detect it
          const db = _deps.database?.db;
          if (db) {
            db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)').run(
              'token_relogin_required', JSON.stringify({ at: Date.now(), tokens: [..._tokens.keys()].filter(k => _tokens.get(k)?.needsRelogin) }), Date.now()
            );
          }
        } catch {}
      }
    } catch (err: any) {
      log(`Token check error: ${err.message}`, 'WARN');
    }
  }, checkMs);

  if (_checkInterval.unref) _checkInterval.unref();
}

function stop(): void {
  if (_checkInterval) { clearInterval(_checkInterval); _checkInterval = null; }
  _started = false;
  log('Token graveyard stopped', 'INFO');
}

module.exports = { _injectDependencies, trackToken, recordRefresh, recordRefreshFailure, checkAndRefresh, getTokenStatus, isReloginRequired, clearTokens, getStatus, start, stop };
