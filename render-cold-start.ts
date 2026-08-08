'use strict';
// Last modified: 2026-08-08 — Response 6: Render cold start detection

// ═══════════════════════════════════════════════════════════════════════════════
// Render Cold Start Detection — Detects spin-down and provides fast recovery.
//
// On Render free tier, the service spins down after 15 minutes of inactivity.
// When it wakes up (cold start), we want to:
//   1. Detect it happened (gap in /tmp/render-last-seen.json timestamp)
//   2. Use a fast startup path (skip non-essential modules)
//   3. Resume from last known state in DB (which question, which module)
//
// Fast startup path:
//   Initialize ONLY: config → database → browser → providers → auth
//   Skip: diary worker, model evolution, meta-learner, anomaly detector,
//         canary tests, exploration cartographer
//
// Warm startup path (normal restart):
//   Full initialization — everything loads, boot validation smoke tests run.
//
// Spin-down preparation:
//   Write /tmp/render-last-seen.json with timestamp before inactivity.
//   This file persists across spin-downs (same /tmp volume).
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

// ─── Configuration ──────────────────────────────────────────────────────────

const LAST_SEEN_FILE = process.env.RENDER_LAST_SEEN_FILE || path.join(os.tmpdir(), 'render-last-seen.json');
const COLD_START_THRESHOLD_MS = parseInt(process.env.COLD_START_THRESHOLD_MS || '1200000', 10); // 20 minutes
const DEFINITE_COLD_START_MS = parseInt(process.env.DEFINITE_COLD_START_MS || '3600000', 10);  // 1 hour

// ─── State ──────────────────────────────────────────────────────────────────

interface ColdStartInfo {
  isColdStart: boolean;
  isDefiniteColdStart: boolean;
  gapMs: number;           // time since last-seen timestamp
  lastSeenAt: number | null; // epoch ms of last write
  currentStartAt: number;    // epoch ms of this startup
  startupType: 'cold' | 'warm' | 'fresh';
  reason: string;
}

let _coldStartInfo: ColdStartInfo | null = null;
let _lastSeenTimer: ReturnType<typeof setInterval> | null = null;

// ─── Protected Files for Spin-Down ───────────────────────────────────────────
// These files are written to /tmp before spin-down and survive across cold starts.

const SPIN_DOWN_FILES = [
  'openrouter-rate-limit.json',  // OR rate limiter state
  'mathpix-rate-limit.json',    // Mathpix rate limiter state
  'checkpoint.json',            // Cycle progress checkpoint
  'last-state.json',             // Last known state machine state
];

// ═══════════════════════════════════════════════════════════════════════════
// Cold Start Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect if this is a cold start by checking the gap in render-last-seen.json.
 * Called once at startup.
 */
function detectColdStart(): ColdStartInfo {
  const currentStartAt = Date.now();
  let lastSeenAt: number | null = null;

  try {
    if (fs.existsSync(LAST_SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_SEEN_FILE, 'utf8'));
      if (data && data.timestamp) {
        lastSeenAt = data.timestamp;
      }
    }
  } catch { /* file doesn't exist or is corrupt — that's fine, it's a fresh start */ }

  const gapMs = lastSeenAt ? (currentStartAt - lastSeenAt) : 0;

  let isColdStart = false;
  let isDefiniteColdStart = false;
  let startupType: 'cold' | 'warm' | 'fresh';
  let reason: string;

  if (lastSeenAt === null) {
    // No last-seen file — this is a fresh deploy or first run
    startupType = 'fresh';
    reason = 'No render-last-seen.json found — fresh deploy or first run';
  } else if (gapMs >= DEFINITE_COLD_START_MS) {
    // Gap > 1 hour — definitely a cold start (Render max spin-down is ~15min,
    // but multiple spin-downs or manual sleep could extend this)
    isColdStart = true;
    isDefiniteColdStart = true;
    startupType = 'cold';
    reason = `Definite cold start: ${Math.round(gapMs / 60000)}min gap since last seen`;
  } else if (gapMs >= COLD_START_THRESHOLD_MS) {
    // Gap > 20 min — likely a cold start
    isColdStart = true;
    startupType = 'cold';
    reason = `Likely cold start: ${Math.round(gapMs / 60000)}min gap since last seen`;
  } else {
    // Gap < 20 min — normal restart or quick recovery
    startupType = 'warm';
    reason = `Warm restart: ${Math.round(gapMs / 1000)}s since last seen`;
  }

  _coldStartInfo = {
    isColdStart,
    isDefiniteColdStart,
    gapMs,
    lastSeenAt,
    currentStartAt,
    startupType,
    reason,
  };

  // Log at appropriate level
  if (startupType === 'cold') {
    log(`Cold start detected: ${reason}`, 'WARN', 'cold-start');
  } else if (startupType === 'fresh') {
    log(`Fresh start: ${reason}`, 'INFO', 'cold-start');
  } else {
    log(`Warm restart: ${reason}`, 'INFO', 'cold-start');
  }

  // Write the new timestamp immediately
  _writeLastSeen(currentStartAt);

  return _coldStartInfo;
}

/**
 * Get the cold start info from the most recent detection.
 */
function getColdStartInfo(): ColdStartInfo | null {
  return _coldStartInfo;
}

/**
 * Returns true if this startup was detected as a cold start.
 */
function isColdStart(): boolean {
  return _coldStartInfo?.isColdStart || false;
}

/**
 * Returns the startup type: 'cold', 'warm', or 'fresh'.
 */
function getStartupType(): 'cold' | 'warm' | 'fresh' {
  return _coldStartInfo?.startupType || 'fresh';
}

// ═══════════════════════════════════════════════════════════════════════════
// Last-Seen Timestamp Management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write the current timestamp to render-last-seen.json.
 * This is called periodically and before shutdown to maintain the heartbeat.
 */
function _writeLastSeen(timestamp?: number) {
  try {
    const data = JSON.stringify({
      timestamp: timestamp || Date.now(),
      pid: process.pid,
    });
    fs.writeFileSync(LAST_SEEN_FILE, data, 'utf8');
  } catch (e: any) {
    logError('Failed to write render-last-seen.json', e);
  }
}

/**
 * Start periodic last-seen updates (every 2 minutes).
 * This keeps the timestamp fresh so we can detect gaps.
 */
function startLastSeenUpdates() {
  if (_lastSeenTimer) return;

  _lastSeenTimer = setInterval(() => {
    _writeLastSeen();
  }, 120000); // Every 2 minutes

  if (_lastSeenTimer.unref) _lastSeenTimer.unref();

  log('Cold start: periodic last-seen updates started (every 2min)', 'DEBUG', 'cold-start');
}

function stopLastSeenUpdates() {
  if (_lastSeenTimer) {
    clearInterval(_lastSeenTimer);
    _lastSeenTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Spin-Down Preparation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prepare for an imminent spin-down.
 * Called when we detect inactivity (e.g., no providers, budget exhausted).
 * Saves state to /tmp so it survives across cold starts.
 */
function prepareForSpinDown() {
  // 1. Write final last-seen timestamp
  _writeLastSeen();

  // 2. Verify critical state files exist in /tmp
  const tmpDir = os.tmpdir();
  let preserved = 0;

  for (const filename of SPIN_DOWN_FILES) {
    const filePath = path.join(tmpDir, filename);
    try {
      if (fs.existsSync(filePath)) {
        preserved++;
      }
    } catch { /* skip */ }
  }

  log(`Spin-down preparation complete (${preserved}/${SPIN_DOWN_FILES.length} state files preserved in /tmp)`, 'INFO', 'cold-start');
}

// ═══════════════════════════════════════════════════════════════════════════
// Fast Startup Path Decisions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the list of modules that should be SKIPPED during cold start.
 * These are non-essential modules that can be loaded lazily later.
 */
function getSkippableModules(): string[] {
  if (!_coldStartInfo?.isColdStart) return [];

  return [
    'self-documenting-diary',     // Diary logging — not needed immediately
    'meta-learner-reflection',    // Meta-learning — can catch up later
    'provider-quota-bargain',     // Bargain hunting — deferred to warm period
    'model-evolution',           // Model evolution — heavy, not needed at startup
    'exploration-cartographer',   // UI exploration — can wait
    'anomaly-detector',          // Anomaly detection — not critical for startup
  ];
}

/**
 * Check if a specific module should be skipped during this startup.
 */
function shouldSkipModule(moduleName: string): boolean {
  const skippable = getSkippableModules();
  return skippable.includes(moduleName);
}

// ═══════════════════════════════════════════════════════════════════════════
// Status / Query
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get status for dashboard/monitoring.
 */
function getStatus(): {
  startupType: string;
  isColdStart: boolean;
  gapMinutes: number;
  lastSeenAt: string | null;
  currentStartAt: string;
  lastSeenFileExists: boolean;
} {
  return {
    startupType: _coldStartInfo?.startupType || 'unknown',
    isColdStart: _coldStartInfo?.isColdStart || false,
    gapMinutes: _coldStartInfo ? Math.round(_coldStartInfo.gapMs / 60000) : 0,
    lastSeenAt: _coldStartInfo?.lastSeenAt ? new Date(_coldStartInfo.lastSeenAt).toISOString() : null,
    currentStartAt: new Date(_coldStartInfo?.currentStartAt || Date.now()).toISOString(),
    lastSeenFileExists: fs.existsSync(LAST_SEEN_FILE),
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  detectColdStart();
  log('Cold start detector initialized', 'INFO', 'cold-start');
}

module.exports = {
  // Core API
  detectColdStart,
  getColdStartInfo,
  isColdStart,
  getStartupType,

  // Spin-down preparation
  prepareForSpinDown,

  // Startup path
  getSkippableModules,
  shouldSkipModule,

  // Last-seen management
  startLastSeenUpdates,
  stopLastSeenUpdates,

  // Query
  getStatus,

  // DI
  _injectDependencies,
};
