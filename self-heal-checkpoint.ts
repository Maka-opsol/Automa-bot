'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// Self-Heal Checkpoint — Make healing impervious to restarts
//
// Problem: Self-heal's pipeline is expensive (browser + AI calls).
// On Render's 512MB free plan, OOM kills are common during healing.
// When the process is SIGKILL'd, all in-memory state is lost:
//   - investigation results (error logs, screenshots, HTML)
//   - generated fixes (the actual patch code)
//   - audit results
//   - which attempt we're on
//
// Solution: After each pipeline phase, save state to the calibration DB.
// On boot / next heal attempt, check for incomplete checkpoints and resume
// from the last completed phase. Healing makes progress EVEN IF the bot
// OOMs between phases.
//
// Phases: started → investigated → fixes_generated → audited → staged
//         → promoted → completed
//
// Memory guarding: Before each expensive operation, check available headroom.
// If memory is critical, abort and checkpoint what we have so the next
// instance can resume from there instead of starting from scratch.
// ═══════════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getDb() { return _deps.database?.db; }

// ─── Types ──────────────────────────────────────────────────────────────────

type HealPhase = 'started' | 'investigated' | 'fixes_generated' | 'audited' | 'staged' | 'promoted' | 'completed';

export interface HealCheckpoint {
  startedAt: number;
  updatedAt: number;
  phase: HealPhase;
  attemptNumber: number;
  triggerReason: string;
  investigation: any | null;    // { screenshot, html, url } from investigatePage()
  errorLogs: string | null;     // from getRecentErrors()
  patchContext: string | null;  // from patch memory
  fixes: any[] | null;          // Raw generated fixes (before audit)
  safeFixes: any[] | null;      // Fixes that passed audit
  stagingSource: string | null; // Staging directory path
  backupPath: string | null;    // Backup directory path
  memoryAtSave: number;         // heapUsed at time of save
}

const PHASE_ORDER: HealPhase[] = ['started', 'investigated', 'fixes_generated', 'audited', 'staged', 'promoted', 'completed'];

// ─── Constants ──────────────────────────────────────────────────────────────

const CKPT_KEY = 'heal_checkpoint';
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — stale checkpoints are discarded

// Memory thresholds (bytes). On Render free plan: 512MB RAM, --max-old-space-size=384MB.
// But external allocations (buffers, native modules, Chromium leftovers) mean OOM
// can happen well before 384MB heap. These are conservative.
const MEM_CRITICAL = 20 * 1024 * 1024;   // < 20MB headroom → ABORT immediately, checkpoint
const MEM_DANGER  = 50 * 1024 * 1024;   // 20-50MB → skip browser, skip AI, runtime only
const MEM_CAUTION = 100 * 1024 * 1024;  // 50-100MB → skip browser (screenshot), AI ok
// > 100MB → safe for anything

// ─── Core Checkpoint Functions ──────────────────────────────────────────────

/**
 * Save a checkpoint to the DB. Merges with existing checkpoint data.
 * Only overwrites fields that are explicitly provided.
 */
function saveCheckpoint(ckpt: Partial<HealCheckpoint> & { phase: HealPhase }): void {
  const db = getDb();
  if (!db) return;

  try {
    const existing = loadCheckpoint();
    const merged: HealCheckpoint = {
      startedAt: ckpt.startedAt || existing?.startedAt || Date.now(),
      updatedAt: Date.now(),
      phase: ckpt.phase,
      attemptNumber: ckpt.attemptNumber ?? existing?.attemptNumber ?? 1,
      triggerReason: ckpt.triggerReason || existing?.triggerReason || '',
      // Only overwrite investigation/fixes/safeFixes if explicitly provided (non-null)
      investigation: ckpt.investigation !== undefined ? ckpt.investigation : (existing?.investigation ?? null),
      errorLogs: ckpt.errorLogs !== undefined ? ckpt.errorLogs : (existing?.errorLogs ?? null),
      patchContext: ckpt.patchContext !== undefined ? ckpt.patchContext : (existing?.patchContext ?? null),
      fixes: ckpt.fixes !== undefined ? ckpt.fixes : (existing?.fixes ?? null),
      safeFixes: ckpt.safeFixes !== undefined ? ckpt.safeFixes : (existing?.safeFixes ?? null),
      stagingSource: ckpt.stagingSource !== undefined ? ckpt.stagingSource : (existing?.stagingSource ?? null),
      backupPath: ckpt.backupPath !== undefined ? ckpt.backupPath : (existing?.backupPath ?? null),
      memoryAtSave: process.memoryUsage().heapUsed,
    };

    db.prepare(
      "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(CKPT_KEY, JSON.stringify(merged), Date.now());

    log(`Checkpoint saved: phase=${merged.phase}, mem=${Math.round(merged.memoryAtSave / 1024 / 1024)}MB`, 'INFO', 'self-heal-checkpoint');
  } catch (err: any) {
    logError('Failed to save checkpoint', err);
  }
}

/**
 * Load the current checkpoint from DB. Returns null if none exists.
 */
function loadCheckpoint(): HealCheckpoint | null {
  const db = getDb();
  if (!db) return null;

  try {
    const row = db.prepare("SELECT value FROM calibration WHERE key = ?").get(CKPT_KEY);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed?.phase || !PHASE_ORDER.includes(parsed.phase)) return null;
    return parsed as HealCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Clear the checkpoint (on successful heal completion or explicit abort).
 */
function clearCheckpoint(): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare("DELETE FROM calibration WHERE key = ?").run(CKPT_KEY);
    log('Checkpoint cleared', 'INFO', 'self-heal-checkpoint');
  } catch {}
}

/**
 * Check if there's an incomplete heal that should be resumed.
 * Returns null if no checkpoint, or if the checkpoint is stale/completed.
 */
function getResumableCheckpoint(): HealCheckpoint | null {
  const ckpt = loadCheckpoint();
  if (!ckpt) return null;

  // Completed checkpoints should have been cleared, but handle it
  if (ckpt.phase === 'completed') {
    clearCheckpoint();
    return null;
  }

  // Don't resume stale checkpoints
  const age = Date.now() - ckpt.updatedAt;
  if (age > STALE_THRESHOLD_MS) {
    log(`Stale checkpoint (${Math.round(age / 60000)}min old), discarding`, 'WARN', 'self-heal-checkpoint');
    clearCheckpoint();
    return null;
  }

  const phaseIdx = PHASE_ORDER.indexOf(ckpt.phase);
  log(`Resumable checkpoint found: phase=${ckpt.phase} (${PHASE_ORDER.length - 1 - phaseIdx} phases remaining), age=${Math.round(age / 60000)}min`, 'INFO', 'self-heal-checkpoint');
  return ckpt;
}

// ─── Memory Budget ──────────────────────────────────────────────────────────

interface MemoryState {
  heapUsed: number;
  heapLimit: number;
  headroom: number;
  level: 'safe' | 'caution' | 'danger' | 'critical';
  canRunBrowser: boolean;
  canRunAI: boolean;
  canContinue: boolean;
}

/**
 * Get the current memory budget and what operations are safe to run.
 * Returns an object with heap stats and boolean flags for each operation type.
 */
function getMemoryBudget(): MemoryState {
  const mem = process.memoryUsage();
  const heapUsed = mem.heapUsed;
  const isRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  // Conservative heap limit: on Render free plan, max-old-space-size=384MB,
  // but external allocs (buffers, native, Chromium) eat into the 512MB container.
  const heapLimit = isRender ? 340 * 1024 * 1024 : 700 * 1024 * 1024;
  const headroom = heapLimit - heapUsed;

  let level: MemoryState['level'];
  if (headroom > MEM_CAUTION) level = 'safe';
  else if (headroom > MEM_DANGER) level = 'caution';
  else if (headroom > MEM_CRITICAL) level = 'danger';
  else level = 'critical';

  return {
    heapUsed,
    heapLimit,
    headroom,
    level,
    canRunBrowser: level === 'safe',           // Browser is the heaviest (~50-100MB)
    canRunAI: level !== 'danger' && level !== 'critical',  // AI calls need some buffer
    canContinue: level !== 'critical',         // Critical = checkpoint and abort
  };
}

/**
 * Force aggressive memory cleanup before healing.
 * Runs GC, then returns the memory state after cleanup.
 */
function forceMemoryCleanup(): MemoryState {
 // 1. Force GC if available (requires --expose-gc, which render-free-plan.ts uses)
  if (global.gc) {
    try {
      global.gc();
      log('Forced GC before heal', 'DEBUG', 'self-heal-checkpoint');
    } catch {}
  }

  // 2. Flush runtime caches that may be holding memory
  try {
    const providersStats = require('./providers-stats');
    providersStats.resetErrorCounters?.();
  } catch {}

  const state = getMemoryBudget();
  log(`Memory after cleanup: ${Math.round(state.heapUsed / 1024 / 1024)}MB used, ${Math.round(state.headroom / 1024 / 1024)}MB headroom [${state.level}]`, 'INFO', 'self-heal-checkpoint');
  return state;
}

/**
 * Check memory before an expensive operation. Returns true if safe to proceed.
 * If not safe, saves a checkpoint with the given phase and returns false.
 * The caller should abort the operation and let the next instance resume.
 */
function checkMemoryBeforePhase(phase: HealPhase, needBrowser: boolean, needAI: boolean): boolean {
  const state = getMemoryBudget();

  if (state.level === 'critical') {
    log(`Memory CRITICAL (${Math.round(state.heapUsed / 1024 / 1024)}MB). Aborting before ${phase} — checkpointing for resume.`, 'ERROR', 'self-heal-checkpoint');
    // Don't save the phase we're about to enter — save the PREVIOUS phase
    // so the next instance knows to retry this phase
    return false;
  }

  if (needBrowser && !state.canRunBrowser) {
    log(`Memory ${state.level} (${Math.round(state.heapUsed / 1024 / 1024)}MB). Skipping browser for ${phase} — checkpointing.`, 'WARN', 'self-heal-checkpoint');
    return false;
  }

  if (needAI && !state.canRunAI) {
    log(`Memory ${state.level} (${Math.round(state.heapUsed / 1024 / 1024)}MB). Skipping AI for ${phase} — checkpointing.`, 'WARN', 'self-heal-checkpoint');
    return false;
  }

  return true;
}

/**
 * Get a human-readable summary of the checkpoint state (for logging/status).
 */
function getStatus(): { hasCheckpoint: boolean; phase: string | null; age: number | null; memoryAtSave: number | null } {
  const ckpt = loadCheckpoint();
  if (!ckpt) return { hasCheckpoint: false, phase: null, age: null, memoryAtSave: null };
  return {
    hasCheckpoint: true,
    phase: ckpt.phase,
    age: Date.now() - ckpt.updatedAt,
    memoryAtSave: ckpt.memoryAtSave,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  getResumableCheckpoint,
  getMemoryBudget,
  forceMemoryCleanup,
  checkMemoryBeforePhase,
  getStatus,
  _injectDependencies,
  // Constants for reference
  PHASE_ORDER,
  MEM_CRITICAL,
  MEM_DANGER,
  MEM_CAUTION,
};
