'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Heartbeat Endpoint — UptimeRobot-Compatible Health Check
//
// GET /api/health/heartbeat — returns a rich JSON status object designed for
// external monitoring services (UptimeRobot, BetterStack, etc.)
//
// Returns 200 always (with status field inside JSON) so monitoring services
// can inspect the status field via JSON body checks. Only returns non-200
// if the bot process itself is completely dead (connection refused).
//
// Integration:
//   - render-free-plan.ts: mounted as HTTP route
//   - services-api-key-vault.ts: provides apiKeys section
//   - UptimeRobot free tier: 50 monitors, 5-min intervals
// ═══════════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }

// ─── Types ───────────────────────────────────────────────────────────────────

interface HeartbeatResponse {
  status: 'healthy' | 'degraded' | 'critical' | 'dormant';
  timestamp: string;
  uptime: number;
  providersAvailable: number;
  orBudgetRemaining: number;
  degradationLevel: number;
  degradationName: string;
  workShift: string;
  lastProblemSolved: string | null;
  consecutiveRestarts: number;
  heapUsedMB: number;
  heapTotalMB: number;
  tmpUsagePct: number | null;
  apiKeys: Record<string, { valid: boolean; lastChecked: string; error?: string }> | null;
  botVersion: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

async function getHeartbeat(): Promise<HeartbeatResponse> {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);

  // Provider count
  let providersAvailable = 0;
  try {
    const registry = require('./providers-registry');
    providersAvailable = registry.getAvailableProviderCount?.() ?? 0;
  } catch { /* non-critical */ }

  // OR budget remaining
  let orBudgetRemaining = 0;
  try {
    const limiter = require('./openrouter-rate-limiter');
    orBudgetRemaining = limiter.getBudgetPct?.() ?? 0;
  } catch { /* non-critical */ }

  // Degradation level
  let degradationLevel = 0;
  let degradationName = 'FULL';
  try {
    const ladder = require('./self-heal-degradation-ladder');
    const calc = ladder.getLastCalculation?.();
    if (calc) {
      degradationLevel = calc.level;
      degradationName = calc.name;
    }
  } catch { /* non-critical */ }

  // Work shift
  let workShift = 'ACTIVE';
  try {
    const ws = require('./services-work-shifts');
    const shift = ws.getShift();
    workShift = shift.current;
  } catch { /* non-critical */ }

  // Last problem solved
  let lastProblemSolved: string | null = null;
  try {
    const db = _deps.database;
    if (db?.getCalibration) {
      const ts = db.getCalibration('last_question_completed_at');
      if (ts) lastProblemSolved = new Date(parseInt(ts, 10)).toISOString();
    }
  } catch { /* non-critical */ }

  // Consecutive restarts
  let consecutiveRestarts = 0;
  try {
    const watchdog = require('./longevity-self-ping');
    const health = watchdog.getHealth?.();
    if (health) consecutiveRestarts = health.totalRestarts || 0;
  } catch { /* non-critical */ }

  // /tmp usage
  let tmpUsagePct: number | null = null;
  try {
    const guardian = _deps.tmpGuardian;
    if (guardian?.getStatus) {
      const status = guardian.getStatus();
      tmpUsagePct = Math.round((status.usagePct || 0) * 100);
    }
  } catch { /* non-critical */ }

  // API key health (from vault)
  let apiKeys: HeartbeatResponse['apiKeys'] = null;
  try {
    const vault = require('./services-api-key-vault');
    apiKeys = vault.getKeyHealthSummary?.() ?? null;
  } catch { /* non-critical */ }

  // Determine overall status
  let status: HeartbeatResponse['status'] = 'healthy';
  if (degradationLevel >= 4 || providersAvailable === 0) {
    status = 'dormant';
  } else if (degradationLevel >= 3 || heapUsedMB > 450 || consecutiveRestarts >= 3) {
    status = 'critical';
  } else if (degradationLevel >= 2 || orBudgetRemaining < 20 || workShift === 'RECOVERY') {
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    providersAvailable,
    orBudgetRemaining,
    degradationLevel,
    degradationName,
    workShift,
    lastProblemSolved,
    consecutiveRestarts,
    heapUsedMB,
    heapTotalMB,
    tmpUsagePct,
    apiKeys,
    botVersion: 'v6.8',
  };
}

module.exports = {
  _injectDependencies,
  getHeartbeat,
};
