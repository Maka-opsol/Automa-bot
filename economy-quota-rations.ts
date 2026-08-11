// Resilience R12: Quota Rationing — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// economy-quota-rations.ts — P2 Quota Rationing
// ═══════════════════════════════════════════════════════════════
// Free tier quotas can be burned in hours if the bot makes too
// many API calls. This module tracks per-provider daily token
// budgets and implements throttling and economy mode to extend
// the bot's operational time.
//
// Features:
//   1. Per-provider daily token budget tracking (stored in DB)
//   2. When provider hits 80% budget: throttle (skip every other request)
//   3. When ALL providers throttled: enter "economy mode"
//      - Reduce screenshot quality (JPEG quality 15)
//      - Skip non-essential modules
//      - Use cheapest available model
//   4. Daily budget reset at midnight UTC
//   5. Per-provider request counting
//   6. Off-peak awareness: track 429 timestamps for rate limit windows
//
// Integration:
//   - cycle-cycle-manager.ts calls shouldThrottle() before tribunal
//   - providers-base.ts calls recordUsage() after each API call
//   - render-free-plan.ts reads isEconomyMode() for screenshot settings
//   - openrouter-rate-limiter.ts handles OR-specific hard limit (50/day)
//
// Note: OpenRouter's hard daily limit (50/day) is enforced by openrouter-rate-limiter.ts.
// This module handles soft throttling (at 80%) for ALL providers including OpenRouter,
// which provides an additional layer of pacing on top of the hard limit.
//
// Config:
//   QUOTA_RATIONS_DAILY_LIMIT_PER_PROVIDER — daily limit (default 100 requests)
//   QUOTA_RATIONS_THROTTLE_PERCENT — throttle threshold (default 80)
//   QUOTA_RATIONS_GLOBAL_ECONOMY_THRESHOLD — providers throttled for economy mode (default 100%)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'quota-rations') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface ProviderUsage {
  provider: string;
  requests: number;
  tokens: number;
  lastRequestTime: number;
  date: string;       // YYYY-MM-DD
  throttled: boolean;
  throttleSince: number | null;
}

// ─── Constants ───
const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_THROTTLE_PERCENT = 80;
const DEFAULT_GLOBAL_ECONOMY_THRESHOLD = 1.0;  // 100% of providers must be throttled

// ─── State ───
const _usage: Map<string, ProviderUsage> = new Map();
let _economyMode = false;
let _economyModeSince: number | null = null;
let _totalRequestsToday = 0;
let _totalThrottledRequests = 0;
let _lastResetDate: string = '';
let _started = false;

// ─── Helpers ───

function _getDailyLimit(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.QUOTA_RATIONS_DAILY_LIMIT_PER_PROVIDER);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_DAILY_LIMIT;
}

function _getThrottlePercent(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.QUOTA_RATIONS_THROTTLE_PERCENT);
  return (val > 0 && val <= 100 && Number.isFinite(val)) ? val : DEFAULT_THROTTLE_PERCENT;
}

function _getGlobalEconomyThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.QUOTA_RATIONS_GLOBAL_ECONOMY_THRESHOLD);
  return (val > 0 && val <= 1 && Number.isFinite(val)) ? val : DEFAULT_GLOBAL_ECONOMY_THRESHOLD;
}

function _getToday(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function _getOrCreateUsage(provider: string): ProviderUsage {
  let usage = _usage.get(provider);
  if (!usage || usage.date !== _getToday()) {
    // Reset for new day
    usage = {
      provider,
      requests: 0,
      tokens: 0,
      lastRequestTime: 0,
      date: _getToday(),
      throttled: false,
      throttleSince: null,
    };
    _usage.set(provider, usage);
  }
  return usage;
}

/**
 * Check if daily budget needs resetting (midnight UTC).
 */
function _checkDailyReset(): void {
  const today = _getToday();
  if (_lastResetDate !== today) {
    _lastResetDate = today;
    _usage.clear();
    _totalRequestsToday = 0;
    _totalThrottledRequests = 0;
    _economyMode = false;
    _economyModeSince = null;
    log(`[QUOTA] Daily budget reset for ${today}`, 'INFO');
  }
}

/**
 * Save usage to DB for persistence across restarts.
 */
function _persistUsage(): void {
  try {
    const db = (_deps as any).database;
    if (!db?.upsertCalibration) return;

    for (const [provider, usage] of _usage) {
      db.upsertCalibration(`quota_${provider}_requests`, String(usage.requests));
      db.upsertCalibration(`quota_${provider}_date`, usage.date);
    }
    db.upsertCalibration('quota_economy_mode', String(_economyMode));
    db.upsertCalibration('quota_total_today', String(_totalRequestsToday));
    db.upsertCalibration('quota_date', _getToday());
  } catch { /* non-critical */ }
}

/**
 * Load usage from DB on startup (for continuity across restarts).
 */
function _loadUsage(): void {
  try {
    const db = (_deps as any).database;
    if (!db?.selectCalibration) return;

    const savedDate = db.selectCalibration('quota_date');
    if (savedDate === _getToday()) {
      // Same day — restore usage counts
      const knownProviders = [
        'groq', 'zai', 'agnes', 'nvidia',
        'cloudflare', 'gemini', 'openrouter',
        // Cerebras removed 2026-08-07 — free tier removed
        // DeepInfra removed 2026-08-06 — free tier removed
      ];

      for (const provider of knownProviders) {
        const reqStr = db.selectCalibration(`quota_${provider}_requests`);
        if (reqStr) {
          const requests = parseInt(reqStr, 10);
          if (requests > 0) {
            const usage = _getOrCreateUsage(provider);
            usage.requests = requests;
            // Check if should be throttled
            const limit = _getDailyLimit();
            const throttleThreshold = limit * (_getThrottlePercent() / 100);
            if (requests >= throttleThreshold) {
              usage.throttled = true;
              usage.throttleSince = Date.now();
            }
          }
        }
      }

      // Restore economy mode
      const economyStr = db.selectCalibration('quota_economy_mode');
      if (economyStr === 'true') {
        _economyMode = true;
        _economyModeSince = Date.now();
      }

      const totalStr = db.selectCalibration('quota_total_today');
      if (totalStr) {
        _totalRequestsToday = parseInt(totalStr, 10);
      }

      log('[QUOTA] Restored usage from DB (same day)', 'INFO');
    }
  } catch { /* non-critical */ }
}

// ─── Core API ───

/**
 * Record a provider API usage event.
 * Call this after each API call in providers-base.ts.
 *
 * @param providerName — The provider that was called
 * @param tokensUsed — Estimated tokens used (optional, default 1 per request)
 */
function recordUsage(providerName: string, tokensUsed?: number): void {
  _checkDailyReset();

  const usage = _getOrCreateUsage(providerName);
  usage.requests++;
  usage.tokens += tokensUsed || 1;
  usage.lastRequestTime = Date.now();
  _totalRequestsToday++;

  const limit = _getDailyLimit();
  const throttleThreshold = limit * (_getThrottlePercent() / 100);

  // Check if provider should be throttled
  if (usage.requests >= throttleThreshold && !usage.throttled) {
    usage.throttled = true;
    usage.throttleSince = Date.now();
    log(
      `[QUOTA] Provider "${providerName}" throttled: ${usage.requests}/${limit} daily requests used (${_getThrottlePercent()}%)`,
      'WARN'
    );
  }

  // Check if ALL providers are throttled → economy mode
  _checkEconomyMode();

  // Persist periodically (every 10 requests)
  if (_totalRequestsToday % 10 === 0) {
    _persistUsage();
  }
}

/**
 * Check if a specific provider should be throttled.
 */
function shouldThrottle(providerName: string): boolean {
  _checkDailyReset();

  const usage = _usage.get(providerName);
  if (!usage) return false;

  // Even requests pass, odd requests are throttled (skip every other)
  if (usage.throttled && usage.requests % 2 === 1) {
    _totalThrottledRequests++;
    return true;
  }

  return false;
}

/**
 * Check if economy mode is active.
 * Economy mode means ALL providers are throttled — reduce all non-essential activity.
 */
function isEconomyMode(): boolean {
  return _economyMode;
}

/**
 * Get the recommended screenshot quality based on economy mode.
 */
function getRecommendedScreenshotQuality(): number {
  return _economyMode ? 15 : 50; // Lower quality in economy mode
}

/**
 * Get daily usage for a specific provider.
 */
function getProviderUsage(providerName: string): {
  requests: number;
  tokens: number;
  limit: number;
  throttleThreshold: number;
  remaining: number;
  throttlePercent: number;
  throttled: boolean;
} | null {
  const usage = _usage.get(providerName);
  if (!usage) return null;

  const limit = _getDailyLimit();
  const throttleThreshold = limit * (_getThrottlePercent() / 100);

  return {
    requests: usage.requests,
    tokens: usage.tokens,
    limit,
    throttleThreshold,
    remaining: Math.max(0, limit - usage.requests),
    throttlePercent: Math.round((usage.requests / limit) * 100),
    throttled: usage.throttled,
  };
}

/**
 * Check if economy mode should be activated/deactivated.
 */
function _checkEconomyMode(): void {
  const providers = [..._usage.values()];
  if (providers.length === 0) return;

  const throttledCount = providers.filter(p => p.throttled).length;
  const throttledRatio = throttledCount / providers.length;
  const threshold = _getGlobalEconomyThreshold();

  if (throttledRatio >= threshold && !_economyMode) {
    _economyMode = true;
    _economyModeSince = Date.now();
    log(
      `[QUOTA] ECONOMY MODE ACTIVATED: ${throttledCount}/${providers.length} providers throttled (${Math.round(throttledRatio * 100)}%)`,
      'WARN'
    );

    // Alert
    try {
      const alerting = (_deps as any).alerting;
      if (alerting?.sendAlert) {
        alerting.sendAlert(
          'Economy Mode Activated',
          `${throttledCount}/${providers.length} providers have hit their daily throttle threshold. ` +
          `Reducing screenshot quality and skipping non-essential modules.`
        );
      }
    } catch { /* non-critical */ }
  } else if (throttledRatio < threshold && _economyMode) {
    _economyMode = false;
    _economyModeSince = null;
    log('[QUOTA] Economy mode deactivated — some providers available.', 'INFO');
  }
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  economyMode: boolean;
  economyModeSince: number | null;
  totalRequestsToday: number;
  totalThrottledRequests: number;
  dailyLimit: number;
  throttlePercent: number;
  providers: Record<string, {
    requests: number;
    tokens: number;
    remaining: number;
    usagePercent: number;
    throttled: boolean;
  }>;
} {
  const providers: Record<string, any> = {};
  const limit = _getDailyLimit();
  for (const [name, usage] of _usage) {
    providers[name] = {
      requests: usage.requests,
      tokens: usage.tokens,
      remaining: Math.max(0, limit - usage.requests),
      usagePercent: Math.round((usage.requests / limit) * 100),
      throttled: usage.throttled,
    };
  }

  return {
    economyMode: _economyMode,
    economyModeSince: _economyModeSince,
    totalRequestsToday: _totalRequestsToday,
    totalThrottledRequests: _totalThrottledRequests,
    dailyLimit: limit,
    throttlePercent: _getThrottlePercent(),
    providers,
  };
}

/**
 * Start the quota rationing system.
 */
function start(): void {
  if (_started) return;
  _started = true;

  _lastResetDate = _getToday();
  _loadUsage();
  _checkEconomyMode();

  log(
    `[QUOTA] Quota rationing started (dailyLimit=${_getDailyLimit()}, throttleAt=${_getThrottlePercent()}%, economyMode=${_economyMode})`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  recordUsage,
  shouldThrottle,
  isEconomyMode,
  getRecommendedScreenshotQuality,
  getProviderUsage,
  getStatus,
  start,
};
