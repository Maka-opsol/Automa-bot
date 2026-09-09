'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Dashboard Server — Connected to render-free-plan.ts via container
// ═══════════════════════════════════════════════════════════════════════
// This module provides the full dashboard UI and all management API
// endpoints. It exports handleDashboardRequest() for mounting into
// an existing HTTP server (render-free-plan.ts), and also exports
// createDashboardServer() / startDashboard() for standalone use.
//
// Dependencies come from the container module (same as render-free-plan.ts).
// ═══════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');
const crypto = require('crypto');
const { container } = require('./container');
const persistConfig = require('./persistent-config');

// ── Resolve logger from container (with fallback) ──
function getLog() {
  try { return container.get('logger'); } catch { return require('./logger'); }
}

/**
 * DI injection hook — called by container-modules.ts during initialization.
 * This module resolves deps lazily via container.get(), so this is a no-op.
 */
function _injectDependencies(_deps: any) {
  // No-op: dashboard resolves its dependencies lazily via container.get()
}

// ── In-memory log ring buffer ──
// Captures logs from this module and from hooked pino instances
// Reduced from 500 to 200 for memory savings on Render free plan
const _logRingBuffer: string[] = [];
const _LOG_RING_MAX = 200;
function _pushLogRing(entry: string) {
  if (_logRingBuffer.length >= _LOG_RING_MAX) _logRingBuffer.shift();
  _logRingBuffer.push(entry);
}

// Try to hook into the pino logger to capture ALL logs to the ring buffer
try {
  const _loggerMod = require('./logger');
  const _origLog = _loggerMod.log;
  const _origLogError = _loggerMod.logError;
  const _origSafeLog = _loggerMod.safeLog;
  if (typeof _origLog === 'function') {
    _loggerMod.log = (...args: any[]) => {
      try {
        const ts = new Date().toISOString();
        const msg = args.map((a: any) => typeof a === 'object' && a !== null ? a.msg || JSON.stringify(a) : String(a)).join(' ');
        const lvl = (args[1] === 'ERROR' || args[1] === 'error') ? 'ERROR' : 'INFO';
        _pushLogRing(`[${ts}] [${lvl}] ${msg}`);
      } catch { /* non-critical */ }
      return _origLog(...args);
    };
  }
  if (typeof _origLogError === 'function') {
    _loggerMod.logError = (...args: any[]) => {
      try {
        const ts = new Date().toISOString();
        const msg = args.map((a: any) => typeof a === 'object' && a !== null ? a.msg || JSON.stringify(a) : String(a)).join(' ');
        _pushLogRing(`[${ts}] [ERROR] ${msg}`);
      } catch { /* non-critical */ }
      return _origLogError(...args);
    };
  }
  if (typeof _origSafeLog === 'function') {
    _loggerMod.safeLog = (...args: any[]) => {
      try {
        const ts = new Date().toISOString();
        let serialized: string;
        try { serialized = JSON.stringify(args[0] || args); } catch { serialized = String(args[0] || args); }
        _pushLogRing(`[${ts}] ${serialized}`);
      } catch { /* non-critical */ }
      return _origSafeLog(...args);
    };
  }
} catch { /* logger module not available — ring buffer stays empty */ }

const log    = (...args: any[]) => getLog().log(...args);
const logErr = (...args: any[]) => getLog().logError(...args);

function getCONFIG(): Record<string, any> {
  try { return container.get('config'); } catch { return require('./get-config'); }
}

// ── Resolve dependencies from container ──
function getProviderStats() {
  try { return container.get('providersStats')?.getStats; } catch { return undefined; }
}
function getStateDiagnostics() {
  try { return container.get('stateMachine')?.getStateDiagnostics; } catch { return undefined; }
}
function getCacheStats() {
  try { return container.get('cache')?.getCacheStats; } catch { return undefined; }
}
function getDatabaseStats() {
  try { return container.get('database')?.getDatabaseStats; } catch { return undefined; }
}
function getFailsafeDiagnostics() {
  try { return container.get('failsafeCoordinator')?.getDiagnostics; } catch { return undefined; }
}
function getBrowserMetrics() {
  try { return container.get('browser')?.getBrowserMetrics; } catch { return undefined; }
}
function getGenerateToken() {
  try { return container.get('jwt')?.generateToken; } catch { return undefined; }
}
function getRequireAuth() {
  try { return container.get('jwt')?.requireAuth; } catch { return undefined; }
}

function _timingSafeEqual(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

const DASHBOARD_DIR = path.join(PROJECT_ROOT, 'public');
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// ── Executive Privileges ──────────────────────────────────────────
// Runtime flag: activated by providing the correct EXECUTIVE_KEY.
// More executive privileges can be added to this object later.
// The EXECUTIVE_KEY env var stores the secret; it must be INPUT to activate.
let _executivePrivilegesActive = false;
let _executiveActivatedAt: number | null = null;

function isExecutivePrivilegesActive(): boolean {
  return _executivePrivilegesActive;
}

function activateExecutivePrivileges(providedKey: string): boolean {
  const storedKey = process.env.EXECUTIVE_KEY || '';
  if (!storedKey) return false;
  if (!_timingSafeEqual(providedKey, storedKey)) return false;
  _executivePrivilegesActive = true;
  _executiveActivatedAt = Date.now();
  return true;
}

function deactivateExecutivePrivileges(): void {
  _executivePrivilegesActive = false;
  _executiveActivatedAt = null;
}

// ── Auto-capture throttle (max once per 30s) ──
let _lastAutoCaptureTs = 0;
const AUTO_CAPTURE_INTERVAL_MS = 30 * 1000;

// ── Screenshot cache (shared with render-free-plan.ts via globals) ──
// render-free-plan.ts sets (globalThis).__setLatestScreenshot and
// (globalThis).__getLatestScreenshot FIRST (it starts before us).
// We set them here as fallback for standalone use, but at runtime we
// ALWAYS delegate to the globals so we read from the same cache the
// cycle manager writes to.

let _standaloneScreenshot: { screenshot: string; timestamp: number; action?: any } | null = null;

function setLatestScreenshot(base64Jpeg: string, action?: any) {
  if (base64Jpeg.length > 500_000) return;
  _standaloneScreenshot = { screenshot: base64Jpeg, timestamp: Date.now(), action };
}

function getLatestScreenshot(): { screenshot: string; timestamp: number; action?: any } | null {
  // Always prefer the global (render-free-plan.ts cache), which is what
  // the cycle manager writes to. Fall back to local only in standalone.
  const globalGet = (globalThis as any).__getLatestScreenshot;
  if (globalGet) return globalGet();
  if (_standaloneScreenshot && Date.now() - _standaloneScreenshot.timestamp > 30 * 60 * 1000) {
    _standaloneScreenshot = null;
  }
  return _standaloneScreenshot;
}

// Expose globally so cycle manager can call it (same globals as render-free-plan)
if (!(globalThis as any).__setLatestScreenshot) (globalThis as any).__setLatestScreenshot = setLatestScreenshot;
if (!(globalThis as any).__getLatestScreenshot) (globalThis as any).__getLatestScreenshot = getLatestScreenshot;

// ── Helper: read JSON body from request ──
function readBody(req: any, res: any, cb: (body: string) => void) {
  let body = '';
  const MAX = 1 * 1024 * 1024;
  let tooLarge = false;
  req.on('data', (chunk: any) => {
    if (body.length > MAX) {
      if (!tooLarge) { tooLarge = true; res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"Body too large"}'); req.destroy(); }
      return;
    }
    body += chunk;
  });
  req.on('end', () => { if (!tooLarge) cb(body); });
}

// ── Helper: JSON response ──
function jsonRes(res: any, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Helper: format uptime ──
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Helper: get all known states from state-machine ──
function getAllStates(): string[] {
  try {
    const sm = require('./state-machine');
    return Object.values(sm.STATES || {});
  } catch { return []; }
}

function getAllActions(): string[] {
  try {
    const sm = require('./state-machine');
    return Object.keys(sm.ACTIONS || {});
  } catch { return []; }
}

// ── Helper: capture a live screenshot right now ──
async function captureLiveScreenshot(): Promise<string | null> {
  try {
    const browserMod = require('./browser');
    const page = browserMod.browserManager?.getPage?.() || browserMod.browserManager?.pageInstance;
    if (!page || page.isClosed()) return null;
    const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
    let base64 = buf.toString('base64');
    // Try sharp compression first (much smaller)
    try {
      const compressed = await browserMod.compressScreenshot?.(base64, 800, 30);
      if (compressed && compressed.length < 500_000) return compressed;
    } catch { /* sharp not available */ }
    // Raw JPEG — if too large, skip rather than truncate (truncated base64 = corrupted image)
    if (base64.length > 500_000) {
      log(`Live screenshot too large (${Math.round(base64.length / 1024)}KB), skipping`, 'WARN', 'dashboard');
      return null;
    }
    return base64;
  } catch (e: any) {
    log(`Live screenshot capture failed: ${e.message}`, 'WARN', 'dashboard');
    return null;
  }
}

// ── Helper: get stop state ──
function getDaemonState(): { running: boolean; stopRequested: boolean } {
  try {
    const orch = require('./cycle-orchestrator');
    return {
      running: !!orch.startDaemon,
      stopRequested: !!orch._stopRequested,
    };
  } catch { return { running: false, stopRequested: false }; }
}

// ── Helper: get available config keys that can be changed from dashboard ──
// Expanded set — all keys from config.ts override schema plus useful operational keys.
// Secrets, paths, and security-critical flags are excluded.
const SAFE_CONFIG_KEYS = new Set([
  // Timing / scheduling
  'SLEEP_MIN_HOURS', 'SLEEP_MAX_HOURS', 'MAX_CYCLES_BEFORE_RESTART',
  'MAX_CONSECUTIVE_FAILURES', 'MAX_QUESTIONS', 'CHECK_INTERVAL_HOURS',
  'MAX_UPTIME_HOURS', 'MAX_RUNTIME_PER_CYCLE_MS', 'STARTUP_DELAY_MIN_MINUTES',
  'STARTUP_DELAY_MAX_MINUTES', 'ALLOWED_ACTIVITY_START_HOUR', 'ALLOWED_ACTIVITY_END_HOUR',
  // Browser / interaction
  'POST_CLICK_MS', 'BETWEEN_STEPS_MS', 'SCROLL_AMOUNT', 'SCROLL_PAUSE_MS',
  'VIDEO_SPEED', 'VIDEO_TIMEOUT_MS', 'WAIT_MULTIPLIER',
  'BROWSER_LAUNCH_TIMEOUT_MS', 'BROWSER_PAGE_TIMEOUT_MS',
  'MAX_CONSECUTIVE_SAME_ACTION', 'SCROLL_NO_CHANGE_THRESHOLD',
  'SWIPE_DURATION_MS', 'LONG_PRESS_DELAY_MS',
  // Memory / GC
  'ENABLE_GC_ON_CYCLE', 'MAX_MEMORY_MB', 'MEMORY_WARNING_THRESHOLD_MB', 'MEMORY_RESTART_THRESHOLD_MB',
  // Alerts
  'ALERT_ON_ERROR', 'ALERT_ON_STAGNATION', 'ALERT_ON_AUTH_FAILURE',
  // Providers / vision
  'VISION_PRIORITY', 'PROVIDER_ORDER', 'OPENROUTER_TRIBUNAL_MODEL',
  // Self-heal subsystems (toggleable)
  'PREDICTIVE_HEAL_ENABLED', 'SELECTOR_DRIFT_HEAL_ENABLED', 'REGRESSION_BANK_ENABLED',
  'CANARY_ROLLOUT_ENABLED', 'CANARY_OBSERVATION_HOURS',
  'DIFF_MINIMIZER_ENABLED', 'PROMPT_EVOLUTION_ENABLED', 'PROMPT_EVOLUTION_MIN_ENTRIES',
  'DB_HEALER_ENABLED', 'AUTH_HEALER_ENABLED', 'STATE_RECOVERY_ENABLED',
  'DEPENDENCY_HEALER_ENABLED', 'CONFIG_RECONCILER_ENABLED',
  'EXTENDED_CHECKPOINT_ENABLED', 'BLACKBOX_FULL_ENABLED',
  'PATCH_MEMORY_ENABLED', 'HEAL_REWARD_TRACKER_ENABLED', 'SELF_HEAL_TIMELINE_ENABLED',
  'HEALER_CIRCUIT_BREAKER_ENABLED', 'DEGRADATION_LADDER_ENABLED',
  'ENABLE_BLACKBOX', 'ENABLE_EXPLORATION_PASS', 'ENABLE_ADAPTIVE_PERFORMANCE',
  // Logging
  'LOG_LEVEL', 'LOG_MAX_SIZE_MB', 'LOG_MAX_FILES',
  // Misc operational
  'SAVE_SCREENSHOTS', 'MAX_SCREENSHOTS', 'ENABLE_IP_CHECK',
  'WEB_SEARCH_ENABLED', 'TEMPLATE_CACHE_ENABLED', 'TEMPLATE_MATCH_THRESHOLD',
  'STATE_TIMEOUT_MS', 'STATE_HISTORY_MAX',
  'HEADLESS', 'AUTO_INSTALL_DEPENDENCIES',
  // Mode & feature flags (safe to toggle from dashboard)
  'DEGRADED_MODE', 'SELF_HEAL_ENABLED', 'ENABLE_STATUS_SERVER',

  // Human emulation
  'HUMAN_MOUSE_JITTER_PX', 'HUMAN_MOUSE_STEPS',
  // Browser contexts
  'BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS', 'BROWSER_CONTEXT_TIMEOUT_MS', 'BROWSER_CLOSE_TIMEOUT_MS',
  // Log ring buffer
  'LOG_RING_BUFFER_MAX',
  // Raw response display
  'RAW_RESPONSE_TTL_MS',
]);

// Config key metadata for the dashboard editor (grouped, with descriptions + type hints)
const CONFIG_KEY_META: Record<string, { group: string; label: string; type: 'number' | 'boolean' | 'string'; desc: string }> = {
  // Timing
  SLEEP_MIN_HOURS:             { group: 'Timing', label: 'Sleep Min (hours)', type: 'number', desc: 'Min sleep between cycles' },
  SLEEP_MAX_HOURS:             { group: 'Timing', label: 'Sleep Max (hours)', type: 'number', desc: 'Max sleep between cycles' },
  MAX_CYCLES_BEFORE_RESTART:   { group: 'Timing', label: 'Max Cycles', type: 'number', desc: 'Restart after N cycles' },
  MAX_QUESTIONS:               { group: 'Timing', label: 'Max Questions', type: 'number', desc: 'Total questions before stopping' },
  CHECK_INTERVAL_HOURS:        { group: 'Timing', label: 'Check Interval (hr)', type: 'number', desc: 'Hours between check-in cycles' },
  MAX_UPTIME_HOURS:            { group: 'Timing', label: 'Max Uptime (hr)', type: 'number', desc: 'Force restart after N hours' },
  MAX_RUNTIME_PER_CYCLE_MS:    { group: 'Timing', label: 'Cycle Timeout (ms)', type: 'number', desc: 'Max runtime per cycle' },
  STARTUP_DELAY_MIN_MINUTES:   { group: 'Timing', label: 'Startup Delay Min (min)', type: 'number', desc: 'Min random delay before first cycle' },
  STARTUP_DELAY_MAX_MINUTES:   { group: 'Timing', label: 'Startup Delay Max (min)', type: 'number', desc: 'Max random delay before first cycle' },
  ALLOWED_ACTIVITY_START_HOUR: { group: 'Timing', label: 'Activity Start Hour', type: 'number', desc: 'Earliest hour bot can be active' },
  ALLOWED_ACTIVITY_END_HOUR:   { group: 'Timing', label: 'Activity End Hour', type: 'number', desc: 'Latest hour bot can be active' },
  // Browser
  POST_CLICK_MS:               { group: 'Browser', label: 'Post-Click Delay (ms)', type: 'number', desc: 'Wait after clicking' },
  BETWEEN_STEPS_MS:            { group: 'Browser', label: 'Between Steps (ms)', type: 'number', desc: 'Wait between action steps' },
  SCROLL_AMOUNT:               { group: 'Browser', label: 'Scroll Amount (px)', type: 'number', desc: 'Pixels per scroll action' },
  SCROLL_PAUSE_MS:             { group: 'Browser', label: 'Scroll Pause (ms)', type: 'number', desc: 'Pause after scrolling' },
  VIDEO_SPEED:                 { group: 'Browser', label: 'Video Speed', type: 'number', desc: 'Playback speed multiplier' },
  VIDEO_TIMEOUT_MS:            { group: 'Browser', label: 'Video Timeout (ms)', type: 'number', desc: 'Max wait for video' },
  WAIT_MULTIPLIER:             { group: 'Browser', label: 'Wait Multiplier', type: 'number', desc: 'Global wait time multiplier' },
  BROWSER_LAUNCH_TIMEOUT_MS:   { group: 'Browser', label: 'Browser Launch Timeout', type: 'number', desc: 'Max time to launch browser' },
  BROWSER_PAGE_TIMEOUT_MS:     { group: 'Browser', label: 'Page Timeout (ms)', type: 'number', desc: 'Max time for page load' },
  MAX_CONSECUTIVE_SAME_ACTION: { group: 'Browser', label: 'Max Same Action', type: 'number', desc: 'Max repeats of same action' },
  SCROLL_NO_CHANGE_THRESHOLD:  { group: 'Browser', label: 'Scroll Stuck Threshold', type: 'number', desc: 'Scrolls with no change before recovery' },
  SWIPE_DURATION_MS:           { group: 'Browser', label: 'Swipe Duration (ms)', type: 'number', desc: 'Duration of swipe gestures' },
  LONG_PRESS_DELAY_MS:         { group: 'Browser', label: 'Long Press Delay (ms)', type: 'number', desc: 'Delay before long press activates' },
  // Memory
  ENABLE_GC_ON_CYCLE:          { group: 'Memory', label: 'GC On Cycle', type: 'boolean', desc: 'Run garbage collector after each cycle' },
  MAX_MEMORY_MB:                { group: 'Memory', label: 'Max Memory (MB)', type: 'number', desc: 'Memory ceiling before restart' },
  MEMORY_WARNING_THRESHOLD_MB: { group: 'Memory', label: 'Memory Warn (MB)', type: 'number', desc: 'Warning threshold for memory usage' },
  MEMORY_RESTART_THRESHOLD_MB: { group: 'Memory', label: 'Memory Restart (MB)', type: 'number', desc: 'Restart threshold for memory usage' },
  // Alerts
  ALERT_ON_ERROR:              { group: 'Alerts', label: 'Alert on Error', type: 'boolean', desc: 'Send alert on errors' },
  ALERT_ON_STAGNATION:         { group: 'Alerts', label: 'Alert on Stagnation', type: 'boolean', desc: 'Send alert when stuck' },
  ALERT_ON_AUTH_FAILURE:        { group: 'Alerts', label: 'Alert on Auth Failure', type: 'boolean', desc: 'Send alert on auth failures' },
  // Providers
  VISION_PRIORITY:              { group: 'Providers', label: 'Vision Priority', type: 'string', desc: 'cloud, local, or hybrid' },
  PROVIDER_ORDER:               { group: 'Providers', label: 'Provider Order', type: 'string', desc: 'Comma-separated provider priority' },
  OPENROUTER_TRIBUNAL_MODEL:   { group: 'Providers', label: 'OR Tribunal Model', type: 'string', desc: 'Model for tribunal decisions' },
  // Self-Heal
  PREDICTIVE_HEAL_ENABLED:     { group: 'Self-Heal', label: 'Predictive Heal', type: 'boolean', desc: 'Predict and prevent failures' },
  SELECTOR_DRIFT_HEAL_ENABLED:  { group: 'Self-Heal', label: 'Selector Drift Heal', type: 'boolean', desc: 'Auto-fix CSS selector drift' },
  REGRESSION_BANK_ENABLED:      { group: 'Self-Heal', label: 'Regression Bank', type: 'boolean', desc: 'Store and replay regression tests' },
  CANARY_ROLLOUT_ENABLED:       { group: 'Self-Heal', label: 'Canary Rollout', type: 'boolean', desc: 'Gradual feature rollout' },
  CANARY_OBSERVATION_HOURS:     { group: 'Self-Heal', label: 'Canary Observation (hr)', type: 'number', desc: 'Hours to observe canary' },
  DIFF_MINIMIZER_ENABLED:       { group: 'Self-Heal', label: 'Diff Minimizer', type: 'boolean', desc: 'Minimize failure-producing diffs' },
  PROMPT_EVOLUTION_ENABLED:     { group: 'Self-Heal', label: 'Prompt Evolution', type: 'boolean', desc: 'Evolve prompts over time' },
  PROMPT_EVOLUTION_MIN_ENTRIES: { group: 'Self-Heal', label: 'Prompt Evo Min Entries', type: 'number', desc: 'Min entries before evolution triggers' },
  DB_HEALER_ENABLED:            { group: 'Self-Heal', label: 'DB Healer', type: 'boolean', desc: 'Auto-repair database issues' },
  AUTH_HEALER_ENABLED:         { group: 'Self-Heal', label: 'Auth Healer', type: 'boolean', desc: 'Auto-refresh auth tokens' },
  STATE_RECOVERY_ENABLED:      { group: 'Self-Heal', label: 'State Recovery', type: 'boolean', desc: 'Recover from bad states' },
  DEPENDENCY_HEALER_ENABLED:   { group: 'Self-Heal', label: 'Dependency Healer', type: 'boolean', desc: 'Auto-fix missing deps' },
  CONFIG_RECONCILER_ENABLED:    { group: 'Self-Heal', label: 'Config Reconciler', type: 'boolean', desc: 'Sync config across modules' },
  EXTENDED_CHECKPOINT_ENABLED: { group: 'Self-Heal', label: 'Extended Checkpoint', type: 'boolean', desc: 'Detailed cycle checkpointing' },
  BLACKBOX_FULL_ENABLED:       { group: 'Self-Heal', label: 'Blackbox Full', type: 'boolean', desc: 'Full blackbox replay testing' },
  PATCH_MEMORY_ENABLED:         { group: 'Self-Heal', label: 'Patch Memory', type: 'boolean', desc: 'Remember successful patches' },
  HEAL_REWARD_TRACKER_ENABLED: { group: 'Self-Heal', label: 'Heal Reward Tracker', type: 'boolean', desc: 'Track which heals worked' },
  SELF_HEAL_TIMELINE_ENABLED:   { group: 'Self-Heal', label: 'Heal Timeline', type: 'boolean', desc: 'Log healing timeline events' },
  HEALER_CIRCUIT_BREAKER_ENABLED: { group: 'Self-Heal', label: 'Healer Circuit Breaker', type: 'boolean', desc: 'Stop healing if failure rate too high' },
  DEGRADATION_LADDER_ENABLED:  { group: 'Self-Heal', label: 'Degradation Ladder', type: 'boolean', desc: 'Gracefully degrade under load' },
  ENABLE_BLACKBOX:              { group: 'Self-Heal', label: 'Blackbox', type: 'boolean', desc: 'Enable blackbox testing' },
  ENABLE_EXPLORATION_PASS:      { group: 'Self-Heal', label: 'Exploration Pass', type: 'boolean', desc: 'Periodic UI exploration' },
  ENABLE_ADAPTIVE_PERFORMANCE:  { group: 'Self-Heal', label: 'Adaptive Performance', type: 'boolean', desc: 'Adjust timing dynamically' },

  // Logging
  LOG_LEVEL:                    { group: 'Logging', label: 'Log Level', type: 'string', desc: 'debug, info, warn, error' },
  LOG_MAX_SIZE_MB:             { group: 'Logging', label: 'Max Log Size (MB)', type: 'number', desc: 'Max size per log file' },
  LOG_MAX_FILES:                { group: 'Logging', label: 'Max Log Files', type: 'number', desc: 'Max rotated log files' },
  // Misc
  SAVE_SCREENSHOTS:             { group: 'Misc', label: 'Save Screenshots', type: 'boolean', desc: 'Persist screenshots to disk' },
  MAX_SCREENSHOTS:              { group: 'Misc', label: 'Max Screenshots', type: 'number', desc: 'Max screenshots to keep' },
  ENABLE_IP_CHECK:              { group: 'Misc', label: 'IP Check', type: 'boolean', desc: 'Verify IP location' },
  WEB_SEARCH_ENABLED:           { group: 'Misc', label: 'Web Search', type: 'boolean', desc: 'Enable web search capability' },
  TEMPLATE_CACHE_ENABLED:       { group: 'Misc', label: 'Template Cache', type: 'boolean', desc: 'Cache action templates' },
  TEMPLATE_MATCH_THRESHOLD:     { group: 'Misc', label: 'Template Match Threshold', type: 'number', desc: 'Min similarity for template match' },
  STATE_TIMEOUT_MS:             { group: 'Misc', label: 'State Timeout (ms)', type: 'number', desc: 'Timeout for state transitions' },
  STATE_HISTORY_MAX:            { group: 'Misc', label: 'State History Max', type: 'number', desc: 'Max state history entries' },
  HEADLESS:                     { group: 'Misc', label: 'Headless', type: 'boolean', desc: 'Run browser headlessly' },
  MAX_CONSECUTIVE_FAILURES:     { group: 'Misc', label: 'Max Consecutive Failures', type: 'number', desc: 'Max failures before recovery' },
  AUTO_INSTALL_DEPENDENCIES:    { group: 'Misc', label: 'Auto Install Deps', type: 'boolean', desc: 'Auto-install missing packages' },
  DEGRADED_MODE:               { group: 'Mode', label: 'Degraded Mode', type: 'boolean', desc: 'Run in reduced-capability mode' },
  SELF_HEAL_ENABLED:           { group: 'Mode', label: 'Self-Heal', type: 'boolean', desc: 'Master switch for self-heal subsystems' },
  ENABLE_STATUS_SERVER:         { group: 'Mode', label: 'Status Server', type: 'boolean', desc: 'Enable dashboard/status HTTP server' },
  HUMAN_MOUSE_JITTER_PX:       { group: 'Browser', label: 'Mouse Jitter (px)', type: 'number', desc: 'Random mouse movement jitter' },
  HUMAN_MOUSE_STEPS:           { group: 'Browser', label: 'Mouse Steps', type: 'number', desc: 'Steps for human-like mouse movement' },
  BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS: { group: 'Browser', label: 'Extended Launch Timeout', type: 'number', desc: 'Extended browser launch timeout' },
  BROWSER_CONTEXT_TIMEOUT_MS:   { group: 'Browser', label: 'Context Timeout (ms)', type: 'number', desc: 'Browser context creation timeout' },
  BROWSER_CLOSE_TIMEOUT_MS:    { group: 'Browser', label: 'Close Timeout (ms)', type: 'number', desc: 'Browser close timeout' },
  // Raw responses
  RAW_RESPONSE_TTL_MS:        { group: 'Logging', label: 'Response Display TTL (ms)', type: 'number', desc: 'How long raw model responses stay visible on dashboard (5s–300s)' },
};

// In-memory banned-states store (backed by persistent-config for same-instance restarts)
const _bannedStates: Map<string, { reason: string; bannedAt: number; bannedBy: string }> = new Map();

// On module load, restore persisted banned states into memory
try {
  for (const entry of persistConfig.getAllBannedStates()) {
    _bannedStates.set(entry.state, { reason: entry.reason, bannedAt: entry.bannedAt, bannedBy: entry.bannedBy });
  }
} catch { /* best-effort */ }

// In-memory banned-actions store (backed by persistent-config for same-instance restarts)
const _bannedActions: Map<string, { reason: string; bannedAt: number; bannedBy: string }> = new Map();

// On module load, restore persisted banned actions into memory
try {
  for (const entry of persistConfig.getAllBannedActions()) {
    _bannedActions.set(entry.action, { reason: entry.reason, bannedAt: entry.bannedAt, bannedBy: entry.bannedBy });
  }
} catch { /* best-effort */ }

// On module load, apply any persisted config overrides to the running config
try {
  const overrides = persistConfig.getAllConfigOverrides();
  if (Object.keys(overrides).length > 0) {
    const { updateConfig } = require('./get-config');
    for (const [key, value] of Object.entries(overrides)) {
      try {
        updateConfig(key, value);
        getLog()?.log?.(`Restored config override: ${key} = ${JSON.stringify(value)}`, 'INFO', 'dashboard');
      } catch { /* skip invalid */ }
    }
  }
} catch { /* best-effort */ }

function serveStaticFile(res: any, filePath: any, contentType: any) {
  fs.readFile(filePath, (err: any, content: any) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  REQUEST HANDLER — Can be mounted into any HTTP server
// ═══════════════════════════════════════════════════════════════════════
// Returns true if the request was handled (caller should NOT send 404).
// Returns false if the request didn't match any dashboard route.
// ═══════════════════════════════════════════════════════════════════════

async function handleDashboardRequest(req: any, res: any): Promise<boolean> {
  const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
      ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
      : ['*'];
  const origin = req.headers.origin || '';
  if (DASHBOARD_ALLOWED_ORIGINS.includes(origin) || DASHBOARD_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Require auth for dashboard API routes (except /health)
  // Accepts both raw ADMIN_SECRET and JWT tokens (via requireAuth)
  const requireAuth = getRequireAuth();
  const authWrap = (cb: () => void) => {
    // First check: raw ADMIN_SECRET (timing-safe)
    if (ADMIN_SECRET) {
      const authHdr = req.headers.authorization || '';
      if (authHdr.startsWith('Bearer ') && _timingSafeEqual(authHdr.slice(7), ADMIN_SECRET)) {
        cb();
        return;
      }
    }
    // Second check: JWT via requireAuth (if available)
    if (requireAuth) {
      requireAuth(req, res, () => {
        cb();
      });
      return;
    }
    // No auth configured — allow through
    cb();
  };

  // ═══════════════════════════════════════════════════════════════
  //  HTML DASHBOARD
  // ═══════════════════════════════════════════════════════════════
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    const indexPath = path.join(DASHBOARD_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      serveStaticFile(res, indexPath, 'text/html');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  READ-ONLY API ENDPOINTS
  // ═══════════════════════════════════════════════════════════════

  // Status
  if (pathname === '/api/status') {
    authWrap(() => {
      const stats = getProviderStats();
      jsonRes(res, stats ? stats() : {});
    });
    return true;
  }

  // State diagnostics
  if (pathname === '/api/state') {
    authWrap(() => {
      const diagnostics = getStateDiagnostics();
      jsonRes(res, diagnostics ? diagnostics() : {});
    });
    return true;
  }

  // Daemon state (running/paused)
  if (pathname === '/api/daemon') {
    authWrap(() => {
      jsonRes(res, getDaemonState());
    });
    return true;
  }

  // Available states list
  if (pathname === '/api/states') {
    authWrap(() => {
      jsonRes(res, { states: getAllStates() });
    });
    return true;
  }

  // Available actions list
  if (pathname === '/api/actions') {
    authWrap(() => {
      jsonRes(res, { actions: getAllActions() });
    });
    return true;
  }

  // Logs — serve from in-memory ring buffer (always available),
  // with log file as enrichment if accessible.
  if (pathname === '/api/logs') {
    authWrap(() => {
      try {
        // Primary: in-memory ring buffer (always has recent logs)
        let lines: string[] = _logRingBuffer.length > 0
          ? _logRingBuffer.slice(-200)
          : [];

        // Enrich from log file if available (append older entries)
        const candidates = [
          getCONFIG().LOG_DIR,          // config's LOG_DIR (may differ from logger's)
          path.join(os.tmpdir(), 'mathu-logs'),           // render-free-plan default
          path.join(os.tmpdir(), 'mathu-bot-logs'),       // logger.ts default
        ].filter(Boolean);

        for (const dir of candidates) {
          try {
            const logFile = path.join(dir, 'daemon.log');
            if (fs.existsSync(logFile)) {
              const data = fs.readFileSync(logFile, 'utf8');
              const fileLines = data.split('\n').filter(Boolean).slice(-200);
              if (fileLines.length > lines.length) {
                lines = fileLines;
              }
              break;
            }
          } catch { /* try next candidate */ }
        }

        if (lines.length === 0) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('No logs available yet — waiting for first cycle...');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(lines.join('\n'));
        }
      } catch (e: any) {
        res.writeHead(500);
        res.end('Error reading log file');
      }
    });
    return true;
  }

  // Raw provider responses (auto-expire after configurable TTL)
  if (pathname === '/api/raw-responses') {
    authWrap(() => {
      try {
        const { getRawResponses } = require('./providers-base');
        const responses = getRawResponses();
        let ttlMs = 30000;
        try { ttlMs = require('./get-config').RAW_RESPONSE_TTL_MS || 30000; } catch { /* default */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ttlMs, responses }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return true;
  }

  // Health (deep)
  if (pathname === '/api/health' || pathname === '/api/health/deep') {
    authWrap(() => {
      const mem = process.memoryUsage();
      const stats = getProviderStats();
      // Task 29 (2026-09-08): Surface proxy outcome + network errors in dashboard.
      // The cycle manager records these via globals set by render-free-plan.ts.
      const latestProxyOutcome = (() => { const g = (globalThis as any).__getLatestProxyOutcome; return typeof g === 'function' ? g() : null; })();
      const latestNetworkError = (() => { const g = (globalThis as any).__getLatestNetworkError; return typeof g === 'function' ? g() : null; })();
      const ipRotatorStatus = (() => {
        try {
          const ip = require('./network-ip-rotator');
          return ip.getStatus ? ip.getStatus() : {};
        } catch { return {}; }
      })();
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats: stats ? stats() : {},
        state: (() => { const d = getStateDiagnostics(); return d ? d() : {}; })(),
        daemon: getDaemonState(),
        memory: {
          heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
          heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
          rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
          rssPercent: ((mem.rss / (512 * 1024 * 1024)) * 100).toFixed(1) + '%',
        },
        uptime: process.uptime(),
        uptimeFormatted: formatUptime(process.uptime()),
        browser: (() => { const m = getBrowserMetrics(); return m ? m() : {}; })(),
        database: (() => { const s = getDatabaseStats(); return s ? s() : {}; })(),
        cache: (() => { const s = getCacheStats(); return s ? s() : {}; })(),
        failsafe: (() => { const d = getFailsafeDiagnostics(); return d ? d() : {}; })(),
        // New: proxy + network diagnostics
        proxy: {
          disabled: !!(globalThis as any).__proxyDisabled,
          currentProxy: ipRotatorStatus?.currentProxy || null,
          proxyCount: ipRotatorStatus?.proxyCount || 0,
          consecutive403s: ipRotatorStatus?.consecutive403s || 0,
          isIpBlocked: ipRotatorStatus?.isIpBlocked || false,
          latestOutcome: latestProxyOutcome,
          networkError: latestNetworkError,
          networkErrorCount: ipRotatorStatus?.networkErrorCount || 0,
        },
        // Task 35: human intervention status
        humanIntervention: {
          paused: !!(globalThis as any).__humanInterventionRequested,
          reason: (globalThis as any).__humanInterventionReason || null,
          since: (globalThis as any).__humanInterventionSince || null,
          pausedForSeconds: (globalThis as any).__humanInterventionSince
            ? Math.round((Date.now() - (globalThis as any).__humanInterventionSince) / 1000)
            : 0,
          forceHeaded: !!(globalThis as any).__forceHeaded,
        },
      };
      jsonRes(res, health);
    });
    return true;
  }

  // Metrics
  if (pathname === '/api/metrics') {
    authWrap(() => {
      try {
        const { metrics } = require('./metrics');
        jsonRes(res, metrics.getSummary ? metrics.getSummary() : {});
      } catch { jsonRes(res, {}); }
    });
    return true;
  }

  // ── Cached screenshot (set by cycle manager) — auto-captures if stale/missing ──
  if (pathname === '/api/screenshot') {
    authWrap(async () => {
      try {
        let shot = getLatestScreenshot();
        // Auto-capture if no screenshot or stale (>60s old), throttled to max once per 30s
        const now = Date.now();
        if ((!shot || (now - shot.timestamp > 60 * 1000)) && (now - _lastAutoCaptureTs > AUTO_CAPTURE_INTERVAL_MS)) {
          _lastAutoCaptureTs = now;
          const liveJpeg = await captureLiveScreenshot();
          if (liveJpeg) {
            const setShot = (globalThis as any).__setLatestScreenshot;
            if (setShot) setShot(liveJpeg, shot?.action || null);
            shot = getLatestScreenshot();
          }
        }
        if (!shot) { jsonRes(res, { available: false }, 204); return; }
        jsonRes(res, {
          available: true,
          timestamp: shot.timestamp,
          age: Date.now() - shot.timestamp,
          action: shot.action ? {
            actionType: shot.action.actionType,
            currentState: shot.action.currentState,
            reasoning: shot.action.reasoning?.substring(0, 200),
          } : null,
          screenshot: shot.screenshot,
        });
      } catch (e: any) {
        jsonRes(res, { available: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Live screenshot (capture right now) ──
  if (pathname === '/api/screenshot/live') {
    authWrap(async () => {
      try {
        const jpeg = await captureLiveScreenshot();
        if (!jpeg) { jsonRes(res, { available: false, error: 'Browser not available' }, 503); return; }
        jsonRes(res, { available: true, timestamp: Date.now(), screenshot: jpeg });
      } catch (e: any) {
        jsonRes(res, { available: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Human Intervention: Pause/Resume ──
  // Task 35 (2026-09-09): When paused, the bot stops ALL browser interaction.
  // The user can fix things manually (solve captcha, log in, etc.) then resume.
  if (pathname === '/api/intervention/pause' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (rawBody: string) => {
        try {
          const body = rawBody ? JSON.parse(rawBody) : {};
          const reason = body?.reason || body || 'manual dashboard request';
          (globalThis as any).__humanInterventionRequested = true;
          (globalThis as any).__humanInterventionReason = String(reason).substring(0, 200);
          (globalThis as any).__humanInterventionSince = Date.now();
          jsonRes(res, { ok: true, message: 'Bot paused. No browser interaction until /api/intervention/resume is called.', reason, timestamp: Date.now() });
        } catch (e: any) {
          // Even if body parse fails, still pause with default reason
          (globalThis as any).__humanInterventionRequested = true;
          (globalThis as any).__humanInterventionReason = 'manual dashboard request';
          (globalThis as any).__humanInterventionSince = Date.now();
          jsonRes(res, { ok: true, message: 'Bot paused (body parse failed, used default reason).', timestamp: Date.now() });
        }
      });
    });
    return true;
  }

  if (pathname === '/api/intervention/resume' && req.method === 'POST') {
    authWrap(() => {
      try {
        const wasPaused = (globalThis as any).__humanInterventionRequested;
        (globalThis as any).__humanInterventionRequested = false;
        (globalThis as any).__humanInterventionReason = null;
        (globalThis as any).__humanInterventionSince = null;
        jsonRes(res, { ok: true, wasPaused, message: 'Bot resumed. Normal operation continues on next cycle.' });
      } catch (e: any) {
        jsonRes(res, { ok: false, error: e.message }, 500);
      }
    });
    return true;
  }

  if (pathname === '/api/intervention/status') {
    authWrap(() => {
      jsonRes(res, {
        paused: !!(globalThis as any).__humanInterventionRequested,
        reason: (globalThis as any).__humanInterventionReason || null,
        since: (globalThis as any).__humanInterventionSince || null,
        pausedForSeconds: (globalThis as any).__humanInterventionSince
          ? Math.round((Date.now() - (globalThis as any).__humanInterventionSince) / 1000)
          : 0,
        forceHeaded: !!(globalThis as any).__forceHeaded,
      });
    });
    return true;
  }

  // ── Browser Headed/Headless Toggle ──
  // Task 35: Switch browser to headed mode for visual debugging.
  // On Render, this requires Xvfb to be installed (apt-get install xvfb).
  // When toggled, the bot will relaunch the browser on the next cycle.
  if (pathname === '/api/browser/headed' && req.method === 'POST') {
    authWrap(() => {
      try {
        (globalThis as any).__forceHeaded = true;
        // Auto-pause the bot so the user can interact with the browser
        if (!(globalThis as any).__humanInterventionRequested) {
          (globalThis as any).__humanInterventionRequested = true;
          (globalThis as any).__humanInterventionReason = 'headed mode enabled — user wants to interact';
          (globalThis as any).__humanInterventionSince = Date.now();
        }
        jsonRes(res, {
          ok: true,
          message: 'Headed mode enabled. Bot paused. Browser will relaunch as headed on next cycle. Use /api/browser/headless to switch back.',
          note: 'On Render, requires Xvfb: apt-get install xvfb && start-stop-daemon --start --background --exec /usr/bin/Xvfb -- :99 -screen 0 1280x720x24 && export DISPLAY=:99',
          paused: true,
        });
      } catch (e: any) {
        jsonRes(res, { ok: false, error: e.message }, 500);
      }
    });
    return true;
  }

  if (pathname === '/api/browser/headless' && req.method === 'POST') {
    authWrap(() => {
      try {
        (globalThis as any).__forceHeaded = false;
        jsonRes(res, {
          ok: true,
          message: 'Headless mode enabled. Browser will relaunch as headless on next cycle.',
          note: 'Bot remains paused — use /api/intervention/resume to continue.',
        });
      } catch (e: any) {
        jsonRes(res, { ok: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Provider health ──
  if (pathname === '/api/providers') {
    authWrap(async () => {
      try {
        const healthMod = require('./providers-health');
        const registryMod = require('./providers-registry');
        const providers = registryMod.getAvailableProviders ? await registryMod.getAvailableProviders() : [];
        const healthDetails = providers.map((p: any) => {
          const snapshot = healthMod.getHealthSnapshot?.(p.name) || {};
          return {
            name: p.name,
            healthScore: p.healthScore,
            totalCalls: snapshot.totalCalls || 0,
            successRate: snapshot.successRate || 0,
            avgLatencyMs: snapshot.avgLatencyMs || 0,
            isAvailable: healthMod.isProviderAvailable?.(p.name) ?? true,
            circuitBreaker: snapshot.circuitBreakerState || 'closed',
          };
        });
        const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
        jsonRes(res, { providers: healthDetails, loadFailures, providerCount: healthDetails.length, timestamp: Date.now() });
      } catch (e: any) {
        jsonRes(res, { error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Banned actions (GET) ──
  if (pathname === '/api/banned-actions' && req.method === 'GET') {
    authWrap(() => {
      const banned: Array<{ action: string; reason: string; bannedAt: number }> = [];
      for (const [action, info] of _bannedActions) {
        banned.push({ action, reason: info.reason, bannedAt: info.bannedAt });
      }
      jsonRes(res, { bannedActions: banned });
    });
    return true;
  }

  // ── Banned states (GET) ──
  if (pathname === '/api/banned-states' && req.method === 'GET') {
    authWrap(() => {
      const banned: Array<{ state: string; reason: string; bannedAt: number }> = [];
      for (const [state, info] of _bannedStates) {
        banned.push({ state, reason: info.reason, bannedAt: info.bannedAt });
      }
      jsonRes(res, { bannedStates: banned });
    });
    return true;
  }

  // ── Config keys (GET) — list all editable config keys with current values ──
  if (pathname === '/api/config/keys' && req.method === 'GET') {
    authWrap(() => {
      try {
        const cfg = getCONFIG();
        const grouped: Record<string, Array<{ key: string; label: string; type: string; desc: string; value: any }>> = {};
        for (const key of SAFE_CONFIG_KEYS) {
          const meta = CONFIG_KEY_META[key];
          if (!meta) continue;
          if (!grouped[meta.group]) grouped[meta.group] = [];
          grouped[meta.group].push({
            key,
            label: meta.label,
            type: meta.type,
            desc: meta.desc,
            value: cfg[key] !== undefined ? cfg[key] : null,
          });
        }
        jsonRes(res, { groups: grouped });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Full status (combined) ──
  if (pathname === '/api/full-status') {
    authWrap(async () => {
      try {
        const stats = getProviderStats();
        const mem = process.memoryUsage();
        const shot = getLatestScreenshot();
        const healthMod = require('./providers-health');
        const registryMod = require('./providers-registry');
        const providers = registryMod.getAvailableProviders ? await registryMod.getAvailableProviders() : [];
        const providerSummary = providers.map((p: any) => ({
          name: p.name, healthScore: p.healthScore,
          isAvailable: healthMod.isProviderAvailable?.(p.name) ?? true,
        }));
        const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
        const providerCount = registryMod.getAvailableProviderCount ? registryMod.getAvailableProviderCount() : 0;
        jsonRes(res, {
          ...(stats ? stats() : {}),
          daemon: getDaemonState(),
          memory: {
            heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
            heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
            rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
          },
          uptime: process.uptime(),
          uptimeFormatted: formatUptime(process.uptime()),
          screenshotAvailable: !!shot,
          providers: providerSummary,
          providerLoadFailures: loadFailures,
          providerCount,
          timestamp: Date.now(),
          actionCache: (() => { try { return require('./services-action-cache').getStats(); } catch { return null; } })(),
          workShifts: (() => { try { const ws = require('./services-work-shifts'); const s = ws.getShift(); return { current: s.current, reason: s.reason, fullCycle: ws.shouldRunFullCycle() }; } catch { return null; } })(),
          // Self-heal control status
          selfHealControl: (() => {
            try {
              const blLimiter = require('./bazaarlink-rate-limiter');
              const blStatus = blLimiter.getStatus ? blLimiter.getStatus() : null;
              const memoryMode = require('./memory-mode');
              return {
                executiveMode: isExecutivePrivilegesActive(),
                executiveConfigured: !!process.env.EXECUTIVE_KEY,
                executiveActivatedAt: _executiveActivatedAt,
                acceptAnyFix: (() => { try { return require('./self-heal').isAcceptAnyFixSession(); } catch { return false; } })(),
                selfHealEnabled: (() => { try { return require('./get-config').SELF_HEAL_ENABLED; } catch { return true; } })(),
                sessionActive: memoryMode.isSelfHealSessionActive?.() ?? false,
                currentMode: memoryMode.getMode?.() ?? 'unknown',
                bazaarlinkBudget: blStatus ? { used: blStatus.used, remaining: blStatus.remaining, dailyLimit: blStatus.dailyLimit, date: blStatus.date } : null,
              };
            } catch { return { executiveMode: false, executiveConfigured: false, executiveActivatedAt: null, acceptAnyFix: false, selfHealEnabled: true, sessionActive: false, currentMode: 'unknown', bazaarlinkBudget: null }; }
          })(),
        });
      } catch (e: any) {
        jsonRes(res, { error: e.message, timestamp: Date.now() }, 500);
      }
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  CONTROL API ENDPOINTS (write operations)
  // ═══════════════════════════════════════════════════════════════

  // Admin token
  if (pathname === '/api/admin/token' && req.method === 'GET') {
    if (!ADMIN_SECRET) { jsonRes(res, { error: 'Admin secret not set' }, 503); return true; }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !_timingSafeEqual(authHeader.slice(7), ADMIN_SECRET)) {
      jsonRes(res, { error: 'Unauthorized' }, 401);
      return true;
    }
    const gen = getGenerateToken();
    jsonRes(res, { token: gen ? gen({ admin: true }) : null });
    return true;
  }

  // ── Emergency stop ──
  if (pathname === '/api/emergency/stop' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { requestStop } = require('./cycle-orchestrator');
        requestStop();
        log('Emergency stop via dashboard', 'WARN', 'dashboard');
        jsonRes(res, { success: true, message: 'Emergency stop requested' });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Resume daemon ──
  if (pathname === '/api/daemon/resume' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { resumeDaemon } = require('./cycle-orchestrator');
        resumeDaemon();
        log('Daemon resumed via dashboard', 'INFO', 'dashboard');
        jsonRes(res, { success: true, message: 'Daemon resumed' });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Self-heal enable-all (overrides memory_protection disables) ──
  if (pathname === '/api/self-heal/enable' && req.method === 'POST') {
    authWrap(() => {
      try {
        const CONFIG = require('./get-config');
        const { updateConfig } = require('./get-config');
        const memoryMode = require('./memory-mode');
        const results: Record<string, any> = {};

        // 1. Master switch
        updateConfig('SELF_HEAL_ENABLED', true);
        results.SELF_HEAL_ENABLED = true;

        // 2. Re-enable all heavy self-heal sub-modules that memory_protection disabled
        const { HEAVY_SELF_HEAL_KEYS, HEAVY_RESILIENCE_KEYS } = memoryMode;
        const reEnabledKeys: string[] = [];
        for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
          if (process.env[key] === 'false') {
            delete process.env[key];
            reEnabledKeys.push(key);
          }
        }
        results.reEnabledEnvVars = reEnabledKeys;

        // 3. Reset the meta-self-test internal flag
        try {
          const { healerSelfTest } = require('./self-heal-meta-self-test');
          if (healerSelfTest?.enableSelfHeal) {
            healerSelfTest.enableSelfHeal();
            results.metaSelfTestEnabled = true;
          }
        } catch (e: any) {
          results.metaSelfTestEnabled = false;
          results.metaSelfTestError = e.message;
        }

        // 4. If currently in memory_protection, start a self-heal session
        //    instead of blindly switching to full_power. This gives the bot
        //    full power under a 30-minute timeout with DB-backed progress.
        if (memoryMode.isMemoryProtection()) {
          if (memoryMode.beginSelfHealSession) {
            memoryMode.beginSelfHealSession('manual_dashboard_enable');
            results.modeSwitched = true;
            results.sessionBased = true;
          } else {
            // Fallback for older memory-mode versions
            memoryMode.switchMode('full_power', 'manual:self_heal_enable');
            results.modeSwitched = true;
            results.sessionBased = false;
          }
        } else {
          results.modeSwitched = false;
          results.sessionBased = false;
        }

        results.totalReEnabled = reEnabledKeys.length;
        log(`Self-heal fully enabled: master=true, env vars cleared=${reEnabledKeys.length}, mode=${memoryMode.getMode()}`, 'INFO', 'dashboard');
        jsonRes(res, { success: true, ...results });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Self-heal trigger ──
  if (pathname === '/api/self-heal/trigger' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { performSelfHeal } = require('./self-heal');
        performSelfHeal().then((result: any) => {
          jsonRes(res, { success: result });
        }).catch((err: any) => {
          jsonRes(res, { error: err.message }, 500);
        });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Self-heal session status ──
  if (pathname === '/api/self-heal/session' && req.method === 'GET') {
    authWrap(() => {
      try {
        const memoryMode = require('./memory-mode');
        const sessionActive = memoryMode.isSelfHealSessionActive?.() ?? false;
        const currentMode = memoryMode.getMode();
        const thresholds = memoryMode.getThresholds();
        let sessionDetails: any = null;
        try {
          const dbMod = require('./database');
          if (dbMod?.selectCalibration) {
            const row = dbMod.selectCalibration.get('self_heal_session');
            if (row) sessionDetails = JSON.parse(row.value);
          }
        } catch {}
        jsonRes(res, {
          sessionActive,
          currentMode,
          warnHeapMB: thresholds.warnHeapMB,
          restartHeapMB: thresholds.restartHeapMB,
          sessionDetails,
          sessionTimeoutMin: Math.round((memoryMode.SELF_HEAL_SESSION_TIMEOUT_MS || 1800000) / 60000),
        });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Self-heal session abort (manual) ──
  if (pathname === '/api/self-heal/session/abort' && req.method === 'POST') {
    authWrap(() => {
      try {
        const memoryMode = require('./memory-mode');
        if (memoryMode.isSelfHealSessionActive?.()) {
          memoryMode.abortSelfHealSession('manual_dashboard_abort');
          jsonRes(res, { success: true, message: 'Session aborted, returned to MEMORY PROTECTION' });
        } else {
          jsonRes(res, { success: false, message: 'No active session' });
        }
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── GitOps rollback ──
  if (pathname === '/api/gitops/rollback' && req.method === 'POST') {
    authWrap(() => {
      try {
        const gitOps = require('./self-heal-gitops');
        const result = gitOps.gitops?.rollbackToPrevious ? gitOps.gitops.rollbackToPrevious() : false;
        jsonRes(res, { success: result });
      } catch (err: any) {
        logErr('GitOps rollback failed', err);
        jsonRes(res, { success: false, error: err.message }, 500);
      }
    });
    return true;
  }

  // ── Force state (via state-machine) — persisted so it survives restarts ──
  if (pathname === '/api/force-state' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.state || typeof data.state !== 'string') {
            jsonRes(res, { error: 'state is required' }, 400); return;
          }
          const { forceState } = require('./state-machine');
          const reason = data.reason || 'dashboard_admin';
          forceState(data.state, reason);
          // Persist the forced state so it's re-applied on restart
          persistConfig.setForcedState(data.state, reason);
          log(`State forced via dashboard: ${data.state} (persisted)`, 'WARN', 'dashboard');
          jsonRes(res, { success: true, state: data.state, persisted: true });
        } catch (e: any) {
          jsonRes(res, { error: e.message }, 400);
        }
      });
    });
    return true;
  }

  // ── Ban state (prevent bot from entering this state) ──
  if (pathname === '/api/banned-states' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.state || typeof data.state !== 'string') {
            jsonRes(res, { error: 'state is required' }, 400); return;
          }
          _bannedStates.set(data.state, { reason: data.reason || 'Banned via dashboard', bannedAt: Date.now(), bannedBy: 'dashboard' });
          // Persist to survive restarts
          persistConfig.setBannedState(data.state, data.reason || 'Banned via dashboard', 'dashboard');
          log(`State banned via dashboard: ${data.state} (${data.reason || 'no reason'})`, 'WARN', 'dashboard');
          jsonRes(res, { success: true, bannedState: data.state, persisted: true });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Unban state ──
  if (pathname === '/api/banned-states' && req.method === 'DELETE') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.state) { jsonRes(res, { error: 'state is required' }, 400); return; }
          _bannedStates.delete(data.state);
          // Remove from persistent store
          persistConfig.removeBannedState(data.state);
          log(`State unbanned via dashboard: ${data.state}`, 'INFO', 'dashboard');
          jsonRes(res, { success: true, unbannedState: data.state, persisted: true });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Ban action ──
  if (pathname === '/api/banned-actions' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type || typeof data.action_type !== 'string') {
            jsonRes(res, { error: 'action_type is required' }, 400); return;
          }
          _bannedActions.set(data.action_type, { reason: data.reason || 'Banned via dashboard', bannedAt: Date.now(), bannedBy: 'dashboard' });
          // Persist to survive restarts
          persistConfig.setBannedAction(data.action_type, data.reason || 'Banned via dashboard', 'dashboard');
          log(`Action banned via dashboard: ${data.action_type} (${data.reason || 'no reason'})`, 'WARN', 'dashboard');
          jsonRes(res, { success: true, bannedAction: data.action_type, persisted: true });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Unban action ──
  if (pathname === '/api/banned-actions' && req.method === 'DELETE') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type) { jsonRes(res, { error: 'action_type is required' }, 400); return; }
          _bannedActions.delete(data.action_type);
          // Remove from persistent store
          persistConfig.removeBannedAction(data.action_type);
          log(`Action unbanned via dashboard: ${data.action_type}`, 'INFO', 'dashboard');
          jsonRes(res, { success: true, unbannedAction: data.action_type, persisted: true });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Action cache management ──
  if (pathname === '/api/action-cache/clear' && req.method === 'POST') {
    authWrap(() => {
      try {
        const ac = require('./services-action-cache');
        ac.clear();
        log('Action cache cleared via dashboard', 'INFO', 'dashboard');
        jsonRes(res, { success: true });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Set config ──
  if (pathname === '/api/config' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!SAFE_CONFIG_KEYS.has(data.key)) {
            jsonRes(res, { error: 'Config key not allowed' }, 403); return;
          }
          // Auto-coerce value type based on config metadata
          let value = data.value;
          const meta = CONFIG_KEY_META[data.key];
          if (meta) {
            if (meta.type === 'number') value = Number(value);
            else if (meta.type === 'boolean') {
              if (typeof value === 'string') value = value === 'true' || value === '1';
              else value = !!value;
            }
          }
          const { updateConfig } = require('./get-config');
          updateConfig(data.key, value);
          // Persist config override to survive restarts
          persistConfig.setConfigOverride(data.key, value);
          log(`Config changed via dashboard: ${data.key} = ${JSON.stringify(value)} (persisted)`, 'INFO', 'dashboard');
          jsonRes(res, { success: true, key: data.key, value, persisted: true });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Executive Privileges: activate / deactivate / status ──
  if (pathname === '/api/executive/activate' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const key = data.key;
          if (!key || typeof key !== 'string') {
            jsonRes(res, { error: 'Missing or invalid "key" field' }, 400); return;
          }
          if (activateExecutivePrivileges(key)) {
            log('EXECUTIVE PRIVILEGES ACTIVATED via dashboard', 'WARN', 'dashboard');
            jsonRes(res, { success: true, active: true, activatedAt: _executiveActivatedAt });
          } else {
            log('Failed executive activation attempt (wrong key or no EXECUTIVE_KEY set)', 'WARN', 'dashboard');
            jsonRes(res, { error: 'Invalid key or EXECUTIVE_KEY not configured' }, 403);
          }
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  if (pathname === '/api/executive/deactivate' && req.method === 'POST') {
    authWrap(() => {
      deactivateExecutivePrivileges();
      log('Executive privileges deactivated via dashboard', 'INFO', 'dashboard');
      jsonRes(res, { success: true, active: false });
    });
    return true;
  }

  if (pathname === '/api/executive/status' && req.method === 'GET') {
    authWrap(() => {
      jsonRes(res, {
        active: _executivePrivilegesActive,
        configured: !!process.env.EXECUTIVE_KEY,
        activatedAt: _executiveActivatedAt,
      });
    });
    return true;
  }

  // ── Accept Any Fix (session-only, in-memory) ──
  if (pathname === '/api/self-heal/accept-any-fix' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const value = !!data.value;
          const { setAcceptAnyFixSession, isAcceptAnyFixSession } = require('./self-heal');
          setAcceptAnyFixSession(value);
          log(`ACCEPT_ANY_FIX ${value ? 'activated' : 'deactivated'} via dashboard (session-only)`, value ? 'WARN' : 'INFO', 'dashboard');
          jsonRes(res, { success: true, acceptAnyFix: isAcceptAnyFixSession() });
        } catch (e: any) {
          jsonRes(res, { error: e.message || 'Failed' }, 500);
        }
      });
    });
    return true;
  }

  // ── Generic command endpoint (legacy compat) ──
  if (pathname === '/api/command' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const { action, params } = data;
          if (action === 'force_state' && params?.state) {
            const { forceState } = require('./state-machine');
            forceState(params.state, 'admin_command');
            jsonRes(res, { success: true, state: params.state });
          } else if (action === 'restart') {
            jsonRes(res, { success: true, message: 'Restarting in 5 seconds...' });
            log('Restart requested via dashboard', 'WARN', 'dashboard');
            setTimeout(() => process.exit(0), 5000);
          } else if (action === 'gc') {
            if (global.gc) global.gc();
            jsonRes(res, { success: true });
          } else if (action === 'set_config') {
            if (!SAFE_CONFIG_KEYS.has(params.key)) {
              jsonRes(res, { error: 'Config key not allowed' }, 403); return;
            }
            const { updateConfig } = require('./get-config');
            updateConfig(params.key, params.value);
            persistConfig.setConfigOverride(params.key, params.value);
            jsonRes(res, { success: true, persisted: true });
          } else {
            jsonRes(res, { error: 'Unknown command' }, 400);
          }
        } catch (e: any) { jsonRes(res, { error: 'Invalid JSON' }, 400); }
      });
    });
    return true;
  }

  // ── Persistence info ──
  if (pathname === '/api/persist/info' && req.method === 'GET') {
    authWrap(() => {
      try {
        jsonRes(res, { success: true, ...persistConfig.getStoreInfo() });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Clear all persisted overrides (reset to defaults) ──
  if (pathname === '/api/persist/clear' && req.method === 'POST') {
    authWrap(() => {
      try {
        persistConfig.clearAllConfigOverrides();
        persistConfig.clearAllBannedStates();
        persistConfig.clearAllBannedActions();
        persistConfig.clearForcedState();
        // Also clear in-memory maps
        _bannedStates.clear();
        _bannedActions.clear();
        log('All persisted dashboard overrides cleared', 'WARN', 'dashboard');
        jsonRes(res, { success: true, message: 'All persisted overrides cleared — restart to apply clean state' });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Operational mode: GET current mode / POST switch mode ──
  if (pathname === '/api/mode' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      authWrap(() => {
        try {
          const memoryModeMod = require('./memory-mode');
          const mode = memoryModeMod.getMode();
          const thresholds = memoryModeMod.getThresholds();
          const peak = persistConfig.getRecentPeak(30);
          const mem = process.memoryUsage();
          jsonRes(res, {
            success: true,
            currentMode: mode,
            thresholds,
            currentMemory: {
              heapMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
              rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
            },
            recentPeak: peak,
          });
        } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
      });
    } else {
      authWrap(() => {
        readBody(req, res, (body) => {
          try {
            const data = JSON.parse(body);
            if (!data.mode || !['full_power', 'memory_protection', 'minimum'].includes(data.mode)) {
              jsonRes(res, { error: 'mode must be "full_power", "memory_protection", or "minimum"' }, 400); return;
            }
            const memoryModeMod = require('./memory-mode');
            const prev = memoryModeMod.getMode();
            memoryModeMod.switchMode(data.mode, data.reason || 'dashboard_manual');
            log(`Mode switched via dashboard: ${prev} → ${data.mode} (${data.reason || 'manual'})`, 'WARN', 'dashboard');
            jsonRes(res, {
              success: true,
              previousMode: prev,
              currentMode: data.mode,
              thresholds: memoryModeMod.getThresholds(),
              note: data.mode === 'full_power' ? 'Full power mode active. Heavy modules will re-enable on restart.' : data.mode === 'minimum' ? 'MINIMUM mode active. Only question-solving pipeline running. All non-essential modules disabled.' : 'Memory protection active. Heavy modules disabled.',
            });
          } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
        });
      });
    }
    return true;
  }

  // ── Not a dashboard route ──
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
//  STANDALONE SERVER CREATION (for non-render-free-plan use)
// ═══════════════════════════════════════════════════════════════════════

function createDashboardServer() {
  const server = http.createServer(async (req: any, res: any) => {
    const handled = await handleDashboardRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return server;
}

function startDashboard() {
  const server = createDashboardServer();
  const port = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || getCONFIG().STATUS_PORT || 8080);
  server.listen(port, () => {
    log(`Dashboard listening on port ${port}`, 'INFO', 'dashboard');
  });
  return server;
}

// ═══════════════════════════════════════════════════════════════════════
//  EMBEDDED DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════════

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MathU Bot Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --bg2: #161822;
    --bg3: #1c1f2e;
    --border: #2a2d3e;
    --text: #e1e4ed;
    --text2: #8b8fa3;
    --accent: #6366f1;
    --accent2: #818cf8;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --orange: #f97316;
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  a { color: var(--accent2); }

  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  .header .status-badge.ok { background: #052e16; color: var(--green); }
  .header .status-badge.warn { background: #422006; color: var(--yellow); }
  .header .status-badge.err { background: #450a0a; color: var(--red); }
  .header .status-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .header .meta { margin-left: auto; font-size: 13px; color: var(--text2); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; padding: 16px 24px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .card-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600; }
  .card-body { padding: 12px 16px; }

  .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--text2); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.orange { color: var(--orange); }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg3); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .btn:hover { background: var(--border); }
  .btn:active { transform: scale(0.97); }
  .btn.danger { border-color: #7f1d1d; color: var(--red); }
  .btn.danger:hover { background: #450a0a; }
  .btn.primary { border-color: #3730a3; color: var(--accent2); }
  .btn.primary:hover { background: #312e81; }
  .btn.success { border-color: #14532d; color: var(--green); }
  .btn.success:hover { background: #052e16; }
  .btn.sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-group { display: flex; flex-wrap: wrap; gap: 8px; }

  select, input[type="text"], input[type="number"] {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text); padding: 7px 12px; font-size: 13px; font-family: inherit;
  }
  select:focus, input:focus { outline: none; border-color: var(--accent); }
  select { cursor: pointer; }

  .screenshot-container { position: relative; background: #000; border-radius: var(--radius); overflow: hidden; }
  .screenshot-container img { width: 100%; display: block; }
  .screenshot-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text2); font-size: 14px; background: rgba(0,0,0,0.6); }
  .screenshot-meta { padding: 8px; font-size: 11px; color: var(--text2); background: var(--bg); border-top: 1px solid var(--border); display: flex; justify-content: space-between; }

  .banned-list { max-height: 200px; overflow-y: auto; }
  .banned-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .banned-item:last-child { border-bottom: none; }

  .provider-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .provider-row:last-child { border-bottom: none; }
  .provider-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .provider-dot.online { background: var(--green); }
  .provider-dot.offline { background: var(--red); }
  .provider-dot.degraded { background: var(--yellow); }

  .log-viewer { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; max-height: 350px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }

  .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 10px 16px; border-radius: var(--radius); font-size: 13px; font-weight: 500; animation: slideIn 0.2s ease-out; }
  .toast.success { background: #052e16; color: var(--green); border: 1px solid #14532d; }
  .toast.error { background: #450a0a; color: var(--red); border: 1px solid #7f1d1d; }
  .toast.info { background: #1e1b4b; color: var(--accent2); border: 1px solid #3730a3; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  .config-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
  .config-row select { flex: 1; }

  .empty { color: var(--text2); font-size: 13px; padding: 12px; text-align: center; }
  .full-width { grid-column: 1 / -1; }

  .action-info { font-size: 11px; color: var(--text2); margin-top: 4px; }

  @media (max-width: 640px) {
    .grid { padding: 12px; gap: 12px; }
    .header { padding: 12px 16px; }
    .header h1 { font-size: 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>MathU Bot</h1>
  <span id="statusBadge" class="status-badge ok"><span class="dot"></span><span id="statusText">Loading...</span></span>
  <span class="meta" id="metaInfo"></span>
</div>

<div class="grid" id="mainGrid">

  <!-- Screenshot -->
  <div class="card">
    <div class="card-header">
      <span>Screenshot</span>
      <div class="btn-group">
        <button class="btn sm primary" onclick="captureLive()">Capture Live</button>
        <button class="btn sm" onclick="refreshScreenshot()">Refresh Cached</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      <div class="screenshot-container" id="screenshotBox">
        <div class="screenshot-overlay" id="screenshotOverlay">No screenshot available</div>
      </div>
      <div class="screenshot-meta">
        <span id="screenshotAge">-</span>
        <span id="screenshotAction">-</span>
      </div>
    </div>
  </div>

  <!-- Mode Control -->
  <div class="card">
    <div class="card-header">Operational Mode <span id="modeBadge" style="font-size:10px;padding:1px 8px;border-radius:9999px;margin-left:8px;font-weight:600">FULL POWER</span></div>
    <div class="card-body">
      <div id="modeInfo" style="font-size:12px;color:var(--text2);margin-bottom:10px">Loading mode info...</div>
      <div class="btn-group">
        <button class="btn primary" id="btnFullPower" onclick="switchMode('full_power')">Full Power</button>
        <button class="btn warn" id="btnMemProtect" onclick="switchMode('memory_protection')">Mem Protection</button>
        <button class="btn danger" id="btnMinimum" onclick="switchMode('minimum')" title="Disables everything except question-solving pipeline">Minimum</button>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text2)" id="modeThresholds"></div>
    </div>
  </div>

  <!-- Daemon Control -->
  <div class="card">
    <div class="card-header">Daemon Control</div>
    <div class="card-body">
      <div class="btn-group" style="margin-bottom: 12px;">
        <button class="btn danger" onclick="emergencyStop()">Emergency Stop</button>
        <button class="btn success" onclick="resumeDaemon()">Resume Daemon</button>
        <button class="btn primary" onclick="triggerSelfHeal()">Self-Heal</button>
        <button class="btn primary" onclick="enableSelfHeal()" title="Re-enables SELF_HEAL_ENABLED + all sub-modules + switches to full_power">Enable Self-Heal</button>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="gc()">Force GC</button>
        <button class="btn" onclick="clearActionCache()">Clear Action Cache</button>
        <button class="btn" onclick="rollback()">Rollback</button>
      </div>
      <div id="daemonState" class="action-info" style="margin-top:12px;">Loading...</div>
    </div>
  </div>

  <!-- Self-Heal Control -->
  <div class="card">
    <div class="card-header">Self-Heal Control</div>
    <div class="card-body">
      <div class="stat-row"><span class="stat-label">Executive Privileges</span><span id="shExecutive" class="stat-value">-</span></div>
      <div id="execControls" style="margin:6px 0;display:flex;gap:6px;align-items:center;">
        <input type="password" id="execKeyInput" placeholder="Enter EXECUTIVE_KEY..." style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text);font-size:12px;">
        <button class="btn danger" id="execActivateBtn" onclick="execActivate()">Activate</button>
        <button class="btn" id="execDeactivateBtn" onclick="execDeactivate()" style="display:none">Deactivate</button>
      </div>
      <div class="stat-row"><span class="stat-label">Accept Any Fix</span><span id="shAcceptAny" class="stat-value">-</span><button class="btn sm danger" id="acceptAnyOnBtn" onclick="turnOnAcceptAny()" style="margin-left:8px;display:none">Turn ON</button><button class="btn sm" id="acceptAnyOffBtn" onclick="turnOffAcceptAny()" style="margin-left:8px;display:none">Turn OFF</button></div>
      <div class="stat-row"><span class="stat-label">Self-Heal Session</span><span id="shSession" class="stat-value">-</span></div>
      <div class="stat-row"><span class="stat-label">Memory Mode</span><span id="shMemoryMode" class="stat-value">-</span></div>
      <div class="stat-row"><span class="stat-label">BazaarLink Budget</span><span id="shBLBudget" class="stat-value">-</span></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text2);line-height:1.4">
        <b>Executive Privileges</b>: input the EXECUTIVE_KEY to bypass ALL safety gates (audit, canary, validation, limits) and push fixes directly to GitHub. More privileges will be added later.<br>
        <b>Accept Any Fix</b> (session-only): skip audit/consensus only, keep other safety nets. <b>Resets to OFF on every restart.</b> Must opt-in each session.
      </div>
    </div>
  </div>

  <!-- State Control -->
  <div class="card">
    <div class="card-header">State Control</div>
    <div class="card-body">
      <div class="config-row">
        <select id="stateSelect"><option value="">Loading states...</option></select>
        <button class="btn primary" onclick="forceState()">Force State</button>
        <button class="btn danger sm" onclick="banState()">Ban State</button>
      </div>
      <div id="currentState" class="stat-row"><span class="stat-label">Current State</span><span class="stat-value">-</span></div>
      <div id="stateAge" class="stat-row"><span class="stat-label">State Age</span><span class="stat-value">-</span></div>
      <div id="deadlock" class="stat-row"><span class="stat-label">Deadlock</span><span class="stat-value">-</span></div>
      <div style="margin-top:10px">
        <div class="card-header" style="padding:6px 0;font-size:12px;color:var(--text2)">Banned States <span id="persistBadge" style="font-size:10px;padding:1px 6px;border-radius:9999px;background:#1e3a5f;color:#60a5fa;margin-left:6px">persisted</span></div>
        <div class="banned-list" id="bannedStatesList"><div class="empty">None banned</div></div>
        <button class="btn sm" style="margin-top:6px;font-size:10px" onclick="clearPersistence()">Reset All Dashboard Overrides</button>
      </div>
    </div>
  </div>

  <!-- Ban Actions -->
  <div class="card">
    <div class="card-header">Action Control</div>
    <div class="card-body">
      <div class="config-row">
        <select id="banActionSelect"><option value="">Loading actions...</option></select>
        <button class="btn danger sm" onclick="banAction()">Ban Action</button>
      </div>
      <div style="margin-top:10px">
        <div class="card-header" style="padding:6px 0;font-size:12px;color:var(--text2)">Banned Actions <span style="font-size:10px;padding:1px 6px;border-radius:9999px;background:#1e3a5f;color:#60a5fa;margin-left:6px">persisted</span></div>
        <div class="banned-list" id="bannedActionsList"><div class="empty">None banned</div></div>
      </div>
    </div>
  </div>

  <!-- Config Editor -->
  <div class="card full-width">
    <div class="card-header">
      <span>Configuration</span>
      <div class="btn-group">
        <button class="btn sm primary" onclick="loadConfigKeys()">Reload Values</button>
      </div>
    </div>
    <div class="card-body" id="configEditor"><div class="empty">Loading configuration...</div></div>
  </div>

  <!-- Providers -->
  <div class="card">
    <div class="card-header">Providers</div>
    <div class="card-body" id="providersList"><div class="empty">Loading...</div></div>
  </div>

  <!-- Memory & System -->
  <div class="card">
    <div class="card-header">System</div>
    <div class="card-body" id="systemStats"></div>
  </div>

  <!-- Action Cache -->
  <div class="card">
    <div class="card-header">Action Cache</div>
    <div class="card-body" id="actionCacheStats"><div class="empty">Loading...</div></div>
  </div>

  <!-- Raw Provider Responses -->
  <div class="card full-width">
    <div class="card-header">
      <span>Raw Model Responses <small style="opacity:0.6">(auto-clear after 10s)</small></span>
      <button class="btn sm" onclick="refreshRawResponses()">Refresh</button>
    </div>
    <div class="card-body" id="rawResponsesContainer" style="padding:0">
      <div class="empty">Waiting for provider responses...</div>
    </div>
  </div>

  <!-- Logs -->
  <div class="card full-width">
    <div class="card-header">
      <span>Logs</span>
      <button class="btn sm" onclick="refreshLogs()">Refresh</button>
    </div>
    <div class="card-body" style="padding:0">
      <div class="log-viewer" id="logViewer">Loading...</div>
    </div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

<script>
const API = '';
let authHeader = '';
let autoRefresh = true;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader) headers['Authorization'] = authHeader;
  try {
    const r = await fetch(API + path, { ...opts, headers });
    if (r.status === 401) {
      const token = prompt('Enter admin token (or ADMIN_SECRET):');
      if (token) { authHeader = 'Bearer ' + token; return api(path, opts); }
      throw new Error('Unauthorized');
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return r.json();
    return r.text();
  } catch (e) {
    console.error('API error:', path, e);
    return null;
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtUptime(s) {
  if (!s) return '-';
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return [d>0?d+'d':'', h>0?h+'h':'', m>0?m+'m':'', sec+'s'].filter(Boolean).join(' ');
}

function fmtAge(ms) {
  if (!ms || ms < 0) return '-';
  if (ms < 60000) return Math.round(ms/1000) + 's ago';
  return Math.round(ms/60000) + 'm ago';
}

// ── Screenshot ──
async function refreshScreenshot() {
  const data = await api('/api/screenshot');
  if (!data) return;
  if (!data.available) {
    document.getElementById('screenshotOverlay').style.display = 'flex';
    document.getElementById('screenshotOverlay').textContent = 'No screenshot available';
    document.getElementById('screenshotAge').textContent = '-';
    document.getElementById('screenshotAction').textContent = '-';
    return;
  }
  const box = document.getElementById('screenshotBox');
  let img = box.querySelector('img');
  if (!img) { img = document.createElement('img'); box.appendChild(img); }
  img.src = 'data:image/jpeg;base64,' + data.screenshot;
  img.style.display = 'block';
  document.getElementById('screenshotOverlay').style.display = 'none';
  document.getElementById('screenshotAge').textContent = fmtAge(Date.now() - data.timestamp);
  document.getElementById('screenshotAction').textContent = data.action ? data.action.actionType + ' | ' + (data.action.currentState || '') : '-';
}

async function captureLive() {
  toast('Capturing live screenshot...', 'info');
  const data = await api('/api/screenshot/live');
  if (!data || !data.available) { toast('Failed to capture screenshot', 'error'); return; }
  const box = document.getElementById('screenshotBox');
  let img = box.querySelector('img');
  if (!img) { img = document.createElement('img'); box.appendChild(img); }
  img.src = 'data:image/jpeg;base64,' + data.screenshot;
  img.style.display = 'block';
  document.getElementById('screenshotOverlay').style.display = 'none';
  document.getElementById('screenshotAge').textContent = 'Just now';
  toast('Live screenshot captured', 'success');
}

// ── Daemon ──
async function emergencyStop() {
  if (!confirm('Stop the bot daemon? It will not run cycles until resumed.')) return;
  const r = await api('/api/emergency/stop', { method: 'POST' });
  if (r?.success) toast('Emergency stop activated', 'success');
  else toast('Stop failed', 'error');
  refreshAll();
}
async function resumeDaemon() {
  const r = await api('/api/daemon/resume', { method: 'POST' });
  if (r?.success) toast('Daemon resumed', 'success');
  else toast('Resume failed', 'error');
  refreshAll();
}
async function triggerSelfHeal() {
  toast('Self-heal triggered...', 'info');
  const r = await api('/api/self-heal/trigger', { method: 'POST' });
  toast(r?.success ? 'Self-heal complete' : 'Self-heal failed', r?.success ? 'success' : 'error');
}
async function enableSelfHeal() {
  toast('Enabling self-heal (all layers)...', 'info');
  const r = await api('/api/self-heal/enable', { method: 'POST' });
  if (r?.success) {
    toast('Self-heal enabled: ' + r.totalReEnabled + ' sub-modules restored' + (r.modeSwitched ? (r.sessionBased ? ', self-heal session active (30min timeout)' : ', switched to full_power') : ''), 'success');
    refreshAll();
  } else {
    toast('Failed: ' + (r?.error || 'unknown'), 'error');
  }
}
async function gc() {
  const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ action: 'gc' }) });
  toast(r?.success ? 'GC triggered' : 'GC failed', r?.success ? 'success' : 'error');
}
async function clearActionCache() {
  if (!confirm('Clear all cached actions?')) return;
  const r = await api('/api/action-cache/clear', { method: 'POST' });
  toast(r?.success ? 'Cache cleared' : 'Failed', r?.success ? 'success' : 'error');
  refreshAll();
}
async function rollback() {
  if (!confirm('Rollback to previous version?')) return;
  const r = await api('/api/gitops/rollback', { method: 'POST' });
  toast(r?.success ? 'Rollback initiated' : 'Rollback failed', r?.success ? 'success' : 'error');
}

// ── Executive Privileges ──
async function execActivate() {
  const input = document.getElementById('execKeyInput');
  const key = input?.value?.trim();
  if (!key) { toast('Enter the EXECUTIVE_KEY', 'error'); return; }
  if (!confirm('ACTIVATE EXECUTIVE PRIVILEGES? This will bypass ALL safety gates and push fixes directly to GitHub.')) return;
  const r = await api('/api/executive/activate', { method: 'POST', body: JSON.stringify({ key }) });
  if (r?.success) {
    toast('EXECUTIVE PRIVILEGES ACTIVATED', 'warn');
    input.value = '';
    refreshAll();
  } else {
    toast(r?.error || 'Activation failed', 'error');
  }
}
async function execDeactivate() {
  const r = await api('/api/executive/deactivate', { method: 'POST' });
  if (r?.success) {
    toast('Executive privileges deactivated', 'success');
    refreshAll();
  }
}

// ── State ──
async function loadStates() {
  const r = await api('/api/states');
  if (!r) return;
  const sel = document.getElementById('stateSelect');
  sel.innerHTML = '<option value="">Select state...</option>' + r.states.map(s => '<option value="'+s+'">'+s+'</option>').join('');
}
async function forceState() {
  const s = document.getElementById('stateSelect').value;
  if (!s) return;
  if (!confirm('Force state to: ' + s + '?')) return;
  const r = await api('/api/force-state', { method: 'POST', body: JSON.stringify({ state: s }) });
  toast(r?.success ? 'State forced: ' + s : 'Failed: ' + (r?.error||''), r?.success ? 'success' : 'error');
  refreshAll();
}
async function banState() {
  const s = document.getElementById('stateSelect').value;
  if (!s) { toast('Select a state first', 'error'); return; }
  const reason = prompt('Reason for banning state ' + s + ':') || '';
  const r = await api('/api/banned-states', { method: 'POST', body: JSON.stringify({ state: s, reason }) });
  toast(r?.success ? 'Banned state: ' + s : 'Failed', r?.success ? 'success' : 'error');
  refreshBannedStates();
}
async function unbanState(state) {
  const r = await api('/api/banned-states', { method: 'DELETE', body: JSON.stringify({ state }) });
  toast(r?.success ? 'Unbanned: ' + state : 'Failed', r?.success ? 'success' : 'error');
  refreshBannedStates();
}
async function refreshBannedStates() {
  const r = await api('/api/banned-states');
  const el = document.getElementById('bannedStatesList');
  if (!r || !r.bannedStates || r.bannedStates.length === 0) {
    el.innerHTML = '<div class="empty">None banned</div>';
    return;
  }
  el.innerHTML = r.bannedStates.map(b =>
    '<div class="banned-item"><span>'+b.state+' <span style="color:var(--text2);font-size:11px">'+b.reason+'</span></span>' +
    '<button class="btn sm" onclick="unbanState(\\''+b.state+'\\')">Unban</button></div>'
  ).join('');
}
async function clearPersistence() {
  if (!confirm('Clear ALL persisted dashboard overrides? Config changes, banned states, and forced state will be reset. Restart recommended after.')) return;
  const r = await api('/api/persist/clear', { method: 'POST' });
  toast(r?.success ? 'All overrides cleared — restart to apply' : 'Failed', r?.success ? 'success' : 'error');
  refreshBannedStates();
}

// ── Mode Control ──
async function refreshMode() {
  const r = await api('/api/mode');
  if (!r) return;
  const badge = document.getElementById('modeBadge');
  const info = document.getElementById('modeInfo');
  const thresholds = document.getElementById('modeThresholds');
  const btnFP = document.getElementById('btnFullPower');
  const btnMP = document.getElementById('btnMemProtect');

  const isMin = r.currentMode === 'minimum';
  const isMP = r.currentMode === 'memory_protection' || isMin;
  const label = isMin ? 'MINIMUM' : isMP ? 'MEMORY PROTECTION' : 'FULL POWER';
  if (badge) {
    badge.textContent = label;
    if (isMin) { badge.style.background = '#7f1d1d'; badge.style.color = '#fca5a5'; }
    else if (isMP) { badge.style.background = '#92400e'; badge.style.color = '#fcd34d'; }
    else { badge.style.background = '#065f46'; badge.style.color = '#6ee7b7'; }
  }
  if (info) {
    const heap = r.currentMemory?.heapMB || '?';
    const rss = r.currentMemory?.rssMB || '?';
    const peak = r.recentPeak;
    info.innerHTML = 'Heap: ' + heap + 'MB | RSS: ' + rss + 'MB | Peak(30m): ' + (peak?.peakHeapMB || 0) + 'MB heap, ' + (peak?.peakRssMB || 0) + 'MB RSS';
  }
  if (thresholds && r.thresholds) {
    thresholds.textContent = 'Warn: ' + r.thresholds.warnHeapMB + 'MB | Restart: ' + r.thresholds.restartHeapMB + 'MB | RSS hard: ' + r.thresholds.rssHardLimitMB + 'MB | GC: ' + (r.thresholds.gcIntervalMs / 1000) + 's';
  }
  const btnMin = document.getElementById('btnMinimum');
  if (btnFP) btnFP.style.opacity = isMin ? '0.3' : isMP ? '0.5' : '1';
  if (btnMP) btnMP.style.opacity = isMin ? '0.5' : isMP ? '1' : '0.5';
  if (btnMin) btnMin.style.opacity = isMin ? '1' : '0.5';
}
async function switchMode(mode) {
  const msgs = { full_power: 'Heavy modules will re-enable on restart.', memory_protection: 'Heavy self-heal modules disabled.', minimum: 'ALL non-essential modules disabled. Only question-solving pipeline remains.' };
  const action = 'switch to ' + (mode === 'minimum' ? 'MINIMUM' : mode === 'memory_protection' ? 'Memory Protection' : 'Full Power');
  if (!confirm(action + '? ' + (msgs[mode] || ''))) return;
  const r = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode, reason: 'dashboard_manual' }) });
  if (r?.success) {
    toast('Mode: ' + r.previousMode + ' \u2192 ' + r.currentMode, 'success');
    if (r.note) toast(r.note, 'info');
  } else {
    toast('Failed: ' + (r?.error || 'unknown'), 'error');
  }
  refreshMode();
  refreshAll();
}

// ── Actions Ban ──
async function loadActions() {
  const r = await api('/api/actions');
  if (!r) return;
  const sel = document.getElementById('banActionSelect');
  sel.innerHTML = '<option value="">Select action...</option>' + r.actions.map(a => '<option value="'+a+'">'+a+'</option>').join('');
}
async function banAction() {
  const action = document.getElementById('banActionSelect').value;
  if (!action) { toast('Select an action first', 'error'); return; }
  const reason = prompt('Reason for banning action ' + action + ':') || '';
  const r = await api('/api/banned-actions', { method: 'POST', body: JSON.stringify({ action_type: action, reason }) });
  toast(r?.success ? 'Banned action: ' + action : 'Failed', r?.success ? 'success' : 'error');
  refreshBannedActions();
}
async function unbanAction(actionType) {
  const r = await api('/api/banned-actions', { method: 'DELETE', body: JSON.stringify({ action_type: actionType }) });
  toast(r?.success ? 'Unbanned: ' + actionType : 'Failed', r?.success ? 'success' : 'error');
  refreshBannedActions();
}
async function refreshBannedActions() {
  const r = await api('/api/banned-actions');
  const el = document.getElementById('bannedActionsList');
  if (!r || !r.bannedActions || r.bannedActions.length === 0) {
    el.innerHTML = '<div class="empty">None banned</div>';
    return;
  }
  el.innerHTML = r.bannedActions.map(b =>
    '<div class="banned-item"><span>'+b.action+' <span style="color:var(--text2);font-size:11px">'+b.reason+'</span></span>' +
    '<button class="btn sm" onclick="unbanAction(\\''+b.action+'\\')">Unban</button></div>'
  ).join('');
}

// ── Config Editor ──
async function loadConfigKeys() {
  const r = await api('/api/config/keys');
  if (!r || !r.groups) return;
  const el = document.getElementById('configEditor');
  let html = '';
  for (const [group, keys] of Object.entries(r.groups)) {
    html += '<div style="margin-bottom:16px"><div style="font-size:13px;font-weight:600;color:var(--accent2);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">'+group+'</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">';
    for (const item of keys) {
      const isBool = item.type === 'boolean';
      const val = item.value;
      const displayVal = isBool ? '<span class="stat-value '+(val?'green':'red')+'">'+(val?'true':'false')+'</span>' : '<span class="stat-value">'+val+'</span>';
      const inputHtml = isBool
        ? '<button class="btn sm '+(val?'success':'danger')+'" onclick="toggleBoolConfig(\\''+item.key+'\\','+!val+')">'+(val?'ON':'OFF')+'</button>'
        : '<input type="'+(item.type==='number'?'number':'text')+'" value="'+val+'" style="width:80px;font-size:12px;padding:4px 8px" id="cfg_'+item.key+'"> <button class="btn sm primary" onclick="saveConfig(\\''+item.key+'\\')">Set</button>';
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;display:flex;align-items:center;gap:8px">';
      html += '<div style="flex:1"><div style="font-size:12px;font-weight:500">'+item.label+'</div><div style="font-size:11px;color:var(--text2)">'+item.desc+'</div></div>';
      html += '<div style="display:flex;align-items:center;gap:6px">' + inputHtml + '</div>';
      html += '</div>';
    }
    html += '</div></div>';
  }
  el.innerHTML = html || '<div class="empty">No configurable keys found</div>';
}
async function saveConfig(key) {
  const input = document.getElementById('cfg_'+key);
  if (!input) return;
  let value = input.value;
  // Try to parse as number if the field is numeric
  if (input.type === 'number' || !isNaN(value)) value = Number(value);
  else if (value === 'true') value = true;
  else if (value === 'false') value = false;
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ key, value }) });
  toast(r?.success ? key + ' = ' + value : 'Failed: ' + (r?.error||''), r?.success ? 'success' : 'error');
  if (r?.success) loadConfigKeys(); // Refresh to show updated values
}
async function toggleBoolConfig(key, newValue) {
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ key, value: newValue }) });
  toast(r?.success ? key + ' = ' + newValue : 'Failed: ' + (r?.error||''), r?.success ? 'success' : 'error');
  if (r?.success) loadConfigKeys();
}
async function turnOnAcceptAny() {
  const r = await api('/api/self-heal/accept-any-fix', { method: 'POST', body: JSON.stringify({ value: true }) });
  if (r?.success) {
    toast('Accept Any Fix ON (session-only — resets on restart)', 'warn');
    refreshFullStatus();
  } else {
    toast('Failed: ' + (r?.error||''), 'error');
  }
}
async function turnOffAcceptAny() {
  const r = await api('/api/self-heal/accept-any-fix', { method: 'POST', body: JSON.stringify({ value: false }) });
  if (r?.success) {
    toast('Accept Any Fix turned OFF', 'success');
    refreshFullStatus();
  } else {
    toast('Failed: ' + (r?.error||''), 'error');
  }
}

// ── Raw Responses ──
let _lastRawResponseCount = 0;
async function refreshRawResponses() {
  const el = document.getElementById('rawResponsesContainer');
  try {
    const data = await api('/api/raw-responses');
    const arr = Array.isArray(data) ? data : (data && data.responses) || [];
    const ttlSec = Math.round(((data && data.ttlMs) || 30000) / 1000);
    if (arr.length === 0) {
      if (_lastRawResponseCount > 0) { el.innerHTML = '<div class="empty">No active responses (cleared after ' + ttlSec + 's)</div>'; _lastRawResponseCount = 0; }
      return;
    }
    _lastRawResponseCount = arr.length;
    let html = '';
    for (const r of arr) {
      const age = Math.round((Date.now() - r.ts) / 1000);
      const remaining = Math.max(0, ttlSec - age);
      const redThreshold = Math.max(1, Math.round(ttlSec * 0.1));
      const yellowThreshold = Math.round(ttlSec * 0.5);
      const ageClass = remaining <= redThreshold ? 'red' : remaining <= yellowThreshold ? 'yellow' : 'green';
      html += '<div style="margin:8px 12px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg)">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
      html += '<strong style="color:var(--accent)">' + r.provider + '</strong>';
      html += '<span style="font-size:11px;opacity:0.7">' + (r.model || '') + '</span>';
      html += '<span class="' + ageClass + '" style="font-size:11px;padding:1px 6px;border-radius:8px">' + remaining + 's</span>';
      html += '</div>';
      // Show content (the text the model returned)
      const content = r.content || '';
      const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:300px;overflow:auto;margin:0;background:var(--code-bg);padding:8px;border-radius:4px">' + escaped + '</pre>';
      // Show full body toggle if available
      if (r.fullBody) {
        const bodyId = 'fb_' + r.ts + '_' + r.provider;
        html += '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;opacity:0.7">Full API response body</summary>';
        const bodyEscaped = r.fullBody.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;max-height:400px;overflow:auto;margin:4px 0 0;padding:8px;background:var(--code-bg);border-radius:4px">' + bodyEscaped + '</pre>';
        html += '</details>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty">Error loading responses</div>'; }
}

// ── Logs ──
async function refreshLogs() {
  const text = await api('/api/logs');
  const el = document.getElementById('logViewer');
  if (text) { el.textContent = typeof text === 'string' ? text : JSON.stringify(text); el.scrollTop = el.scrollHeight; }
}

// ── Refresh all data ──
async function refreshAll() {
  // Full status
  const full = await api('/api/full-status');
  if (full) {
    // Status badge
    const badge = document.getElementById('statusBadge');
    const sText = document.getElementById('statusText');
    const ds = full.daemon;
    if (ds?.stopRequested) { badge.className = 'status-badge warn'; sText.textContent = 'Paused'; }
    else { badge.className = 'status-badge ok'; sText.textContent = 'Running'; }

    // Meta
    document.getElementById('metaInfo').textContent = fmtUptime(full.uptime) + ' | ' + (full.memory?.rss || '-') + ' RSS';

    // Daemon state
    document.getElementById('daemonState').textContent = 'Stop: ' + (ds?.stopRequested ? 'YES' : 'no') + ' | Cycles: ' + (full.cycleCount || 0) + ' | Questions: ' + (full.questionsCompleted || 0);

    // System
    const sys = document.getElementById('systemStats');
    sys.innerHTML =
      '<div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">' + fmtUptime(full.uptime) + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Heap Used</span><span class="stat-value">' + (full.memory?.heapUsed||'-') + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">RSS</span><span class="stat-value">' + (full.memory?.rss||'-') + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Providers</span><span class="stat-value">' + (full.providerCount||0) + '</span></div>' +
      (full.workShifts ? '<div class="stat-row"><span class="stat-label">Work Shift</span><span class="stat-value ' + (full.workShifts.fullCycle ? 'green' : 'yellow') + '">' + full.workShifts.current + '</span></div>' : '');

    // Action Cache
    const ac = full.actionCache;
    const acEl = document.getElementById('actionCacheStats');
    if (ac) {
      acEl.innerHTML =
        '<div class="stat-row"><span class="stat-label">Hits</span><span class="stat-value green">' + (ac.hits||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Misses</span><span class="stat-value">' + (ac.misses||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Saves</span><span class="stat-value">' + (ac.saves||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Evictions</span><span class="stat-value red">' + (ac.evictions||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Active Entries</span><span class="stat-value">' + (ac.activeEntries||0) + '</span></div>' +
        (ac.topActions?.length ? '<div style="margin-top:8px;font-size:11px;color:var(--text2)">Top: ' + ac.topActions.map(a=>a.action+' ('+a.count+')').join(', ') + '</div>' : '');
    } else { acEl.innerHTML = '<div class="empty">No cache data</div>'; }

    // Providers
    const pList = document.getElementById('providersList');
    if (full.providers?.length) {
      pList.innerHTML = full.providers.map(p => {
        const cls = p.isAvailable ? (p.healthScore > 70 ? 'online' : 'degraded') : 'offline';
        return '<div class="provider-row"><span class="provider-dot ' + cls + '"></span><span style="flex:1">' + p.name + '</span><span class="stat-value">' + (p.healthScore||0) + '%</span></div>';
      }).join('');
    } else { pList.innerHTML = '<div class="empty">No providers</div>'; }

    // Self-Heal Control
    const shc = full.selfHealControl;
    if (shc) {
      const exEl = document.getElementById('shExecutive');
      const exDeactBtn = document.getElementById('execDeactivateBtn');
      const exActBtn = document.getElementById('execActivateBtn');
      const exInput = document.getElementById('execKeyInput');
      if (shc.executiveMode) {
        exEl.textContent = 'ACTIVE'; exEl.className = 'stat-value red';
        exDeactBtn.style.display = '';
        exActBtn.style.display = 'none';
        exInput.style.display = 'none';
      } else if (shc.executiveConfigured) {
        exEl.textContent = 'configured (inactive)'; exEl.className = 'stat-value';
        exDeactBtn.style.display = 'none';
        exActBtn.style.display = '';
        exInput.style.display = '';
      } else {
        exEl.textContent = 'not configured'; exEl.className = 'stat-value';
        exDeactBtn.style.display = 'none';
        exActBtn.style.display = 'none';
        exInput.style.display = 'none';
      }
      const aaEl = document.getElementById('shAcceptAny');
      const aaOnBtn = document.getElementById('acceptAnyOnBtn');
      const aaOffBtn = document.getElementById('acceptAnyOffBtn');
      if (shc.acceptAnyFix) { aaEl.textContent = 'ON'; aaEl.className = 'stat-value orange'; aaOnBtn.style.display = 'none'; aaOffBtn.style.display = ''; }
      else { aaEl.textContent = 'off'; aaEl.className = 'stat-value green'; aaOnBtn.style.display = ''; aaOffBtn.style.display = 'none'; }
      const ssEl = document.getElementById('shSession');
      if (shc.sessionActive) { ssEl.textContent = 'ACTIVE'; ssEl.className = 'stat-value yellow'; }
      else { ssEl.textContent = 'idle'; ssEl.className = 'stat-value green'; }
      const mmEl = document.getElementById('shMemoryMode');
      mmEl.textContent = shc.currentMode || '-';
      const blEl = document.getElementById('shBLBudget');
      if (shc.bazaarlinkBudget) {
        const bl = shc.bazaarlinkBudget;
        const pct = bl.dailyLimit > 0 ? Math.round((bl.used / bl.dailyLimit) * 100) : 0;
        const blCls = bl.remaining <= 5 ? 'red' : bl.remaining <= 15 ? 'orange' : 'green';
        blEl.innerHTML = '<span class="' + blCls + '">' + bl.used + '/' + bl.dailyLimit + '</span> (' + bl.remaining + ' remaining, ' + pct + '% used)';
      } else { blEl.textContent = 'unavailable'; }
    }
  }

  // State
  const state = await api('/api/state');
  if (state) {
    document.querySelector('#currentState .stat-value').textContent = state.currentState || '-';
    document.querySelector('#stateAge .stat-value').textContent = state.stateAge ? fmtUptime(state.stateAge / 1000) : '-';
    const dl = document.querySelector('#deadlock .stat-value');
    if (state.deadlockDetected) { dl.textContent = 'DETECTED'; dl.className = 'stat-value red'; }
    else { dl.textContent = 'None'; dl.className = 'stat-value green'; }
  }

  // Screenshot
  refreshScreenshot();
  // Bans
  refreshBannedActions();
  // Banned states
  refreshBannedStates();
  // Mode
  refreshMode();
  // Persistence info
  const pInfo = await api('/api/persist/info');
  const badge = document.getElementById('persistBadge');
  if (pInfo && badge) {
    const total = (pInfo.configCount||0) + (pInfo.bannedStateCount||0) + (pInfo.bannedActionCount||0) + (pInfo.hasForcedState?1:0);
    badge.textContent = total > 0 ? total + ' persisted override' + (total>1?'s':'') : 'no overrides';
    badge.style.background = total > 0 ? '#1e3a5f' : '#374151';
  }
}

// ── Init ──
(async function init() {
  await loadStates();
  await loadActions();
  await refreshAll();
  await loadConfigKeys();
  refreshLogs();
  refreshRawResponses();
  setInterval(() => { if (autoRefresh) refreshAll(); }, 5000);
  setInterval(refreshLogs, 10000);
  setInterval(refreshRawResponses, 2000);
})();
</script>
</body>
</html>`;
}

module.exports = {
  handleDashboardRequest,
  createDashboardServer,
  startDashboard,
  getLatestScreenshot,
  setLatestScreenshot,
  _getDashboardHTML: getDashboardHTML,
  _injectDependencies,
  isExecutivePrivilegesActive,
  activateExecutivePrivileges,
  deactivateExecutivePrivileges,
};
