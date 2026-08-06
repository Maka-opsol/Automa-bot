// Resilience R14b: Token Lifecycle Management — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// auth-token-graveyard.ts — P2 Token Lifecycle Management
// ═══════════════════════════════════════════════════════════════
// Auth tokens can expire mid-session, causing cascading auth
// failures. This module tracks token age, schedules proactive
// refreshes, and triggers re-login before tokens die.
//
// Features:
//   1. Track token age, refresh count, and last refresh time
//   2. Proactive refresh when within 30 minutes of expected expiry
//   3. If refresh fails: immediately queue full re-login
//   4. Log token lifecycle events for debugging
//   5. Support multiple token types (access, refresh, session)
//
// Integration:
//   - Auth module calls trackToken() on login/token acquisition
//   - cycle-cycle-manager.ts calls checkAndRefresh() periodically
//   - Auth module calls onRefreshFailed() when refresh fails
//
// Config:
//   TOKEN_GRAVEYARD_REFRESH_BEFORE_EXPIRY_MS — refresh window (default 1800000 = 30 min)
//   TOKEN_GRAVEYARD_CHECK_INTERVAL_MS — check interval (default 60000 = 1 min)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'token-graveyard') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface TokenRecord {
  type: string;            // 'access', 'refresh', 'session'
  issuedAt: number;
  expiresAt: number | null; // null = no known expiry
  refreshCount: number;
  lastRefreshAt: number | null;
  lastRefreshResult: 'success' | 'failure' | null;
  needsRelogin: boolean;
}

// ─── Constants ───
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;  // 30 minutes

// ─── State ───
const _tokens: Map<string, TokenRecord> = new Map();
let _totalRefreshes = 0;
let _totalRelogins = 0;
let _checkInterval: ReturnType<typeof setInterval> | null = null;
let _started = false;

// ─── Helpers ───

function _getRefreshBeforeExpiryMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.TOKEN_GRAVEYARD_REFRESH_BEFORE_EXPIRY_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
}

// ─── Core API ───

/**
 * Track a new token.
 *
 * @param tokenName — Identifier (e.g., 'access_token', 'session_cookie')
 * @param expiresAt — Expiry timestamp (ms), or null if unknown
 */
function trackToken(tokenName: string, expiresAt?: number | null): void {
  const now = Date.now();

  _tokens.set(tokenName, {
    type: tokenName.includes('refresh') ? 'refresh' : tokenName.includes('session') ? 'session' : 'access',
    issuedAt: now,
    expiresAt: expiresAt || null,
    refreshCount: 0,
    lastRefreshAt: null,
    lastRefreshResult: null,
    needsRelogin: false,
  });

  const expiryStr = expiresAt ? new Date(expiresAt).toISOString() : 'unknown';
  log(
    `[TOKEN] Tracking "${tokenName}" (issued: ${new Date(now).toISOString()}, expires: ${expiryStr})`,
    'INFO'
  );
}

/**
 * Record a successful token refresh.
 */
function recordRefresh(tokenName: string, newExpiresAt?: number | null): void {
  const token = _tokens.get(tokenName);
  if (!token) return;

  token.refreshCount++;
  token.lastRefreshAt = Date.now();
  token.lastRefreshResult = 'success';
  token.needsRelogin = false;

  if (newExpiresAt) {
    token.expiresAt = newExpiresAt;
  }

  _totalRefreshes++;

  log(
    `[TOKEN] "${tokenName}" refreshed (#${token.refreshCount}, expires: ${newExpiresAt ? new Date(newExpiresAt).toISOString() : 'unchanged'})`,
    'INFO'
  );
}

/**
 * Record a failed token refresh. Marks token as needing re-login.
 */
function recordRefreshFailure(tokenName: string): void {
  const token = _tokens.get(tokenName);
  if (!token) return;

  token.lastRefreshAt = Date.now();
  token.lastRefreshResult = 'failure';
  token.needsRelogin = true;

  log(
    `[TOKEN] "${tokenName}" refresh FAILED — re-login required`,
    'ERROR'
  );

  // Alert
  try {
    const alerting = (_deps as any).alerting;
    if (alerting?.sendAlert) {
      alerting.sendAlert(
        'Token Refresh Failed',
        `Token "${tokenName}" refresh failed. Re-login required. ` +
        `This token has been refreshed ${token.refreshCount} times previously.`
      );
    }
  } catch { /* non-critical */ }
}

/**
 * Check all tracked tokens and refresh any that are near expiry.
 * Call this periodically (e.g., every 60 seconds).
 *
 * @param authModule — The auth module that can perform refreshes
 *   Must have: refreshAccessToken(), isTokenExpired(), performLogin()
 * @returns { needsRefresh: string[], needsRelogin: boolean }
 */
async function checkAndRefresh(authModule: any): Promise<{
  needsRefresh: string[];
  needsRelogin: boolean;
}> {
  const needsRefresh: string[] = [];
  let needsRelogin = false;
  const now = Date.now();
  const refreshBefore = _getRefreshBeforeExpiryMs();

  for (const [name, token] of _tokens) {
    if (token.needsRelogin) {
      needsRelogin = true;
      continue;
    }

    if (token.expiresAt === null) {
      // No known expiry — skip
      continue;
    }

    const timeToExpiry = token.expiresAt - now;

    // Check if token is already expired
    if (timeToExpiry <= 0) {
      token.needsRelogin = true;
      needsRelogin = true;
      log(`[TOKEN] "${name}" already EXPIRED ${Math.abs(timeToExpiry) / 1000}s ago`, 'ERROR');
      continue;
    }

    // Check if within refresh window
    if (timeToExpiry <= refreshBefore) {
      needsRefresh.push(name);
      log(
        `[TOKEN] "${name}" needs refresh (expires in ${Math.round(timeToExpiry / 1000)}s, refresh window: ${refreshBefore / 1000}s)`,
        'WARN'
      );
    }
  }

  // Attempt refreshes
  if (needsRefresh.length > 0 && authModule) {
    for (const name of needsRefresh) {
      try {
        if (typeof authModule.refreshAccessToken === 'function') {
          await authModule.refreshAccessToken(name);
          // If no error thrown, record success
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

/**
 * Get status of all tracked tokens.
 */
function getTokenStatus(tokenName: string): TokenRecord | null {
  return _tokens.get(tokenName) || null;
}

/**
 * Check if any token needs re-login.
 */
function isReloginRequired(): boolean {
  for (const [, token] of _tokens) {
    if (token.needsRelogin) return true;
  }
  return false;
}

/**
 * Clear all token tracking (e.g., after successful re-login).
 */
function clearTokens(): void {
  _tokens.clear();
  _totalRelogins++;
  log('[TOKEN] All tokens cleared (re-login completed)', 'INFO');
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  trackedTokens: number;
  totalRefreshes: number;
  totalRelogins: number;
  reloginRequired: boolean;
  tokens: Record<string, {
    type: string;
    issuedAt: number;
    expiresAt: number | null;
    timeToExpiryMs: number | null;
    refreshCount: number;
    lastRefreshAt: number | null;
    needsRelogin: boolean;
  }>;
} {
  const now = Date.now();
  const tokens: Record<string, any> = {};

  for (const [name, token] of _tokens) {
    tokens[name] = {
      type: token.type,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      timeToExpiryMs: token.expiresAt ? token.expiresAt - now : null,
      refreshCount: token.refreshCount,
      lastRefreshAt: token.lastRefreshAt,
      needsRelogin: token.needsRelogin,
    };
  }

  return {
    trackedTokens: _tokens.size,
    totalRefreshes: _totalRefreshes,
    totalRelogins: _totalRelogins,
    reloginRequired: isReloginRequired(),
    tokens,
  };
}

/**
 * Start the token graveyard.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log('[TOKEN] Token graveyard started', 'INFO');
}

module.exports = {
  _injectDependencies,
  trackToken,
  recordRefresh,
  recordRefreshFailure,
  checkAndRefresh,
  getTokenStatus,
  isReloginRequired,
  clearTokens,
  getStatus,
  start,
};
