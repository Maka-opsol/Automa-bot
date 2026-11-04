'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Normalcy Engine — Behavioral Mimicry & Drift Detection
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose:
//   stealth-operations.ts is REACTIVE — it watches for detection signals
//   and scales behaviour when the bot looks suspicious. normalcy.ts is
//   PROACTIVE — it models what a "normal human student" on MathU looks
//   like, suggests the next human-like behaviour, and flags when the
//   bot is drifting away from that baseline.
//
//   The question this module answers: "Would a real Grade-12 student
//   working through MathU at 7pm on a Tuesday behave the way the bot
//   is behaving right now?"
//
//   Concretely, it tracks and suggests:
//
//     1. Pace — actions per minute vs a human baseline (too fast = bot,
//        too slow = stuck). Generates a 0-100 "naturalness" score.
//     2. Dwell time — how long the bot lingers on each page. Real
//        students read the problem, glance at the score screen, scroll
//        through the assignments list. The bot tends to dive straight
//        for the next actionable element.
//     3. Session rhythm — total session length, time since last break,
//        time until next break. Real students take a 5-min break every
//        20-30 min. An hour-long no-breaks streak is a red flag.
//     4. Circadian phase — a real student at 3am doesn't blast through
//        40 tasks. Within the broader work-shift window (handled by
//        services-work-shifts.ts), normalcy tracks the within-shift
//        "energy curve" (peaks ~10am and ~7pm, dips after lunch).
//     5. Page sequence naturalness — login → assignments → task → task
//        → task → logout is robotic. Real users wander: they look at
//        the assignments list, click into one, go back, scroll a bit,
//        check the score screen, come back. The bot's navigation graph
//        is monitored; when it's too linear, a "wander" suggestion is
//        emitted.
//     6. Idle injection — periodically the bot should just sit there
//        for 10-60s, like a student reading or thinking. Idles are
//        scheduled, not random — they fire after N actions or M
//        minutes, whichever comes first.
//     7. Behaviour suggestion — `suggestBehavior()` returns the next
//        "human-like" thing the bot should consider doing (real action,
//        idle, scroll, wander, take-a-break, end-session). The cycle
//        manager mixes these suggestions with its actual work plan.
//
// Integration points (who calls what):
//   - cycle-cycle-manager.ts  → start() at boot, calls suggestBehavior()
//                                each iteration, calls recordAction()
//                                after every action
//   - cycle-action-executor   → calls recordAction(actionType) after each
//                                click/submit; consults shouldIdleNow()
//                                before each action
//   - cycle-cycle-manager.ts  → calls recordPageVisit(url) on each
//                                navigation; calls getNaturalnessScore()
//                                and includes it in the cycle log
//   - services-work-shifts    → fires onShiftChange listener to reset
//                                the session rhythm baseline when
//                                entering ACTIVE shift
//   - stealth-operations      → fires onLevelChange listener; at
//                                MAXIMUM, normalcy widens its idle
//                                durations and shortens work bursts
//   - dashboard-server        → reads getStatus() and
//                                getUpcomingSuggestions() for the UI
//
// Design rules:
//   - All external calls wrapped in try/catch. Normalcy must NEVER
//     crash the bot — a broken normalcy module makes the bot MORE
//     obvious, not less.
//   - All timers use .unref() so they don't keep the process alive.
//   - No top-level requires of config/logger (circular-dep safe, like
//     stealth-operations and memory-warfare).
//   - State lives in module scope (singleton).
//   - Every public function is idempotent and safe to call from any
//     state (started, stopped, mid-session).
//   - Suggestion functions are PURE: they read state, return a value,
//     and do not mutate state. The caller decides whether to act on
//     the suggestion. Recording the action (recordAction) is the
//     only way state changes.
//
// Philosophy:
//   "Normal is invisible." The most human thing the bot can do is
//   occasionally do nothing. The cycle manager's instinct is to do
//   as much as possible as fast as possible — this module's job is to
//   be the patient voice that says "slow down, look around, take a
//   break". Aggression belongs to stealth-operations (when under
//   active attack); normalcy belongs to the everyday case.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Dependency injection (lazy, circular-safe) ──────────────────────────

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps || {};
}

function getCONFIG(): Record<string, any> {
  if (_deps.config) return _deps.config;
  try { return require('./get-config'); } catch { return {}; }
}

function log(msg: string, level: string = 'INFO', mod: string = 'normalcy') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through to console */ }
  try { console.log(`[${level}] [${mod}] ${msg}`); } catch { /* nothing */ }
}

function logError(msg: string, err: any) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  try { console.error(`[ERROR] [normalcy] ${msg}`, err); } catch { /* nothing */ }
}

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * A "persona" the bot is impersonating. Different personas have
 * different pace, dwell, and break profiles. Pick one at startup;
 * rotate only if the current one feels stale (e.g. after a long
 * session, switch to a different persona to vary the pattern).
 */
interface NormalcyProfile {
  name: string;
  /** Average actions per minute when actively working. */
  targetActionsPerMin: number;
  /** Hard cap on actions per minute (above this = suspicious). */
  maxActionsPerMin: number;
  /** Min/max dwell time on a single page (ms). */
  dwellMinMs: number;
  dwellMaxMs: number;
  /** Min/max time between consecutive actions (ms). */
  interActionMinMs: number;
  interActionMaxMs: number;
  /** How often to take a break (ms of work between breaks). */
  breakEveryMs: number;
  /** How long a break lasts (ms). */
  breakDurationMinMs: number;
  breakDurationMaxMs: number;
  /** Probability [0-1] of inserting an idle pause per action. */
  idleChancePerAction: number;
  /** Idle duration range (ms). */
  idleMinMs: number;
  idleMaxMs: number;
  /** Probability of "wandering" (visiting a non-essential page). */
  wanderChancePerCycle: number;
  /** Description for logging / dashboard display. */
  description: string;
}

type ActionType =
  | 'click'
  | 'submit'
  | 'navigate'
  | 'scroll'
  | 'input'
  | 'screenshot'
  | 'vision_call'
  | 'wait'
  | 'other';

type BehaviorKind =
  | 'continue'        // proceed with the bot's planned next action
  | 'idle'             // pause for a short while (thinking/reading)
  | 'scroll'           // scroll the current page (look around)
  | 'wander'           // navigate to a non-essential page (assignments list, score screen)
  | 'take_break'       // take a longer break (5-15 min)
  | 'end_session'      // session has gone on long enough; wind down
  | 'slow_down'        // pace is too fast; insert inter-action delay
  | 'speed_up';        // pace is too slow (rare); reduce delays

interface BehaviorSuggestion {
  kind: BehaviorKind;
  /** Suggested duration in ms (for idle/scroll/break kinds). */
  durationMs?: number;
  /** Why this suggestion was made (for logging/debugging). */
  reason: string;
  /** Confidence 0-1. Lower confidence = caller may ignore. */
  confidence: number;
  /** Target page for 'wander' (URL hint, not a directive). */
  targetPage?: string;
  timestamp: number;
}

interface ActionRecord {
  type: ActionType;
  timestamp: number;
  pageUrl?: string;
  durationMs?: number; // how long the action itself took
}

interface PageVisit {
  url: string;
  /** Simplified page category (assignments/task/score/video/etc). */
  category: string;
  arrivedAt: number;
  leftAt?: number;
}

interface SessionRhythm {
  startedAt: number;
  durationMs: number;
  totalActions: number;
  actionsInLastMin: number;
  lastBreakAt: number | null;
  nextBreakInMs: number;
  pagesVisited: number;
  uniquePagesVisited: number;
}

type CircadianPhase = 'morning_ramp' | 'morning_peak' | 'lunch_dip' | 'afternoon' | 'evening_peak' | 'evening_wind_down' | 'off_hours';

interface CircadianState {
  phase: CircadianPhase;
  /** Multiplier [0.5-1.2] applied to baseline pace. Lower = slower. */
  energyMultiplier: number;
  /** True if the local clock is in the "off hours" window. */
  isOffHours: boolean;
  localHour: number;
}

type RhythmEvent =
  | 'session_start'
  | 'session_end'
  | 'break_start'
  | 'break_end'
  | 'phase_change'
  | 'idle_injected'
  | 'wander_emitted'
  | 'pace_warning';

interface RhythmEventListener {
  id: string;
  fn: (event: RhythmEvent, payload: Record<string, any>) => void;
}

interface NormalcyStatus {
  profileName: string;
  sessionActive: boolean;
  sessionStartedAt: number | null;
  sessionDurationMs: number;
  totalActions: number;
  actionsInLastMin: number;
  naturalnessScore: number;          // 0-100, higher = more human-like
  paceScore: number;                 // 0-100, 50 = ideal
  dwellScore: number;                // 0-100
  naturalnessScoreComponents: { pace: number; dwell: number; rhythm: number; sequence: number };
  circadianPhase: CircadianPhase;
  circadianEnergy: number;          // energy multiplier
  isOffHours: boolean;
  lastBreakAt: number | null;
  nextBreakInMs: number;
  pendingIdle: { active: boolean; remainingMs: number; reason: string } | null;
  totalIdlesInjected: number;
  totalBreaksTaken: number;
  totalWandersEmitted: number;
  started: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Built-in normalcy profiles. These are rough behavioural archetypes
 * derived from how a real student might use MathU. Each one is a
 * compromise between "looks human" and "still gets work done".
 */
const DEFAULT_PROFILES: NormalcyProfile[] = [
  {
    name: 'focused-student',
    description: 'Methodical, steady pace, occasional breaks. The default.',
    targetActionsPerMin: 4,
    maxActionsPerMin: 8,
    dwellMinMs: 8_000,
    dwellMaxMs: 45_000,
    interActionMinMs: 3_000,
    interActionMaxMs: 12_000,
    breakEveryMs: 25 * 60 * 1000,        // 25 min
    breakDurationMinMs: 3 * 60 * 1000,    // 3 min
    breakDurationMaxMs: 8 * 60 * 1000,    // 8 min
    idleChancePerAction: 0.15,
    idleMinMs: 8_000,
    idleMaxMs: 35_000,
    wanderChancePerCycle: 0.10,
  },
  {
    name: 'casual-browser',
    description: 'Slower, more wandering, longer dwells. Lower throughput.',
    targetActionsPerMin: 2,
    maxActionsPerMin: 5,
    dwellMinMs: 15_000,
    dwellMaxMs: 90_000,
    interActionMinMs: 6_000,
    interActionMaxMs: 25_000,
    breakEveryMs: 18 * 60 * 1000,        // 18 min
    breakDurationMinMs: 4 * 60 * 1000,    // 4 min
    breakDurationMaxMs: 12 * 60 * 1000,   // 12 min
    idleChancePerAction: 0.30,
    idleMinMs: 15_000,
    idleMaxMs: 60_000,
    wanderChancePerCycle: 0.25,
  },
  {
    name: 'crammer',
    description: 'Faster pace, shorter breaks. Use for catch-up sessions.',
    targetActionsPerMin: 6,
    maxActionsPerMin: 10,
    dwellMinMs: 5_000,
    dwellMaxMs: 30_000,
    interActionMinMs: 2_000,
    interActionMaxMs: 8_000,
    breakEveryMs: 40 * 60 * 1000,        // 40 min
    breakDurationMinMs: 2 * 60 * 1000,    // 2 min
    breakDurationMaxMs: 5 * 60 * 1000,    // 5 min
    idleChancePerAction: 0.08,
    idleMinMs: 5_000,
    idleMaxMs: 20_000,
    wanderChancePerCycle: 0.05,
  },
  {
    name: 'evening-learner',
    description: 'Relaxed evening pace, longer dwells, frequent short breaks.',
    targetActionsPerMin: 3,
    maxActionsPerMin: 6,
    dwellMinMs: 12_000,
    dwellMaxMs: 60_000,
    interActionMinMs: 5_000,
    interActionMaxMs: 18_000,
    breakEveryMs: 22 * 60 * 1000,        // 22 min
    breakDurationMinMs: 4 * 60 * 1000,    // 4 min
    breakDurationMaxMs: 10 * 60 * 1000,   // 10 min
    idleChancePerAction: 0.20,
    idleMinMs: 10_000,
    idleMaxMs: 45_000,
    wanderChancePerCycle: 0.15,
  },
];

/**
 * Circadian energy curve. Maps the local hour (0-23) to a multiplier
 * applied to the profile's targetActionsPerMin. Real students have
 * two productive peaks (~10am and ~7pm) and a sharp dip after lunch
 * (~2-3pm) and a deep trough overnight.
 *
 * The curve is independent of services-work-shifts.ts — work-shifts
 * decides WHETHER the bot runs at all; circadian decides HOW FAST
 * within a shift.
 */
const DEFAULT_CIRCADIAN: { hour: number; multiplier: number; phase: CircadianPhase }[] = [
  { hour: 0,  multiplier: 0.40, phase: 'off_hours' },
  { hour: 1,  multiplier: 0.35, phase: 'off_hours' },
  { hour: 2,  multiplier: 0.30, phase: 'off_hours' },
  { hour: 3,  multiplier: 0.30, phase: 'off_hours' },
  { hour: 4,  multiplier: 0.35, phase: 'off_hours' },
  { hour: 5,  multiplier: 0.45, phase: 'off_hours' },
  { hour: 6,  multiplier: 0.60, phase: 'morning_ramp' },
  { hour: 7,  multiplier: 0.75, phase: 'morning_ramp' },
  { hour: 8,  multiplier: 0.90, phase: 'morning_ramp' },
  { hour: 9,  multiplier: 1.00, phase: 'morning_peak' },
  { hour: 10, multiplier: 1.10, phase: 'morning_peak' },
  { hour: 11, multiplier: 1.05, phase: 'morning_peak' },
  { hour: 12, multiplier: 0.85, phase: 'lunch_dip' },
  { hour: 13, multiplier: 0.70, phase: 'lunch_dip' },
  { hour: 14, multiplier: 0.65, phase: 'lunch_dip' },
  { hour: 15, multiplier: 0.80, phase: 'afternoon' },
  { hour: 16, multiplier: 0.90, phase: 'afternoon' },
  { hour: 17, multiplier: 0.95, phase: 'afternoon' },
  { hour: 18, multiplier: 1.05, phase: 'evening_peak' },
  { hour: 19, multiplier: 1.10, phase: 'evening_peak' },
  { hour: 20, multiplier: 1.05, phase: 'evening_peak' },
  { hour: 21, multiplier: 0.95, phase: 'evening_wind_down' },
  { hour: 22, multiplier: 0.75, phase: 'evening_wind_down' },
  { hour: 23, multiplier: 0.55, phase: 'evening_wind_down' },
];

/** Hours considered "off hours" — bot should slow down dramatically. */
const DEFAULT_OFF_HOURS = { start: 0, end: 5 }; // 00:00 - 05:00

/** Maximum session length before end_session is suggested (ms). */
const DEFAULT_MAX_SESSION_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Maximum action history retained (bounded memory). */
const MAX_ACTION_HISTORY = 200;
const MAX_PAGE_HISTORY = 50;

/** Tick interval for session rhythm maintenance. */
const RHYTHM_TICK_MS = 30 * 1000; // 30s

// Page categories used for sequence naturalness analysis.
type PageCategory = 'login' | 'assignments' | 'task' | 'score' | 'video' | 'pathway' | 'other';

// ─── State ─────────────────────────────────────────────────────────────────

let _started = false;
let _profile: NormalcyProfile = DEFAULT_PROFILES[0];
let _lastProfileRotation = 0;

let _sessionActive = false;
let _sessionStartedAt: number | null = null;

let _actions: ActionRecord[] = [];
let _pages: PageVisit[] = [];
let _lastBreakAt: number | null = null;
let _breakActive = false;
let _breakEndsAt: number | null = null;

let _idleActive = false;
let _idleEndsAt: number | null = null;
let _idleReason = '';
let _totalIdlesInjected = 0;
let _totalBreaksTaken = 0;
let _totalWandersEmitted = 0;

let _rhythmTimer: any = null;
let _lastCircadianPhase: CircadianPhase | null = null;

const _rhythmListeners: RhythmEventListener[] = [];

// Diagnostic counters (never reset except by reset())
let _totalActionsRecorded = 0;
let _totalPaceWarnings = 0;
let _lastNaturalnessScore = 50;
let _lastPaceScore = 50;
let _lastDwellScore = 50;
let _lastSequenceScore = 50;

// Stealth-operations coupling (optional). When stealth level rises to
// MAXIMUM, normalcy widens its idle durations and shortens work bursts.
let _stealthLevelCache: 'NORMAL' | 'ELEVATED' | 'MAXIMUM' = 'NORMAL';

// ─── Helpers ──────────────────────────────────────────────────────────────

function _now(): number { return Date.now(); }

function _clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function _randRange(min: number, max: number): number {
  if (max < min) [min, max] = [max, min];
  return min + Math.random() * (max - min);
}

function _pickWeighted<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function _resolveProfiles(): NormalcyProfile[] {
  const cfg = getCONFIG();
  if (Array.isArray(cfg.NORMALCY_PROFILES) && cfg.NORMALCY_PROFILES.length > 0) {
    return cfg.NORMALCY_PROFILES;
  }
  return DEFAULT_PROFILES;
}

function _resolveOffHours(): { start: number; end: number } {
  const cfg = getCONFIG();
  if (cfg.NORMALCY_OFF_HOURS && typeof cfg.NORMALCY_OFF_HOURS === 'object') {
    return { ...DEFAULT_OFF_HOURS, ...cfg.NORMALCY_OFF_HOURS };
  }
  return DEFAULT_OFF_HOURS;
}

function _resolveMaxSessionMs(): number {
  const cfg = getCONFIG();
  const v = cfg.NORMALCY_MAX_SESSION_MS;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_SESSION_MS;
}

function _getLocalHour(): number {
  // User timezone is Africa/Johannesburg (SAST, UTC+2). If the host
  // clock is in a different tz, we still want local SAST hour so the
  // circadian curve lines up with the user's actual day.
  try {
    const now = new Date();
    const sast = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
    return sast.getHours();
  } catch {
    return new Date().getHours();
  }
}

function _categorizeUrl(url: string): PageCategory {
  if (!url) return 'other';
  const u = url.toLowerCase();
  if (u.includes('login') || u.includes('signin') || u.includes('auth')) return 'login';
  if (u.includes('assignment')) return 'assignments';
  if (u.includes('task') || u.includes('assessment') || u.includes('exercise')) return 'task';
  if (u.includes('score') || u.includes('result')) return 'score';
  if (u.includes('video') || u.includes('player')) return 'video';
  if (u.includes('pathway')) return 'pathway';
  return 'other';
}

// ─── Circadian awareness ─────────────────────────────────────────────────

function _getCircadianRow(hour: number): { multiplier: number; phase: CircadianPhase } {
  // Find the matching hour row (handles wraps if 0).
  for (const row of DEFAULT_CIRCADIAN) {
    if (row.hour === hour) {
      return { multiplier: row.multiplier, phase: row.phase };
    }
  }
  // Fallback: scale linearly from 1.0 at noon.
  return { multiplier: 0.8, phase: 'afternoon' };
}

function _isInOffHours(hour: number): boolean {
  const oh = _resolveOffHours();
  if (oh.start <= oh.end) {
    return hour >= oh.start && hour < oh.end;
  }
  // Wrap-around window (e.g. 22 → 5)
  return hour >= oh.start || hour < oh.end;
}

function getCircadian(): CircadianState {
  const hour = _getLocalHour();
  const { multiplier, phase } = _getCircadianRow(hour);
  return {
    phase,
    energyMultiplier: multiplier,
    isOffHours: _isInOffHours(hour),
    localHour: hour,
  };
}

function isOffHours(): boolean {
  return _isInOffHours(_getLocalHour());
}

// ─── Pace tracking ────────────────────────────────────────────────────────

/**
 * Count actions recorded in the last `windowMs` (default 60s).
 */
function _countActionsInWindow(windowMs: number = 60_000): number {
  const cutoff = _now() - windowMs;
  return _actions.filter(a => a.timestamp >= cutoff).length;
}

/**
 * Pace score: 0-100, where 50 = perfectly on-target.
 *   <50 = too slow (sluggish, possibly stuck)
 *   >50 = too fast (robotic)
 *   50 = exactly target pace
 *
 * The mapping is: pace = targetActionsPerMin * circadianEnergy * stealthFactor
 * Score = 50 + 50 * (target - actual) / target, clamped to [0,100]
 */
function getPaceScore(): number {
  const circadian = getCircadian();
  const stealthFactor = _stealthLevelCache === 'MAXIMUM' ? 0.5
                     : _stealthLevelCache === 'ELEVATED' ? 0.75
                     : 1.0;
  const target = _profile.targetActionsPerMin * circadian.energyMultiplier * stealthFactor;
  const actual = _countActionsInWindow(60_000);
  if (target <= 0) return 50;
  const deviation = (target - actual) / target; // +ve = too slow, -ve = too fast
  const score = 50 + 50 * deviation;
  return _clamp(Math.round(score), 0, 100);
}

/**
 * Returns "too_fast" / "too_slow" / "on_target" based on pace score.
 */
function getPaceStatus(): 'too_fast' | 'too_slow' | 'on_target' {
  const s = getPaceScore();
  if (s < 30) return 'too_fast';
  if (s > 70) return 'too_slow';
  return 'on_target';
}

// ─── Dwell tracking ───────────────────────────────────────────────────────

/**
 * Dwell score: 0-100, where higher = more human-like dwell pattern.
 * Penalised if the bot spends <dwellMinMs on a page (too rushed) or
 * >3x dwellMaxMs (stuck). Computed over the last 5 page visits.
 */
function getDwellScore(): number {
  if (_pages.length === 0) return 50;
  const recent = _pages.slice(-5);
  let score = 0;
  let counted = 0;
  for (const p of recent) {
    if (p.leftAt == null) continue;
    const dwell = p.leftAt - p.arrivedAt;
    if (dwell < _profile.dwellMinMs) {
      // Too rushed: penalise.
      score += 20;
    } else if (dwell > _profile.dwellMaxMs * 3) {
      // Stuck: moderate penalty.
      score += 40;
    } else if (dwell >= _profile.dwellMinMs && dwell <= _profile.dwellMaxMs) {
      // Ideal range.
      score += 100;
    } else {
      // Slightly off — partial credit.
      score += 70;
    }
    counted++;
  }
  if (counted === 0) return 50;
  return _clamp(Math.round(score / counted), 0, 100);
}

// ─── Sequence naturalness ────────────────────────────────────────────────

/**
 * Sequence naturalness: 0-100. Penalises overly-linear page sequences.
 * A real user's navigation has revisits, backtracks, and wander.
 * A perfect "login → assignments → task → task → task → task" run
 * scores LOW because it's too efficient.
 */
function getSequenceScore(): number {
  if (_pages.length < 4) return 75; // not enough data — assume OK
  const recent = _pages.slice(-10);
  const cats = recent.map(p => p.category);

  // Count unique categories visited
  const unique = new Set(cats).size;
  const uniqueRatio = unique / cats.length;

  // Count "transitions" that aren't task→task (i.e. not linear grind)
  let nonLinearTransitions = 0;
  for (let i = 1; i < cats.length; i++) {
    if (!(cats[i] === 'task' && cats[i - 1] === 'task')) {
      nonLinearTransitions++;
    }
  }
  const transitionRatio = nonLinearTransitions / (cats.length - 1);

  // Score: blend of variety + non-linearity
  // Variety should be moderate (too many = chaotic, too few = robotic)
  // Optimal uniqueRatio is around 0.4-0.6
  let varietyScore: number;
  if (uniqueRatio < 0.2) varietyScore = 30;       // too monotonous
  else if (uniqueRatio > 0.8) varietyScore = 50;  // too chaotic
  else if (uniqueRatio >= 0.4 && uniqueRatio <= 0.6) varietyScore = 100;
  else varietyScore = 70;

  // Non-linearity is good — real users backtrack/wander
  const transitionScore = _clamp(Math.round(transitionRatio * 100), 0, 100);

  return _clamp(Math.round(varietyScore * 0.5 + transitionScore * 0.5), 0, 100);
}

// ─── Naturalness (composite) ──────────────────────────────────────────────

/**
 * Composite naturalness score: 0-100. Weighted blend of pace, dwell,
 * rhythm, and sequence scores. Used by the dashboard and by callers
 * deciding whether to suggest behavioral corrections.
 */
function getNaturalnessScore(): number {
  const pace = getPaceScore();
  const dwell = getDwellScore();
  const sequence = getSequenceScore();
  // Rhythm score: are we respecting breaks?
  let rhythm = 50;
  if (_sessionActive && _lastBreakAt != null) {
    const sinceBreak = _now() - _lastBreakAt;
    if (sinceBreak > _profile.breakEveryMs * 2) rhythm = 25; // overdue
    else if (sinceBreak > _profile.breakEveryMs) rhythm = 60; // due
    else rhythm = 90; // recently rested
  } else if (!_sessionActive) {
    rhythm = 50;
  } else {
    // Session active, no break yet — give benefit of doubt early on.
    const sessionDuration = _sessionStartedAt ? _now() - _sessionStartedAt : 0;
    rhythm = sessionDuration < _profile.breakEveryMs ? 90 : 40;
  }

  _lastPaceScore = pace;
  _lastDwellScore = dwell;
  _lastSequenceScore = sequence;

  const composite = pace * 0.35 + dwell * 0.25 + rhythm * 0.20 + sequence * 0.20;
  const rounded = _clamp(Math.round(composite), 0, 100);
  _lastNaturalnessScore = rounded;
  return rounded;
}

// ─── Action recording ─────────────────────────────────────────────────────

/**
 * Record that the bot just performed an action. Callers MUST call this
 * after every action so pace and rhythm tracking stays accurate.
 *
 * Safe to call before start() — it'll just buffer the action.
 */
function recordAction(type: ActionType, pageUrl?: string, durationMs?: number): void {
  const record: ActionRecord = {
    type,
    timestamp: _now(),
    pageUrl,
    durationMs,
  };
  _actions.push(record);
  _totalActionsRecorded++;
  // Bound the queue.
  if (_actions.length > MAX_ACTION_HISTORY) {
    _actions.splice(0, _actions.length - MAX_ACTION_HISTORY);
  }

  // Auto-start session if we record an action and no session is active.
  if (!_sessionActive) _startSessionImplicit();

  // Pace warning if we're way over the limit.
  const pace = getPaceScore();
  if (pace < 20 && type !== 'wait') {
    _totalPaceWarnings++;
    log(`Pace warning: actions in last min=${_countActionsInWindow(60000)}, target=${_profile.targetActionsPerMin}, paceScore=${pace}`, 'WARN');
    _fireRhythmEvent('pace_warning', { pace, actionType: type });
  }
}

/**
 * Record a page visit. Should be called on every navigation.
 */
function recordPageVisit(url: string): void {
  if (!url) return;
  // Close out the previous page visit, if any.
  if (_pages.length > 0 && _pages[_pages.length - 1].leftAt == null) {
    _pages[_pages.length - 1].leftAt = _now();
  }
  _pages.push({
    url,
    category: _categorizeUrl(url),
    arrivedAt: _now(),
  });
  if (_pages.length > MAX_PAGE_HISTORY) {
    _pages.splice(0, _pages.length - MAX_PAGE_HISTORY);
  }
}

// ─── Session rhythm ──────────────────────────────────────────────────────

function _startSessionImplicit(): void {
  if (_sessionActive) return;
  _sessionActive = true;
  _sessionStartedAt = _now();
  _lastBreakAt = null;
  log(`Session implicitly started at ${new Date(_sessionStartedAt).toISOString()}`, 'DEBUG');
  _fireRhythmEvent('session_start', { at: _sessionStartedAt });
}

function startSession(): void {
  if (_sessionActive) {
    log('startSession called but session already active', 'DEBUG');
    return;
  }
  _startSessionImplicit();
  log(`Session started (profile=${_profile.name})`, 'INFO');
}

function endSession(): void {
  if (!_sessionActive) return;
  _sessionActive = false;
  const startedAt = _sessionStartedAt;
  _sessionStartedAt = null;
  // Close any open page visit.
  if (_pages.length > 0 && _pages[_pages.length - 1].leftAt == null) {
    _pages[_pages.length - 1].leftAt = _now();
  }
  const durationMs = startedAt ? _now() - startedAt : 0;
  log(`Session ended (duration=${Math.round(durationMs / 60000)}min, actions=${_actions.length})`, 'INFO');
  _fireRhythmEvent('session_end', { durationMs, totalActions: _actions.length });
}

function getSessionRhythm(): SessionRhythm {
  const now = _now();
  const startedAt = _sessionStartedAt ?? now;
  const durationMs = _sessionActive ? now - startedAt : 0;
  const sinceBreak = _lastBreakAt != null ? now - _lastBreakAt : durationMs;
  const nextBreakInMs = Math.max(0, _profile.breakEveryMs - sinceBreak);
  const uniquePages = new Set(_pages.map(p => p.url));
  return {
    startedAt,
    durationMs,
    totalActions: _actions.length,
    actionsInLastMin: _countActionsInWindow(60_000),
    lastBreakAt: _lastBreakAt,
    nextBreakInMs,
    pagesVisited: _pages.length,
    uniquePagesVisited: uniquePages.size,
  };
}

function shouldTakeBreak(): boolean {
  if (!_sessionActive) return false;
  if (_breakActive) return false;
  const sinceBreak = _lastBreakAt != null ? _now() - _lastBreakAt
                    : (_sessionStartedAt ? _now() - _sessionStartedAt : 0);
  return sinceBreak >= _profile.breakEveryMs;
}

function getTimeUntilBreak(): number {
  if (!_sessionActive) return Infinity;
  if (_breakActive) return 0;
  const sinceBreak = _lastBreakAt != null ? _now() - _lastBreakAt
                    : (_sessionStartedAt ? _now() - _sessionStartedAt : 0);
  return Math.max(0, _profile.breakEveryMs - sinceBreak);
}

function startBreak(): number {
  if (_breakActive) return _breakEndsAt! - _now();
  const duration = Math.round(_randRange(_profile.breakDurationMinMs, _profile.breakDurationMaxMs));
  _breakActive = true;
  _breakEndsAt = _now() + duration;
  _totalBreaksTaken++;
  log(`Break started (duration=${Math.round(duration / 1000)}s)`, 'INFO');
  _fireRhythmEvent('break_start', { durationMs: duration });
  return duration;
}

function endBreak(): void {
  if (!_breakActive) return;
  _breakActive = false;
  _breakEndsAt = null;
  _lastBreakAt = _now();
  log('Break ended', 'INFO');
  _fireRhythmEvent('break_end', { at: _lastBreakAt });
}

function isOnBreak(): boolean {
  if (!_breakActive) return false;
  if (_breakEndsAt != null && _now() >= _breakEndsAt) {
    // Auto-end expired break.
    endBreak();
    return false;
  }
  return true;
}

// ─── Idle injection ──────────────────────────────────────────────────────

/**
 * Returns true if an idle pause should be inserted before the next
 * action. Probability is per-action; influenced by stealth level
 * (more idle at higher stealth).
 */
function shouldIdleNow(): boolean {
  if (_idleActive || _breakActive) return false;
  const base = _profile.idleChancePerAction;
  const stealthBoost = _stealthLevelCache === 'MAXIMUM' ? 0.20
                     : _stealthLevelCache === 'ELEVATED' ? 0.10
                     : 0;
  const p = _clamp(base + stealthBoost, 0, 0.8);
  return Math.random() < p;
}

/**
 * Start an idle pause. Returns the duration in ms.
 */
function startIdle(reason: string = 'spontaneous'): number {
  if (_idleActive) return _idleEndsAt! - _now();
  const duration = Math.round(_randRange(_profile.idleMinMs, _profile.idleMaxMs));
  _idleActive = true;
  _idleEndsAt = _now() + duration;
  _idleReason = reason;
  _totalIdlesInjected++;
  log(`Idle injected (${Math.round(duration / 1000)}s, reason=${reason})`, 'DEBUG');
  _fireRhythmEvent('idle_injected', { durationMs: duration, reason });
  return duration;
}

function endIdle(): void {
  if (!_idleActive) return;
  _idleActive = false;
  _idleEndsAt = null;
  _idleReason = '';
}

function isIdle(): boolean {
  if (!_idleActive) return false;
  if (_idleEndsAt != null && _now() >= _idleEndsAt) {
    endIdle();
    return false;
  }
  return true;
}

function getPendingIdle(): { active: boolean; remainingMs: number; reason: string } | null {
  if (!_idleActive) return null;
  return {
    active: true,
    remainingMs: Math.max(0, (_idleEndsAt ?? 0) - _now()),
    reason: _idleReason,
  };
}

// ─── Behavior suggestion engine ───────────────────────────────────────────

/**
 * Returns the next "human-like" behavior the bot should consider. This
 * is a PURE function — it reads state, returns a suggestion, and does
 * NOT mutate state. The caller decides whether to act on it.
 *
 * Decision priority (first match wins):
 *   1. If on break → continue (caller should not perform real actions)
 *   2. If idle active → continue (caller should wait)
 *   3. If session > max → end_session
 *   4. If break overdue → take_break
 *   5. If pace too fast → slow_down (insert inter-action delay)
 *   6. If shouldIdleNow → idle
 *   7. If wanderChancePerCycle triggers → wander
 *   8. Otherwise → continue
 */
function suggestBehavior(): BehaviorSuggestion {
  const now = _now();
  const ts = { timestamp: now };

  // 1. On break — caller should wait until break ends.
  if (isOnBreak()) {
    return {
      kind: 'continue',
      reason: `On break (${Math.max(0, (_breakEndsAt ?? 0) - now)}ms remaining)`,
      confidence: 0.95,
      ...ts,
    };
  }

  // 2. Currently idling — caller should wait.
  if (isIdle()) {
    return {
      kind: 'continue',
      reason: `Idling (${Math.max(0, (_idleEndsAt ?? 0) - now)}ms remaining, reason=${_idleReason})`,
      confidence: 0.95,
      ...ts,
    };
  }

  // 3. Session too long — wind down.
  if (_sessionActive && _sessionStartedAt != null) {
    const sessionMs = now - _sessionStartedAt;
    if (sessionMs > _resolveMaxSessionMs()) {
      return {
        kind: 'end_session',
        reason: `Session length ${Math.round(sessionMs / 60000)}min exceeds max ${Math.round(_resolveMaxSessionMs() / 60000)}min`,
        confidence: 0.85,
        ...ts,
      };
    }
  }

  // 4. Break overdue.
  if (shouldTakeBreak()) {
    const dur = Math.round(_randRange(_profile.breakDurationMinMs, _profile.breakDurationMaxMs));
    return {
      kind: 'take_break',
      durationMs: dur,
      reason: `Last break was ${_lastBreakAt != null ? Math.round((now - _lastBreakAt) / 60000) : 'never'}min ago (breakEvery=${Math.round(_profile.breakEveryMs / 60000)}min)`,
      confidence: 0.9,
      ...ts,
    };
  }

  // 5. Pace too fast.
  const paceStatus = getPaceStatus();
  if (paceStatus === 'too_fast') {
    const delay = Math.round(_randRange(_profile.interActionMinMs, _profile.interActionMaxMs));
    return {
      kind: 'slow_down',
      durationMs: delay,
      reason: `Pace score ${getPaceScore()} < 30 (actions/min=${_countActionsInWindow(60000)}, target=${_profile.targetActionsPerMin})`,
      confidence: 0.8,
      ...ts,
    };
  }

  // 6. Idle roll.
  if (shouldIdleNow()) {
    const dur = startIdle('suggested');
    // startIdle already fired the rhythm event; we just return the
    // suggestion so the caller knows to wait.
    return {
      kind: 'idle',
      durationMs: dur,
      reason: `Spontaneous idle (chance=${_profile.idleChancePerAction}, stealth=${_stealthLevelCache})`,
      confidence: 0.7,
      ...ts,
    };
  }

  // 7. Wander roll.
  const wanderChance = _profile.wanderChancePerCycle *
    (_stealthLevelCache === 'MAXIMUM' ? 1.5 : _stealthLevelCache === 'ELEVATED' ? 1.2 : 1.0);
  if (Math.random() < _clamp(wanderChance, 0, 0.6)) {
    _totalWandersEmitted++;
    const target = _suggestWanderTarget();
    _fireRhythmEvent('wander_emitted', { target });
    return {
      kind: 'wander',
      targetPage: target,
      reason: `Wander roll triggered (chance=${wanderChance.toFixed(2)})`,
      confidence: 0.5, // wander is always low-confidence; caller may skip
      ...ts,
    };
  }

  // 8. Default — proceed normally.
  return {
    kind: 'continue',
    reason: 'Pace on target, no break/idle/wander needed',
    confidence: 0.9,
    ...ts,
  };
}

/**
 * Pick a "wander target" — a non-essential page the bot could visit
 * to look more human. Returns a page category hint, not a hard URL.
 */
function _suggestWanderTarget(): string {
  // Pick a category we haven't visited recently.
  const recentCats = new Set(_pages.slice(-5).map(p => p.category));
  const candidates: PageCategory[] = ['assignments', 'score', 'pathway', 'video'];
  const fresh = candidates.filter(c => !recentCats.has(c));
  if (fresh.length > 0) return _pickWeighted(fresh);
  return _pickWeighted(candidates);
}

// ─── Profile management ───────────────────────────────────────────────────

function getCurrentProfile(): NormalcyProfile {
  return _profile;
}

/**
 * Rotate to a different profile. Picks one at random, avoiding the
 * current one. Throttled: at most one rotation per 10 minutes unless
 * forced.
 */
function rotateProfile(force: boolean = false): NormalcyProfile {
  const now = _now();
  const minGapMs = 10 * 60 * 1000;
  if (!force && (now - _lastProfileRotation) < minGapMs) {
    log(`Profile rotation skipped (too soon, last=${new Date(_lastProfileRotation).toISOString()})`, 'DEBUG');
    return _profile;
  }
  const profiles = _resolveProfiles();
  const candidates = profiles.filter(p => p.name !== _profile.name);
  if (candidates.length === 0) return _profile;
  const prev = _profile;
  _profile = _pickWeighted(candidates);
  _lastProfileRotation = now;
  log(`Profile rotated: ${prev.name} → ${_profile.name}${force ? ' (forced)' : ''}`, 'INFO');
  return _profile;
}

// ─── Listeners ────────────────────────────────────────────────────────────

function onRhythmEvent(id: string, fn: RhythmEventListener['fn']): () => void {
  if (!id || typeof fn !== 'function') {
    log('onRhythmEvent: ignoring invalid listener', 'WARN');
    return () => {};
  }
  const existing = _rhythmListeners.findIndex(l => l.id === id);
  if (existing >= 0) _rhythmListeners.splice(existing, 1);
  _rhythmListeners.push({ id, fn });
  return () => {
    const idx = _rhythmListeners.findIndex(l => l.id === id);
    if (idx >= 0) _rhythmListeners.splice(idx, 1);
  };
}

function _fireRhythmEvent(event: RhythmEvent, payload: Record<string, any> = {}): void {
  for (const l of _rhythmListeners.slice()) {
    try { l.fn(event, payload); }
    catch (err) { logError(`Rhythm listener "${l.id}" threw`, err); }
  }
}

// ─── Stealth-operations coupling ──────────────────────────────────────────

/**
 * Called by stealth-operations' onLevelChange listener (or manually
 * by the cycle manager) when the stealth level changes. Affects idle
 * probability and pace targets.
 */
function setStealthLevel(level: 'NORMAL' | 'ELEVATED' | 'MAXIMUM'): void {
  if (level === _stealthLevelCache) return;
  const prev = _stealthLevelCache;
  _stealthLevelCache = level;
  log(`Stealth level coupling updated: ${prev} → ${level}`, 'DEBUG');
  // When stealth escalates, end any active idle early so the bot can
  // be more conservative (don't keep doing nothing suspiciously long).
  if (level === 'MAXIMUM' && _idleActive) {
    log('Stealth MAXIMUM: ending active idle early', 'DEBUG');
    endIdle();
  }
}

// ─── Rhythm tick ─────────────────────────────────────────────────────────

function _rhythmTick(): void {
  try {
    // Auto-end expired breaks/idles.
    if (_breakActive && _breakEndsAt != null && _now() >= _breakEndsAt) endBreak();
    if (_idleActive && _idleEndsAt != null && _now() >= _idleEndsAt) endIdle();

    // Circadian phase change detection.
    const circ = getCircadian();
    if (_lastCircadianPhase != null && circ.phase !== _lastCircadianPhase) {
      log(`Circadian phase: ${_lastCircadianPhase} → ${circ.phase} (energy=${circ.energyMultiplier.toFixed(2)})`, 'DEBUG');
      _fireRhythmEvent('phase_change', { from: _lastCircadianPhase, to: circ.phase, energy: circ.energyMultiplier });
    }
    _lastCircadianPhase = circ.phase;

    // Refresh naturalness score so it stays current.
    getNaturalnessScore();
  } catch (err) {
    logError('Rhythm tick threw (best-effort recovery)', err);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

function start(): void {
  if (_started) return;
  _started = true;
  log(`Normalcy engine started (profile=${_profile.name})`, 'INFO');

  if (_rhythmTimer) clearInterval(_rhythmTimer);
  _rhythmTimer = setInterval(_rhythmTick, RHYTHM_TICK_MS);
  if (_rhythmTimer.unref) _rhythmTimer.unref();

  _lastCircadianPhase = getCircadian().phase;
}

function stop(): void {
  if (!_started) return;
  _started = false;
  if (_rhythmTimer) { clearInterval(_rhythmTimer); _rhythmTimer = null; }
  if (_sessionActive) endSession();
  log('Normalcy engine stopped', 'INFO');
}

function reset(): void {
  const wasStarted = _started;
  const wasInSession = _sessionActive;
  _sessionActive = false;
  _sessionStartedAt = null;
  _actions = [];
  _pages = [];
  _lastBreakAt = null;
  _breakActive = false;
  _breakEndsAt = null;
  _idleActive = false;
  _idleEndsAt = null;
  _idleReason = '';
  _lastCircadianPhase = null;
  _totalActionsRecorded = 0;
  _totalPaceWarnings = 0;
  _totalIdlesInjected = 0;
  _totalBreaksTaken = 0;
  _totalWandersEmitted = 0;
  _lastNaturalnessScore = 50;
  _lastPaceScore = 50;
  _lastDwellScore = 50;
  _lastSequenceScore = 50;
  log(`Normalcy state reset (wasStarted=${wasStarted}, wasInSession=${wasInSession})`, 'INFO');
}

// ─── Diagnostics ──────────────────────────────────────────────────────────

function getStatus(): NormalcyStatus {
  const circ = getCircadian();
  const rhythm = getSessionRhythm();
  const naturalness = getNaturalnessScore();
  const pendingIdle = getPendingIdle();
  return {
    profileName: _profile.name,
    sessionActive: _sessionActive,
    sessionStartedAt: _sessionStartedAt,
    sessionDurationMs: rhythm.durationMs,
    totalActions: rhythm.totalActions,
    actionsInLastMin: rhythm.actionsInLastMin,
    naturalnessScore: naturalness,
    paceScore: _lastPaceScore,
    dwellScore: _lastDwellScore,
    naturalnessScoreComponents: {
      pace: _lastPaceScore,
      dwell: _lastDwellScore,
      rhythm: _sessionActive
        ? (_lastBreakAt != null
            ? (_now() - _lastBreakAt > _profile.breakEveryMs * 2 ? 25
              : _now() - _lastBreakAt > _profile.breakEveryMs ? 60 : 90)
            : (_sessionStartedAt && _now() - _sessionStartedAt < _profile.breakEveryMs ? 90 : 40))
        : 50,
      sequence: _lastSequenceScore,
    },
    circadianPhase: circ.phase,
    circadianEnergy: circ.energyMultiplier,
    isOffHours: circ.isOffHours,
    lastBreakAt: _lastBreakAt,
    nextBreakInMs: rhythm.nextBreakInMs,
    pendingIdle: pendingIdle ? { active: true, remainingMs: pendingIdle.remainingMs, reason: pendingIdle.reason } : null,
    totalIdlesInjected: _totalIdlesInjected,
    totalBreaksTaken: _totalBreaksTaken,
    totalWandersEmitted: _totalWandersEmitted,
    started: _started,
  };
}

/**
 * Lightweight self-test. Returns true if all internal invariants hold.
 */
function selfTest(): { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  checks.push({
    name: 'profile_known',
    ok: DEFAULT_PROFILES.some(p => p.name === _profile.name),
    detail: `profile=${_profile.name}`,
  });

  const circ = getCircadian();
  checks.push({
    name: 'circadian_phase_valid',
    ok: ['morning_ramp', 'morning_peak', 'lunch_dip', 'afternoon', 'evening_peak', 'evening_wind_down', 'off_hours'].includes(circ.phase),
    detail: `phase=${circ.phase}`,
  });

  checks.push({
    name: 'circadian_energy_in_range',
    ok: circ.energyMultiplier >= 0.3 && circ.energyMultiplier <= 1.2,
    detail: `energy=${circ.energyMultiplier.toFixed(2)}`,
  });

  checks.push({
    name: 'local_hour_valid',
    ok: circ.localHour >= 0 && circ.localHour <= 23,
    detail: `hour=${circ.localHour}`,
  });

  const pace = getPaceScore();
  checks.push({
    name: 'pace_score_in_range',
    ok: pace >= 0 && pace <= 100,
    detail: `pace=${pace}`,
  });

  const nat = getNaturalnessScore();
  checks.push({
    name: 'naturalness_in_range',
    ok: nat >= 0 && nat <= 100,
    detail: `naturalness=${nat}`,
  });

  checks.push({
    name: 'action_queue_bounded',
    ok: _actions.length <= MAX_ACTION_HISTORY,
    detail: `len=${_actions.length} cap=${MAX_ACTION_HISTORY}`,
  });

  checks.push({
    name: 'page_queue_bounded',
    ok: _pages.length <= MAX_PAGE_HISTORY,
    detail: `len=${_pages.length} cap=${MAX_PAGE_HISTORY}`,
  });

  checks.push({
    name: 'listeners_callable',
    ok: _rhythmListeners.every(l => typeof l.fn === 'function'),
    detail: `count=${_rhythmListeners.length}`,
  });

  // Suggest behavior should not throw and should return a valid kind.
  try {
    const s = suggestBehavior();
    const validKinds = ['continue', 'idle', 'scroll', 'wander', 'take_break', 'end_session', 'slow_down', 'speed_up'];
    checks.push({
      name: 'suggestBehavior_returns_valid',
      ok: validKinds.includes(s.kind) && typeof s.confidence === 'number',
      detail: `kind=${s.kind} confidence=${s.confidence}`,
    });
  } catch (err: any) {
    checks.push({ name: 'suggestBehavior_returns_valid', ok: false, detail: `threw: ${err?.message}` });
  }

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

  // Session
  startSession,
  endSession,
  getSessionRhythm,
  shouldTakeBreak,
  getTimeUntilBreak,
  startBreak,
  endBreak,
  isOnBreak,

  // Idle
  shouldIdleNow,
  startIdle,
  endIdle,
  isIdle,
  getPendingIdle,

  // Behavior
  suggestBehavior,

  // Recording
  recordAction,
  recordPageVisit,

  // Scores
  getNaturalnessScore,
  getPaceScore,
  getPaceStatus,
  getDwellScore,
  getSequenceScore,

  // Circadian
  getCircadian,
  isOffHours,

  // Profiles
  getCurrentProfile,
  rotateProfile,

  // Coupling
  setStealthLevel,

  // Listeners
  onRhythmEvent,

  // Diagnostics
  getStatus,

  // Constants (exposed for tests / config validation)
  DEFAULT_PROFILES,
  DEFAULT_CIRCADIAN,
  DEFAULT_OFF_HOURS,
};
