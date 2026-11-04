'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Stealth Operations Coordinator
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose:
//   Consolidates the bot's "stay invisible" concerns into a single
//   coordinator. The bot already has many stealth-adjacent pieces —
//   browser-ghost-mode (no-browser fallback), protocol-chameleon (request
//   schema adaptation), telemetry-gan (human-like mouse trajectories),
//   network-ip-rotator (proxy rotation), utils-user-agent (UA rotation),
//   flutter-gesture-simulator (touch injection). Each one solves a
//   *local* problem. None of them answers: "how suspicious are we right
//   now, and what should we do about it?"
//
//   stealth-operations.ts is that answer. It is the central authority for:
//
//     1. Stealth level — a discrete NORMAL / ELEVATED / MAXIMUM state
//        that other modules can read to scale their own behaviour
//        (e.g. jitter more, slow down, skip risky actions).
//     2. Detection signal aggregation — every part of the bot reports
//        "suspicion events" here (HTTP 403/429, CAPTCHA prompts, sudden
//        latency spikes, IP block signals). Signals decay over time so
//        a single bad minute doesn't permanently paralyse the bot.
//     3. Risk scoring — converts the live signal queue into a 0-100
//        risk score, which drives automatic level escalation/relaxation.
//     4. Stealth budget — a token bucket that caps how many
//        "expensive" (high-signal) actions the bot may take per time
//        window. When the budget is empty, callers must wait or fall
//        back to a cheaper action.
//     5. Timing jitter — human-like delay helpers used by the cycle
//        manager and action executor to avoid robotic request patterns.
//     6. Decoy traffic — periodic, low-cost background requests to
//        non-mathu hosts so the bot's request stream doesn't look like
//        a single-target laser. Disabled by default; enable explicitly.
//     7. Fingerprint coherence — picks ONE consistent browser profile
//        (user-agent + viewport + platform + sec-ch-ua) at startup and
//        re-rotates only when escalation demands it. The most common
//        detection signal is a UA that doesn't match its declared
//        platform — this prevents that class of bug.
//
// Integration points (who calls what):
//   - cycle-cycle-manager.ts   → calls start() at boot, jitterDelay()
//                                 around each cycle iteration
//   - cycle-action-executor.ts → calls consumeBudget() before any
//                                 click/submit; if budget empty, defers
//   - providers-base.ts        → calls reportSignal('http_block') on 403/429
//   - auth-captcha-loop-guard  → calls reportSignal('captcha') on each
//                                 CAPTCHA encounter
//   - network-ip-rotator       → calls reportSignal('ip_block') when
//                                 a proxy is flagged; listens for
//                                 onLevelChange to rotate on MAXIMUM
//   - browser-ghost-mode      → calls onLevelChange(MAXIMUM) handler:
//                                 if MAXIMUM persists > N cycles, may
//                                 hand off to ghost mode
//   - dashboard-server         → reads getStatus() for the operator UI
//
// Design rules:
//   - All external calls wrapped in try/catch. Stealth must NEVER
//     crash the bot — a broken stealth module is worse than none.
//   - All timers use .unref() so they don't keep the process alive.
//   - No top-level requires of config/logger (circular-dep safe, like
//     browser-ghost-mode and memory-warfare).
//   - State lives in module scope (singleton) — same pattern as
//     network-ip-rotator and memory-warfare.
//   - Every public function is idempotent and safe to call from any
//     state (started, stopped, mid-escalation).
//
// Philosophy:
//   "The best stealth is the one that never has to prove itself."
//   The bot's primary job is solving math problems. Stealth operations
//   exist to keep it alive long enough to do that job — not to fight
//   the platform. When in doubt, prefer the cheaper action: skip the
//   request, wait a bit longer, rotate the fingerprint. Aggression is
//   reserved for when the bot is actively being blocked.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Dependency injection (lazy, circular-safe) ──────────────────────────

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps || {};
}

function getCONFIG(): Record<string, any> {
  // Lazy: container injects `config`; if not yet injected (early require),
  // fall back to the lazy get-config module. Never require('./config')
  // directly — that creates a hard circular dependency.
  if (_deps.config) return _deps.config;
  try { return require('./get-config'); } catch { return {}; }
}

function log(msg: string, level: string = 'INFO', mod: string = 'stealth-ops') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through to console */ }
  try { console.log(`[${level}] [${mod}] ${msg}`); } catch { /* nothing more we can do */ }
}

function logError(msg: string, err: any) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  try { console.error(`[ERROR] [stealth-ops] ${msg}`, err); } catch { /* nothing */ }
}

// ─── Types ────────────────────────────────────────────────────────────────

type StealthLevel = 'NORMAL' | 'ELEVATED' | 'MAXIMUM';

type SignalKind =
  | 'http_block'      // 403 / 429 / 5xx from provider or platform
  | 'ip_block'        // proxy flagged / IP banned
  | 'captcha'         // CAPTCHA shown
  | 'latency_spike'   // sudden slow-down (provider took >N seconds)
  | 'fingerprint_mismatch'
  | 'rate_limited'    // explicit 429 with Retry-After
  | 'login_challenge' // unexpected login wall
  | 'custom';         // caller-defined

interface DetectionSignal {
  kind: SignalKind;
  weight: number;       // contribution to risk score
  timestamp: number;     // ms epoch
  source: string;        // module that reported it (for diagnostics)
  detail?: string;       // free-form context (URL, status code, ...)
  ttlMs: number;         // signal is dropped after this many ms
}

interface FingerprintProfile {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  platform: string;
  secChUa: string;
  secChUaPlatform: string;
  prefersDark: boolean;
  reducedMotion: 'no-preference' | 'reduce';
  timezone: string;
  locale: string;
}

interface LevelChangeListener {
  id: string;
  fn: (newLevel: StealthLevel, prevLevel: StealthLevel, ctx: EscalationContext) => void;
}

interface EscalationContext {
  reason: string;
  riskScore: number;
  topSignal: SignalKind | null;
  timestamp: number;
}

interface StealthStatus {
  level: StealthLevel;
  riskScore: number;
  signalCount: number;
  budgetTokens: number;
  budgetCapacity: number;
  decoyTrafficActive: boolean;
  fingerprintName: string;
  started: boolean;
  lastEscalation: number | null;
  lastRelaxation: number | null;
  totalSignalsReceived: number;
  totalBudgetRefusals: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

const STEALTH_LEVELS: StealthLevel[] = ['NORMAL', 'ELEVATED', 'MAXIMUM'];

const DEFAULT_THRESHOLDS = {
  // Risk score (0-100) at which we step up / down a level.
  escalateToElevated: 35,
  escalateToMaximum: 70,
  relaxToNormal: 10,
  relaxToElevated: 45,
};

// Per-signal default weights. Callers may override per-call.
const DEFAULT_SIGNAL_WEIGHTS: Record<SignalKind, number> = {
  http_block:            20,
  ip_block:              30,
  captcha:               25,
  latency_spike:          8,
  fingerprint_mismatch:  15,
  rate_limited:          20,
  login_challenge:      18,
  custom:                5,
};

// Default TTL per signal kind. Signals decay — a 403 from 10 minutes
// ago shouldn't paralyse us now.
const DEFAULT_SIGNAL_TTL_MS: Record<SignalKind, number> = {
  http_block:            5 * 60 * 1000,  // 5 min
  ip_block:              10 * 60 * 1000, // 10 min
  captcha:                8 * 60 * 1000, // 8 min
  latency_spike:          2 * 60 * 1000, // 2 min
  fingerprint_mismatch:  3 * 60 * 1000, // 3 min
  rate_limited:           3 * 60 * 1000, // 3 min
  login_challenge:        5 * 60 * 1000, // 5 min
  custom:                 2 * 60 * 1000, // 2 min
};

// Cap on the in-memory signal queue. Keeps memory bounded even under
// sustained attack-style bursts.
const MAX_SIGNAL_QUEUE = 200;

// Stealth budget (token bucket). Capacity / refill rate depend on the
// current stealth level — when elevated, the budget refills slower so
// risky actions are throttled more aggressively.
const DEFAULT_BUDGET = {
  normalCapacity: 50,
  normalRefillPerMin: 30,
  elevatedCapacity: 20,
  elevatedRefillPerMin: 8,
  maximumCapacity: 5,
  maximumRefillPerMin: 2,
};

// Decoy traffic — disabled by default. When enabled, fires a request
// to a benign public endpoint (icanhazip, example.com) at randomised
// intervals to mask the bot's primary request pattern.
const DEFAULT_DECOY = {
  enabled: false,
  minIntervalMs: 90 * 1000,   // 1.5 min
  maxIntervalMs: 7 * 60 * 1000, // 7 min
  endpoints: [
    'https://icanhazip.com/',
    'https://example.com/',
    'https://www.cloudflare.com/cdn-cgi/trace',
  ],
  timeoutMs: 8000,
};

// Built-in fingerprint profiles. These mirror the two profiles in
// utils-user-agent.ts so we keep UA + viewport + sec-ch-ua + timezone
// coherent — the most common bot-detection signal is a UA that
// doesn't match its declared platform or timezone.
const FINGERPRINT_PROFILES: FingerprintProfile[] = [
  {
    name: 'chrome-windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    screen: { width: 1920, height: 1080 },
    platform: 'Windows',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"Windows"',
    prefersDark: false,
    reducedMotion: 'no-preference',
    timezone: 'Africa/Johannesburg',
    locale: 'en-ZA',
  },
  {
    name: 'chrome-macos',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    screen: { width: 2560, height: 1440 },
    platform: 'Mac',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"macOS"',
    prefersDark: false,
    reducedMotion: 'no-preference',
    timezone: 'Africa/Johannesburg',
    locale: 'en-ZA',
  },
  {
    name: 'firefox-windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    viewport: { width: 1366, height: 768 },
    screen: { width: 1920, height: 1080 },
    platform: 'Windows',
    secChUa: '',
    secChUaPlatform: '"Windows"',
    prefersDark: false,
    reducedMotion: 'no-preference',
    timezone: 'Africa/Johannesburg',
    locale: 'en-ZA',
  },
];

// ─── State ─────────────────────────────────────────────────────────────────

let _started = false;
let _level: StealthLevel = 'NORMAL';
let _signals: DetectionSignal[] = [];
let _fingerprint: FingerprintProfile = FINGERPRINT_PROFILES[0];
let _lastFingerprintRotation = 0;

// Token-bucket state
let _budgetTokens = DEFAULT_BUDGET.normalCapacity;
let _lastBudgetRefill = Date.now();

// Decoy traffic
let _decoyTimer: any = null;
let _decoyTrafficActive = false;

// Decay sweep timer
let _decayTimer: any = null;
const DECAY_INTERVAL_MS = 30 * 1000; // every 30s

// Listeners
const _levelListeners: LevelChangeListener[] = [];

// Diagnostic counters (never reset except by explicit reset())
let _totalSignalsReceived = 0;
let _totalBudgetRefusals = 0;
let _lastEscalation: number | null = null;
let _lastRelaxation: number | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────

function _now(): number { return Date.now(); }

function _clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function _pickWeighted<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function _resolveThresholds(): typeof DEFAULT_THRESHOLDS {
  const cfg = getCONFIG();
  const overrides = cfg.STEALTH_THRESHOLDS;
  if (!overrides || typeof overrides !== 'object') return DEFAULT_THRESHOLDS;
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

function _resolveSignalWeight(kind: SignalKind, override?: number): number {
  if (typeof override === 'number' && override >= 0) return override;
  const cfg = getCONFIG();
  const cfgWeights = cfg.STEALTH_SIGNAL_WEIGHTS;
  if (cfgWeights && typeof cfgWeights[kind] === 'number') {
    return cfgWeights[kind];
  }
  return DEFAULT_SIGNAL_WEIGHTS[kind] ?? 5;
}

function _resolveSignalTtl(kind: SignalKind, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const cfg = getCONFIG();
  const cfgTtls = cfg.STEALTH_SIGNAL_TTL_MS;
  if (cfgTtls && typeof cfgTtls[kind] === 'number') {
    return cfgTtls[kind];
  }
  return DEFAULT_SIGNAL_TTL_MS[kind] ?? 2 * 60 * 1000;
}

function _resolveBudget(): typeof DEFAULT_BUDGET {
  const cfg = getCONFIG();
  const overrides = cfg.STEALTH_BUDGET;
  if (!overrides || typeof overrides !== 'object') return DEFAULT_BUDGET;
  return { ...DEFAULT_BUDGET, ...overrides };
}

function _resolveDecoy(): typeof DEFAULT_DECOY {
  const cfg = getCONFIG();
  const overrides = cfg.STEALTH_DECOY;
  if (!overrides || typeof overrides !== 'object') return DEFAULT_DECOY;
  return { ...DEFAULT_DECOY, ...overrides };
}

// ─── Signal decay & risk scoring ──────────────────────────────────────────

/**
 * Drop expired signals from the queue. Called periodically by the decay
 * timer and inline before any risk computation.
 */
function _pruneExpiredSignals(): void {
  const now = _now();
  const before = _signals.length;
  _signals = _signals.filter(s => (now - s.timestamp) < s.ttlMs);
  if (_signals.length !== before) {
    log(`Pruned ${before - _signals.length} expired signal(s); ${_signals.length} remain`, 'DEBUG');
  }
}

/**
 * Compute the current risk assessment from the live signal queue.
 * Returns the risk score (0-100) and the highest-contributing signal.
 * Score is the sum of all signal weights (each scaled by remaining
 * TTL fraction so freshly-reported signals count fully and old ones
 * fade out smoothly), clamped to 100.
 */
function _computeRiskAssessment(): { score: number; top: DetectionSignal | null } {
  _pruneExpiredSignals();
  const now = _now();
  let score = 0;
  let topSignal: DetectionSignal | null = null;
  let topContribution = 0;
  for (const s of _signals) {
    const ageRatio = (now - s.timestamp) / s.ttlMs; // 0 = fresh, 1 = expired
    const fade = Math.max(0, 1 - ageRatio);          // linear fade
    const contribution = s.weight * fade;
    score += contribution;
    if (contribution > topContribution) {
      topContribution = contribution;
      topSignal = s;
    }
  }
  return { score: _clamp(Math.round(score), 0, 100), top: topSignal };
}

// Public: just the score (0-100).
function getRiskScore(): number {
  return _computeRiskAssessment().score;
}

/**
 * Decide the level the bot SHOULD be in given the current risk score,
 * without applying it. Pure function — no side effects.
 */
function _computeDesiredLevel(riskScore: number): StealthLevel {
  const t = _resolveThresholds();
  if (riskScore >= t.escalateToMaximum) return 'MAXIMUM';
  if (riskScore >= t.escalateToElevated) return 'ELEVATED';
  if (_level === 'MAXIMUM' && riskScore > t.relaxToElevated) return 'MAXIMUM';
  if (_level === 'ELEVATED' && riskScore > t.relaxToNormal) return 'ELEVATED';
  return 'NORMAL';
}

function _levelRank(level: StealthLevel): number {
  // Index in STEALTH_LEVELS = severity rank. NORMAL=0, ELEVATED=1, MAXIMUM=2.
  // We use indexOf rather than lexicographic comparison because string
  // comparison would put 'MAXIMUM' < 'NORMAL' (M < N) which inverts the
  // escalation / relaxation semantics.
  return STEALTH_LEVELS.indexOf(level);
}

/**
 * Apply a level transition, firing listeners. No-op if level unchanged.
 */
function _applyLevelTransition(desired: StealthLevel): void {
  if (desired === _level) return;
  const prev = _level;
  _level = desired;
  const assessment = _computeRiskAssessment();
  const risk = assessment.score;
  const topSignal = assessment.top;
  const escalated = _levelRank(desired) > _levelRank(prev);
  const ctx: EscalationContext = {
    reason: escalated
      ? `Risk score ${risk} crossed escalation threshold to ${desired}`
      : `Risk score ${risk} decayed below relaxation threshold to ${desired}`,
    riskScore: risk,
    topSignal: topSignal ? topSignal.kind : null,
    timestamp: _now(),
  };
  if (escalated) {
    _lastEscalation = ctx.timestamp;
    log(`⬆️  Stealth level ${prev} → ${desired} (risk=${risk}, top=${ctx.topSignal})`, 'WARN');
  } else {
    _lastRelaxation = ctx.timestamp;
    log(`⬇️  Stealth level ${prev} → ${desired} (risk=${risk})`, 'INFO');
  }
  // Fire listeners defensively — a buggy listener must not break us.
  for (const l of _levelListeners.slice()) {
    try { l.fn(desired, prev, ctx); }
    catch (err) { logError(`Level listener "${l.id}" threw`, err); }
  }
}

/**
 * Public entry: recompute risk, transition level if needed. Safe to
 * call as often as desired — cheap (signal prune + sum + comparison).
 */
function reevaluate(): StealthLevel {
  const risk = getRiskScore();
  const desired = _computeDesiredLevel(risk);
  _applyLevelTransition(desired);
  return _level;
}

// ─── Detection signal API ─────────────────────────────────────────────────

/**
 * Report a detection signal. Other modules call this when they observe
 * something suspicious (HTTP block, CAPTCHA, IP block, latency spike, ...).
 *
 * @param kind     Signal category — see SignalKind.
 * @param source   Module name reporting the signal (for diagnostics).
 * @param detail   Optional free-form context (URL, status code, ...).
 * @param weight   Optional override for the signal's risk contribution.
 * @param ttlMs    Optional override for the signal's lifetime.
 */
function reportSignal(
  kind: SignalKind,
  source: string,
  detail?: string,
  weight?: number,
  ttlMs?: number,
): void {
  const signal: DetectionSignal = {
    kind,
    weight: _resolveSignalWeight(kind, weight),
    timestamp: _now(),
    source: source || 'unknown',
    detail,
    ttlMs: _resolveSignalTtl(kind, ttlMs),
  };
  _signals.push(signal);
  _totalSignalsReceived++;
  // Bound the queue — if we're being flooded, drop the oldest.
  if (_signals.length > MAX_SIGNAL_QUEUE) {
    _signals.splice(0, _signals.length - MAX_SIGNAL_QUEUE);
    log(`Signal queue overflowed ${MAX_SIGNAL_QUEUE}; dropped oldest`, 'WARN');
  }
  log(`Signal +1: kind=${kind} weight=${signal.weight} source=${source}${detail ? ` detail="${detail.slice(0, 80)}"` : ''}`, 'DEBUG');
  // Immediately re-evaluate — a single big signal can flip us to MAXIMUM
  // and we want that to happen now, not on the next 30s tick.
  reevaluate();
}

/**
 * Manually clear signals of a specific kind (e.g. after a successful
 * recovery action). Use sparingly — signal decay is the normal path.
 */
function clearSignals(kind?: SignalKind): number {
  if (!kind) {
    const n = _signals.length;
    _signals = [];
    log(`Cleared all ${n} signal(s)`, 'INFO');
    reevaluate();
    return n;
  }
  const before = _signals.length;
  _signals = _signals.filter(s => s.kind !== kind);
  const cleared = before - _signals.length;
  if (cleared > 0) log(`Cleared ${cleared} signal(s) of kind=${kind}`, 'INFO');
  reevaluate();
  return cleared;
}

function getSignals(): DetectionSignal[] {
  _pruneExpiredSignals();
  return _signals.slice();
}

// ─── Level access & listeners ────────────────────────────────────────────

function getLevel(): StealthLevel { return _level; }

function isNormal(): boolean  { return _level === 'NORMAL'; }
function isElevated(): boolean { return _level === 'ELEVATED'; }
function isMaximum(): boolean { return _level === 'MAXIMUM'; }

/**
 * Register a listener that fires whenever the stealth level changes.
 * Returns an unsubscribe function. Listeners fire on the same tick as
 * the transition (synchronous), so they must be fast.
 */
function onLevelChange(id: string, fn: LevelChangeListener['fn']): () => void {
  if (!id || typeof fn !== 'function') {
    log('onLevelChange: ignoring invalid listener (missing id or fn)', 'WARN');
    return () => {};
  }
  // Don't double-register the same id.
  const existing = _levelListeners.findIndex(l => l.id === id);
  if (existing >= 0) _levelListeners.splice(existing, 1);
  _levelListeners.push({ id, fn });
  return () => {
    const idx = _levelListeners.findIndex(l => l.id === id);
    if (idx >= 0) _levelListeners.splice(idx, 1);
  };
}

// ─── Stealth budget (token bucket) ───────────────────────────────────────

/**
 * Refill the token bucket based on time elapsed since the last refill.
 * Refill rate depends on current level — higher level = slower refill.
 */
function _refillBudget(): void {
  const budget = _resolveBudget();
  const capacity = _level === 'NORMAL' ? budget.normalCapacity
                : _level === 'ELEVATED' ? budget.elevatedCapacity
                : budget.maximumCapacity;
  const refillPerMin = _level === 'NORMAL' ? budget.normalRefillPerMin
                     : _level === 'ELEVATED' ? budget.elevatedRefillPerMin
                     : budget.maximumRefillPerMin;
  const now = _now();
  const elapsedMin = (now - _lastBudgetRefill) / 60000;
  const refill = elapsedMin * refillPerMin;
  if (refill > 0) {
    _budgetTokens = Math.min(capacity, _budgetTokens + refill);
    _lastBudgetRefill = now;
  }
}

/**
 * Consume `tokens` from the stealth budget. Returns true if the budget
 * had enough tokens (which are then deducted), false if it didn't
 * (caller should defer or fall back to a cheaper action).
 *
 * Pass tokens=0 to peek without consuming.
 */
function consumeBudget(tokens: number = 1, reason?: string): boolean {
  _refillBudget();
  if (_budgetTokens < tokens) {
    _totalBudgetRefusals++;
    log(`Budget refused: asked=${tokens} have=${_budgetTokens.toFixed(2)}${reason ? ` reason=${reason}` : ''}`, 'DEBUG');
    return false;
  }
  _budgetTokens -= tokens;
  log(`Budget spent: ${tokens} (have=${_budgetTokens.toFixed(2)}${reason ? ` reason=${reason}` : ''})`, 'DEBUG');
  return true;
}

function getBudgetStatus(): { tokens: number; capacity: number; refillPerMin: number } {
  _refillBudget();
  const budget = _resolveBudget();
  const capacity = _level === 'NORMAL' ? budget.normalCapacity
                : _level === 'ELEVATED' ? budget.elevatedCapacity
                : budget.maximumCapacity;
  const refillPerMin = _level === 'NORMAL' ? budget.normalRefillPerMin
                     : _level === 'ELEVATED' ? budget.elevatedRefillPerMin
                     : budget.maximumRefillPerMin;
  return { tokens: _budgetTokens, capacity, refillPerMin };
}

// ─── Timing jitter ────────────────────────────────────────────────────────

/**
 * Returns a human-like delay (ms) for the current level. Higher levels
 * produce longer, more variable delays. Use to spread out automated
 * actions so they don't form a robotic pattern.
 *
 *   base    — centre of the distribution (ms)
 *   spread  — ± fraction of base (0.0-1.0); default 0.3
 *
 * Example: jitterDelay(800, 0.3) at NORMAL → ~560-1040ms
 *                       at MAXIMUM → ~1.4x base + 500ms floor + wider spread
 */
function jitterDelay(base: number, spread: number = 0.3): number {
  if (base < 0) base = 0;
  if (spread < 0) spread = 0;
  if (spread > 1) spread = 1;
  // Level multiplier: NORMAL=1.0, ELEVATED=1.4, MAXIMUM=2.0
  const levelMult = _level === 'NORMAL' ? 1.0 : _level === 'ELEVATED' ? 1.4 : 2.0;
  const levelFloor = _level === 'NORMAL' ? 0 : _level === 'ELEVATED' ? 200 : 500;
  const adj = base * levelMult + levelFloor;
  const jitter = adj * spread * (Math.random() * 2 - 1); // -spread..+spread
  return Math.max(0, Math.round(adj + jitter));
}

/**
 * Convenience: sleep for a jittered duration. Use around actions that
 * would otherwise fire at a fixed cadence (cycle iterations, retries,
 * form submissions).
 */
async function jitterSleep(base: number, spread: number = 0.3): Promise<number> {
  const ms = jitterDelay(base, spread);
  try {
    const { sleep } = require('./utils-sleep');
    await sleep(ms);
  } catch (err) {
    // utils-sleep should always be available, but fall back gracefully.
    logError('jitterSleep: utils-sleep unavailable, using setTimeout fallback', err);
    await new Promise<void>(r => setTimeout(r, ms));
  }
  return ms;
}

/**
 * Returns a small randomised integer offset (e.g. for pixel coordinates
 * or click positions) so the bot doesn't always click the exact centre
 * of an element. Negative or positive.
 */
function jitterValue(value: number, maxDelta: number = 3): number {
  if (maxDelta < 0) maxDelta = 0;
  const delta = Math.round((Math.random() * 2 - 1) * maxDelta);
  return value + delta;
}

// ─── Decoy traffic ────────────────────────────────────────────────────────

/**
 * Issue a single decoy request to a benign public endpoint. The point
 * is not the response — it's to break up the bot's otherwise
 * single-target request stream. Errors are swallowed silently.
 */
async function _issueDecoyRequest(): Promise<void> {
  const cfg = _resolveDecoy();
  if (!cfg.endpoints || cfg.endpoints.length === 0) return;
  const url = _pickWeighted(cfg.endpoints);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': _fingerprint.userAgent },
    });
    clearTimeout(timer);
    log(`Decoy request sent → ${url}`, 'DEBUG');
  } catch (err) {
    // Decoy failures are completely expected and uninteresting.
    log(`Decoy request to ${url} failed (ignored)`, 'DEBUG');
  }
}

/**
 * Schedule the next decoy request at a randomised interval.
 */
function _scheduleNextDecoy(): void {
  if (!_decoyTrafficActive) return;
  const cfg = _resolveDecoy();
  const delay = cfg.minIntervalMs + Math.random() * (cfg.maxIntervalMs - cfg.minIntervalMs);
  _decoyTimer = setTimeout(async () => {
    if (!_decoyTrafficActive) return;
    await _issueDecoyRequest();
    _scheduleNextDecoy();
  }, delay);
  if (_decoyTimer?.unref) _decoyTimer.unref();
}

function startDecoyTraffic(): void {
  const cfg = _resolveDecoy();
  if (!cfg.enabled) {
    log('Decoy traffic disabled by config (STEALTH_DECOY.enabled=false)', 'DEBUG');
    return;
  }
  if (_decoyTrafficActive) return;
  _decoyTrafficActive = true;
  log(`Decoy traffic started (interval ${cfg.minIntervalMs}-${cfg.maxIntervalMs}ms, ${cfg.endpoints.length} endpoints)`, 'INFO');
  _scheduleNextDecoy();
}

function stopDecoyTraffic(): void {
  if (!_decoyTrafficActive) return;
  _decoyTrafficActive = false;
  if (_decoyTimer) { clearTimeout(_decoyTimer); _decoyTimer = null; }
  log('Decoy traffic stopped', 'INFO');
}

// ─── Fingerprint coherence ───────────────────────────────────────────────

/**
 * Returns the active fingerprint profile. Other modules (browser.ts,
 * utils-user-agent) SHOULD consult this rather than picking their own
 * UA ad-hoc, so UA + viewport + sec-ch-ua + timezone stay coherent.
 */
function getCurrentFingerprint(): FingerprintProfile {
  return _fingerprint;
}

/**
 * Rotate to a different fingerprint profile. Picks one at random,
 * avoiding the current one (if possible). On MAXIMUM level we rotate
 * more aggressively (caller may pass force=true after a confirmed
 * fingerprint_mismatch signal).
 *
 * Returns the new profile.
 */
function rotateFingerprint(force: boolean = false): FingerprintProfile {
  // Throttle rotations — don't churn the fingerprint on every call.
  const now = _now();
  const minRotationGapMs = _level === 'MAXIMUM' ? 30 * 1000 : 5 * 60 * 1000;
  if (!force && (now - _lastFingerprintRotation) < minRotationGapMs) {
    log(`Fingerprint rotation skipped (too soon, last=${new Date(_lastFingerprintRotation).toISOString()})`, 'DEBUG');
    return _fingerprint;
  }
  const candidates = FINGERPRINT_PROFILES.filter(p => p.name !== _fingerprint.name);
  const next = candidates.length > 0 ? _pickWeighted(candidates) : _fingerprint;
  const prev = _fingerprint;
  _fingerprint = next;
  _lastFingerprintRotation = now;
  log(`Fingerprint rotated: ${prev.name} → ${next.name}${force ? ' (forced)' : ''}`, 'INFO');
  return _fingerprint;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Periodic sweep: prune expired signals and re-evaluate level.
 */
function _decayTick(): void {
  try {
    reevaluate();
  } catch (err) {
    logError('Decay tick threw (best-effort recovery)', err);
  }
}

/**
 * Start stealth operations. Idempotent — safe to call multiple times.
 * Wires up the decay sweep and (optionally) decoy traffic.
 */
function start(): void {
  if (_started) return;
  _started = true;
  log('Stealth operations started', 'INFO');

  // Decay sweep — prunes expired signals and re-evaluates level.
  if (_decayTimer) clearInterval(_decayTimer);
  _decayTimer = setInterval(_decayTick, DECAY_INTERVAL_MS);
  if (_decayTimer.unref) _decayTimer.unref();

  // Initial budget refill timestamp so we don't double-count the gap
  // between module load and start().
  _lastBudgetRefill = _now();

  // Decoy traffic is opt-in via config.
  startDecoyTraffic();
}

/**
 * Stop stealth operations. Cancels all timers. Idempotent.
 */
function stop(): void {
  if (!_started) return;
  _started = false;
  if (_decayTimer) { clearInterval(_decayTimer); _decayTimer = null; }
  stopDecoyTraffic();
  log('Stealth operations stopped', 'INFO');
}

/**
 * Reset all state: clear signals, reset budget, drop back to NORMAL,
 * reset diagnostic counters. Does NOT remove listeners (callers may
 * want to keep them across a reset). Useful for tests and for
 * operator-initiated "fresh start" from the dashboard.
 */
function reset(): void {
  const signalsCleared = _signals.length;
  _signals = [];
  _level = 'NORMAL';
  _budgetTokens = _resolveBudget().normalCapacity;
  _lastBudgetRefill = _now();
  _totalSignalsReceived = 0;
  _totalBudgetRefusals = 0;
  _lastEscalation = null;
  _lastRelaxation = null;
  log(`Stealth state reset (${signalsCleared} signal(s) dropped, level=NORMAL, budget refilled)`, 'INFO');
}

/**
 * Full diagnostic snapshot for the dashboard and for tests.
 */
function getStatus(): StealthStatus {
  _pruneExpiredSignals();
  _refillBudget();
  const budget = getBudgetStatus();
  return {
    level: _level,
    riskScore: getRiskScore(),
    signalCount: _signals.length,
    budgetTokens: Math.round(_budgetTokens * 100) / 100,
    budgetCapacity: budget.capacity,
    decoyTrafficActive: _decoyTrafficActive,
    fingerprintName: _fingerprint.name,
    started: _started,
    lastEscalation: _lastEscalation,
    lastRelaxation: _lastRelaxation,
    totalSignalsReceived: _totalSignalsReceived,
    totalBudgetRefusals: _totalBudgetRefusals,
  };
}

// ─── Self-test ────────────────────────────────────────────────────────────

/**
 * Lightweight self-test. Returns true if all internal invariants hold.
 * Called by self-heal-meta-self-test and by the dashboard's health page.
 */
function selfTest(): { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // 1. Level is a known value.
  checks.push({
    name: 'level_valid',
    ok: STEALTH_LEVELS.includes(_level),
    detail: `level=${_level}`,
  });

  // 2. Budget tokens non-negative and ≤ capacity.
  const budget = getBudgetStatus();
  checks.push({
    name: 'budget_in_range',
    ok: _budgetTokens >= 0 && _budgetTokens <= budget.capacity + 0.001,
    detail: `tokens=${_budgetTokens.toFixed(2)} capacity=${budget.capacity}`,
  });

  // 3. Fingerprint is one of the known profiles.
  checks.push({
    name: 'fingerprint_known',
    ok: FINGERPRINT_PROFILES.some(p => p.name === _fingerprint.name),
    detail: `fingerprint=${_fingerprint.name}`,
  });

  // 4. Risk score in [0,100].
  const risk = getRiskScore();
  checks.push({
    name: 'risk_in_range',
    ok: risk >= 0 && risk <= 100,
    detail: `risk=${risk}`,
  });

  // 5. Signal queue bounded.
  checks.push({
    name: 'queue_bounded',
    ok: _signals.length <= MAX_SIGNAL_QUEUE,
    detail: `len=${_signals.length} cap=${MAX_SIGNAL_QUEUE}`,
  });

  // 6. Listeners are all callable.
  const badListeners = _levelListeners.filter(l => typeof l.fn !== 'function');
  checks.push({
    name: 'listeners_callable',
    ok: badListeners.length === 0,
    detail: badListeners.length > 0 ? `bad=${badListeners.map(l => l.id).join(',')}` : `count=${_levelListeners.length}`,
  });

  return { ok: checks.every(c => c.ok), checks };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  _injectDependencies,

  // Lifecycle
  start,
  stop,
  reset,
  selfTest,

  // Level
  getLevel,
  isNormal,
  isElevated,
  isMaximum,
  reevaluate,
  onLevelChange,

  // Signals
  reportSignal,
  clearSignals,
  getSignals,
  getRiskScore,

  // Budget
  consumeBudget,
  getBudgetStatus,

  // Jitter
  jitterDelay,
  jitterSleep,
  jitterValue,

  // Fingerprint
  getCurrentFingerprint,
  rotateFingerprint,

  // Decoy
  startDecoyTraffic,
  stopDecoyTraffic,

  // Diagnostics
  getStatus,

  // Constants (exposed for tests / config validation)
  STEALTH_LEVELS,
  FINGERPRINT_PROFILES,
};
