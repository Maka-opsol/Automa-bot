'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Contextual Alert Manager — Proactive NTFY Alerts Based on Bot State
//
// Unlike alerting.ts (which fires on-demand when callers call sendAlert()),
// this module periodically monitors bot state and sends contextual alerts:
//
// Alert triggers:
//   CRITICAL: All providers down for > 10 minutes
//   CRITICAL: Consecutive restarts > 3 in 1 hour
//   CRITICAL: API key expired/revoked (detected by vault)
//   WARN:    OR budget exhausted before 6pm UTC
//   WARN:    /tmp usage > 80%
//   WARN:    WolframAlpha daily limit approaching (>= 18/20)
//   WARN:    Mathpix daily limit approaching (>= 4/5)
//   INFO:    Daily summary at midnight (problems solved, accuracy, budget)
//   INFO:    Work shift transitions (ACTIVE ↔ CONSERVING ↔ REST)
//
// Rate limiting:
//   - Per-trigger dedup: same trigger won't fire again within 30 minutes
//   - Global cap: max 20 alerts per hour
//   - Quiet hours: INFO alerts suppressed outside ACTIVE shift
//
// Integration:
//   - render-free-plan.ts: starts periodic evaluator (120s interval)
//   - services-api-key-vault.ts: calls alertKeyGoneBad() on key validation failure
//   - services-work-shifts.ts: calls alertShiftTransition() on shift change
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

type AlertPriority = 'critical' | 'warn' | 'info';

interface AlertTrigger {
  id: string;
  lastFiredAt: number;
  cooldownMs: number;
}

// ─── Dependencies ───────────────────────────────────────────────────────────

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

// ─── State ──────────────────────────────────────────────────────────────────

const _triggers: Map<string, AlertTrigger> = new Map();
let _globalAlertCount = 0;
let _globalResetTime = Date.now();
let _evalInterval: ReturnType<typeof setInterval> | null = null;
const GLOBAL_MAX_PER_HOUR = 20;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per trigger

// NTFY priority mapping: critical=5, warn=4, info=3
const NTFY_PRIORITY_MAP: Record<AlertPriority, number> = {
  critical: 5,
  warn: 4,
  info: 3,
};

// ─── Core Send ───────────────────────────────────────────────────────────────

function _canFire(triggerId: string, cooldownMs?: number): boolean {
  const now = Date.now();

  // Global cap
  if (now - _globalResetTime > 3600000) {
    _globalAlertCount = 0;
    _globalResetTime = now;
  }
  if (_globalAlertCount >= GLOBAL_MAX_PER_HOUR) {
    log(`Contextual alert suppressed (global cap ${GLOBAL_MAX_PER_HOUR}/hr): ${triggerId}`, 'DEBUG', 'contextual-alerts');
    return false;
  }

  // Per-trigger dedup
  const trigger = _triggers.get(triggerId);
  if (trigger && (now - trigger.lastFiredAt) < (cooldownMs || trigger.cooldownMs)) {
    return false;
  }

  return true;
}

function _markFired(triggerId: string, cooldownMs?: number): void {
  const now = Date.now();
  _globalAlertCount++;
  _triggers.set(triggerId, {
    id: triggerId,
    lastFiredAt: now,
    cooldownMs: cooldownMs || DEFAULT_COOLDOWN_MS,
  });
}

async function _sendNtfy(text: string, priority: AlertPriority, title?: string): Promise<boolean> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;

  const fetch: any = globalThis.fetch;
  if (!fetch) return false;

  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Title': title || `MathU Bot [${priority.toUpperCase()}]`,
        'Priority': String(NTFY_PRIORITY_MAP[priority]),
        'Tags': priority === 'critical' ? 'rotating_light' : priority === 'warn' ? 'warning' : 'bell',
        'Click': 'https://mathu-bot.onrender.com/api/health/heartbeat',
      },
      body: text,
    });
    return true;
  } catch (e: any) {
    logError('Contextual NTFY send failed', e);
    return false;
  }
}

async function sendContextualAlert(triggerId: string, text: string, priority: AlertPriority, cooldownMs?: number): Promise<void> {
  if (!_canFire(triggerId, cooldownMs)) return;
  _markFired(triggerId, cooldownMs);
  log(`Contextual alert [${triggerId}]: ${text}`, priority === 'critical' ? 'ERROR' : 'WARN', 'contextual-alerts');
  await _sendNtfy(text, priority);
}

// ─── External Alert Hooks ───────────────────────────────────────────────────

// Called by vault when a key flips valid → invalid
async function alertKeyGoneBad(serviceName: string, error: string): Promise<void> {
  await sendContextualAlert(
    `key_bad_${serviceName}`,
    `API key gone bad: ${serviceName}\nError: ${error}\nTime: ${new Date().toISOString()}`,
    'critical',
    60 * 60 * 1000 // 1 hour cooldown (key issues are persistent)
  );
}

// Called by work shifts on transition
async function alertShiftTransition(from: string, to: string, reason: string): Promise<void> {
  // Only alert on non-trivial transitions (skip ACTIVE→CONSERVING and back)
  if (from === 'ACTIVE' && to === 'CONSERVING') return;
  if (from === 'CONSERVING' && to === 'ACTIVE') return;

  const priority: AlertPriority = to === 'RECOVERY' ? 'warn' : 'info';
  await sendContextualAlert(
    `shift_${from}_to_${to}`,
    `Work shift: ${from} → ${to}\nReason: ${reason}\nTime: ${new Date().toISOString()}`,
    priority,
    15 * 60 * 1000 // 15 min cooldown for shift transitions
  );
}

// ─── Periodic Evaluator ─────────────────────────────────────────────────────

async function evaluateTriggers(): Promise<void> {
  try {
    await checkProvidersDown();
    await checkConsecutiveRestarts();
    await checkOrBudgetExhausted();
    await checkTmpUsage();
    await checkWolframLimit();
    await checkMathpixLimit();
  } catch (e: any) {
    logError('Contextual alert eval error', e);
  }
}

async function checkProvidersDown(): Promise<void> {
  try {
    const registry = require('./providers-registry');
    const count = registry.getAvailableProviderCount?.() ?? 999;
    if (count > 0) {
      // Reset trigger if providers are back
      _triggers.delete('providers_down');
      return;
    }

    const trigger = _triggers.get('providers_down');
    const downSince = trigger?.lastFiredAt || Date.now();
    const downForMin = (Date.now() - downSince) / 60000;

    // Only alert after 10 minutes of continuous downtime
    if (downForMin >= 10) {
      await sendContextualAlert(
        'providers_down',
        `ALL PROVIDERS DOWN for ${downForMin.toFixed(0)} minutes\nNo AI providers available — bot cannot solve problems\nTime: ${new Date().toISOString()}`,
        'critical',
        60 * 60 * 1000 // Re-alert every hour
      );
    } else {
      // First detection — mark time but don't alert yet
      if (!trigger) {
        _triggers.set('providers_down', { id: 'providers_down', lastFiredAt: Date.now(), cooldownMs: DEFAULT_COOLDOWN_MS });
        log('All providers down detected — starting 10-min timer before alert', 'WARN', 'contextual-alerts');
      }
    }
  } catch { /* non-critical */ }
}

async function checkConsecutiveRestarts(): Promise<void> {
  try {
    const watchdog = require('./longevity-self-ping');
    const health = watchdog.getHealth?.();
    if (!health) return;

    if (health.totalRestarts >= 3) {
      await sendContextualAlert(
        'consecutive_restarts',
        `High restart count: ${health.totalRestarts} restarts\nHealth level: ${health.level}\nTime: ${new Date().toISOString()}`,
        'critical',
        30 * 60 * 1000
      );
    }
  } catch { /* non-critical */ }
}

async function checkOrBudgetExhausted(): Promise<void> {
  try {
    const limiter = require('./openrouter-rate-limiter');
    const pct = limiter.getBudgetPct?.() ?? 100;
    if (pct <= 0) {
      // Check if before 6pm UTC
      const utcHour = new Date().getUTCHours();
      if (utcHour < 18) {
        await sendContextualAlert(
          'or_budget_exhausted_early',
          `OpenRouter budget exhausted at ${utcHour}:00 UTC (before 6pm)\nBudget remaining: ${pct}%\nTime: ${new Date().toISOString()}`,
          'warn',
          60 * 60 * 1000
        );
      }
    }
  } catch { /* non-critical */ }
}

async function checkTmpUsage(): Promise<void> {
  try {
    const guardian = _deps.tmpGuardian;
    if (!guardian?.getStatus) return;
    const status = guardian.getStatus();
    const pct = (status.usagePct || 0) * 100;

    if (pct >= 80) {
      await sendContextualAlert(
        'tmp_usage_high',
        `/tmp usage at ${pct.toFixed(0)}%\nUsed: ${status.usedMB?.toFixed(0) || '?'}MB / ${status.totalMB?.toFixed(0) || '?'}MB\nGuardian may prune files\nTime: ${new Date().toISOString()}`,
        'warn',
        30 * 60 * 1000
      );
    }
  } catch { /* non-critical */ }
}

async function checkWolframLimit(): Promise<void> {
  try {
    // Check via DB calibration
    const db = _deps.database;
    if (!db?.getCalibration) return;
    const used = parseInt(db.getCalibration('wolfram_daily_count') || '0', 10);
    const limit = parseInt(db.getCalibration('wolfram_daily_limit') || '20', 10);

    if (used >= limit - 2 && used < limit) {
      await sendContextualAlert(
        'wolfram_limit_approaching',
        `WolframAlpha daily limit approaching: ${used}/${limit} used\n${limit - used} calls remaining today\nTime: ${new Date().toISOString()}`,
        'warn',
        60 * 60 * 1000
      );
    }
  } catch { /* non-critical */ }
}

async function checkMathpixLimit(): Promise<void> {
  try {
    const db = _deps.database;
    if (!db?.getCalibration) return;
    const used = parseInt(db.getCalibration('mathpix_daily_count') || '0', 10);
    const limit = parseInt(db.getCalibration('mathpix_daily_limit') || '5', 10);

    if (limit > 0 && used >= limit - 1 && used < limit) {
      await sendContextualAlert(
        'mathpix_limit_approaching',
        `Mathpix daily limit approaching: ${used}/${limit} used\n${limit - used} call remaining today\nTime: ${new Date().toISOString()}`,
        'warn',
        60 * 60 * 1000
      );
    }
  } catch { /* non-critical */ }
}

// ─── Daily Summary ──────────────────────────────────────────────────────────

async function sendDailySummary(): Promise<void> {
  try {
    const db = _deps.database;
    let questionsToday = 0;
    let accuracy = 0;
    let budgetUsed = 0;

    if (db?.getCalibration) {
      questionsToday = parseInt(db.getCalibration('questions_completed_today') || '0', 10);
      accuracy = parseFloat(db.getCalibration('math_verify_pass_rate') || '0') * 100;
      const limiter = require('./openrouter-rate-limiter');
      budgetUsed = 100 - (limiter.getBudgetPct?.() ?? 0);
    }

    const text = [
      `MathU Bot — Daily Summary`,
      `Questions solved: ${questionsToday}`,
      `Math accuracy: ${accuracy.toFixed(0)}%`,
      `OR budget used: ${budgetUsed.toFixed(0)}%`,
      `Uptime: ${Math.round(process.uptime() / 3600)}h`,
      `Date: ${new Date().toISOString().split('T')[0]}`,
    ].join('\n');

    await _sendNtfy(text, 'info', 'MathU Bot — Daily Summary');
    log('Daily summary sent', 'INFO', 'contextual-alerts');
  } catch (e: any) {
    logError('Daily summary failed', e);
  }
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

function start(intervalMs: number = 120000): void {
  if (_evalInterval) clearInterval(_evalInterval);

  log(`Contextual alert manager started (eval every ${intervalMs / 1000}s)`, 'INFO', 'contextual-alerts');

  _evalInterval = setInterval(() => {
    evaluateTriggers().catch(() => {});
  }, intervalMs);

  // Schedule daily summary at midnight SAST
  const tz = process.env.TZ || 'Africa/Johannesburg';
  const scheduleMidnightSummary = () => {
    const now = new Date();
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    localNow.setHours(24, 0, 30, 0); // 00:00:30 tomorrow (30s after midnight)
    const utcTarget = new Date(localNow.toLocaleString('en-US', { timeZone: 'UTC' }));
    const msUntilMidnight = utcTarget.getTime() - now.getTime();
    setTimeout(() => {
      sendDailySummary().catch(() => {});
      scheduleMidnightSummary();
    }, Math.max(msUntilMidnight, 1000));
  };
  scheduleMidnightSummary();
}

function stop(): void {
  if (_evalInterval) {
    clearInterval(_evalInterval);
    _evalInterval = null;
  }
}

module.exports = {
  _injectDependencies,
  start,
  stop,
  evaluateTriggers,
  sendContextualAlert,
  alertKeyGoneBad,
  alertShiftTransition,
  sendDailySummary,
};
