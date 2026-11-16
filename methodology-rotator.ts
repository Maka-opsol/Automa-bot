'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Methodology Rotator — stop ramming your head into the same wall
// ═══════════════════════════════════════════════════════════════════════
//
// Problem:
//   When the bot fails to complete a question, its ONLY response is to
//   increment consecutiveFailures and retry the SAME approach next cycle.
//   Self-heal patches the SAME methodology. Last-resort mode retries the
//   SAME methodology HARDER. Neither changes the fundamental approach.
//
//   The user's observation: "it simply continuously rams its head into
//   the problem without ever changing its methodology." Exactly right.
//
//   The bot HAS all the pieces for methodology rotation — model switching
//   (setModelRole), template invalidation (DELETE FROM template_cache),
//   page recovery (page.reload), session rotation (tryAllSessions) — but
//   NO orchestration layer decides WHEN to switch and WHAT to switch to.
//
// Solution:
//   An escalation ladder of 8 DISTINCT methodologies. After N consecutive
//   failures, the rotator switches to the next untried methodology in the
//   ladder. Each methodology is a fundamentally different approach, not a
//   harder retry of the same one:
//
//     Failure  3 → INVALIDATE_TEMPLATES  (re-derive actions from fresh screenshot)
//     Failure  4 → SWITCH_MODEL_FALLBACK (different LLM might give better answers)
//     Failure  5 → PAGE_RELOAD           (clear transient UI corruption)
//     Failure  6 → SWITCH_MODEL_NEXT     (rotate to next registered working model)
//     Failure  7 → CLEAR_CACHE_RELOAD    (clear cookies/cache + reload)
//     Failure  8 → ROTATE_SESSION        (different account/IP from session pool)
//     Failure  9 → RESTART_BROWSER       (fresh browser context — nuclear)
//     Failure 10 → SKIP_QUESTION         (current question is unanswerable, move on)
//
//   When last-resort mode is active, the ladder compresses: rotate after
//   EVERY failure (not every 2-3), because last-resort means we're already
//   in deep trouble and accelerating the methodology search.
//
// Persistence (critical for multi-year operation):
//   The rotator's state (current level, tried-set) is persisted in the
//   calibration table. If the bot restarts (OOM, hang-watchdog, last-resort
//   safety valve), it LOADS its last state and continues escalating — it
//   does NOT reset to "dumb retry" from Level 0. A restart mid-failure-
//   episode continues the methodology search, not restarts it.
//
// Historical success tracking:
//   When a question succeeds, the rotator records WHICH methodology was
//   active. Over time, it prefers methodologies with higher historical
//   success rates (moves them earlier in the ladder for future episodes).
//
// API:
//   onFailure(consecutiveFailures, currentState) → change | null
//   applyChange(change, deps) → Promise<boolean>
//   onSuccess() → void  (reset + record)
//   getStatus() → {...}
//   selfTest() → {...}
//   start() / stop() — lifecycle (auto-loads persisted state on start)
// ═══════════════════════════════════════════════════════════════════════

const STATE_KEY = 'methodology_rotator_state';
const HISTORY_KEY = 'methodology_rotator_history';

// ─── The escalation ladder ──────────────────────────────────────────────
// Each entry: { id, threshold, kind, description }
//   threshold = consecutiveFailures count that triggers this methodology.
//   kind = 'internal' (the bot fully controls this — its own code/state/process)
//          'external' (depends on an external service being up — LLM provider, target site)
//
// DESIGN PRINCIPLE (per user guidance, 2026-11-15):
//   "Worst case scenario, just rely on the bot's internal systems and what it
//    can control. The bot can fix and improve that but things like cloud
//    providers are out of its control."
//
// So the ladder is ordered with external-dependent methodologies in the MIDDLE
// (worth trying once, but don't depend on them) and internal-only methodologies
// at the DEEP END (the worst-case fallbacks the bot can fully control and fix):
//   hot_swap_modules → self_heal_code → skip_question
//
// When a failure is classified as EXTERNAL (provider down, network down), the
// rotator SKIPS the external methodologies entirely — switching to a dead
// provider won't help. It goes straight to internal recovery. If all internal
// methodologies are exhausted on an external failure, the rotator signals
// "external backoff" — wait for the external service to recover instead of
// burning cycles.
//
// The rotator picks the HIGHEST-threshold methodology that consecutiveFailures
// has crossed AND that hasn't been tried yet in this failure episode AND that
// is applicable to the failure's classification (internal/external).
const METHODOLOGIES: Array<{
  id: string;
  threshold: number;
  kind: 'internal' | 'external';
  description: string;
}> = [
  {
    id: 'invalidate_templates',
    threshold: 3,
    kind: 'internal',
    description: 'Delete cached action templates for the current state — re-derive click coordinates from a fresh screenshot. The UI may have shifted since the template was cached.',
  },
  {
    id: 'page_reload',
    threshold: 4,
    kind: 'internal',
    description: 'Reload the current page. Clears transient UI corruption, stuck JavaScript, or half-loaded DOM states.',
  },
  {
    id: 'clear_cache_reload',
    threshold: 5,
    kind: 'internal',
    description: 'Clear browser cache + cookies for the domain, then reload. Removes corrupted cached resources or stale auth state.',
  },
  {
    id: 'switch_model_fallback',
    threshold: 6,
    kind: 'external',
    description: 'Switch the active LLM to the registered fallback model. The current model may be giving degraded or wrong answers. SKIPPED if the failure is external (provider down) or if the fallback provider is marked unhealthy.',
  },
  {
    id: 'switch_model_next',
    threshold: 7,
    kind: 'external',
    description: 'Rotate to the next registered working model (beyond the fallback). If the first fallback also fails, try the next provider entirely. SKIPPED if the failure is external or if all providers are marked unhealthy.',
  },
  {
    id: 'rotate_session',
    threshold: 8,
    kind: 'external',
    description: 'Switch to a different session from the session pool. May use a different account or exit a rate-limited/banned IP. SKIPPED if the failure is external (the target site itself is the problem).',
  },
  {
    id: 'restart_browser',
    threshold: 9,
    kind: 'internal',
    description: 'Close and relaunch the browser with a fresh context. Clears all in-memory browser state, memory leaks, stuck Playwright instances.',
  },
  {
    id: 'hot_swap_modules',
    threshold: 10,
    kind: 'internal',
    description: 'Worst-case internal recovery: hot-swap the currently-active code modules for their known-good backups. If a module has a bug that surfaced under load, this swaps in the backup version without restarting the process. The bot fully controls this — no external dependency.',
  },
  {
    id: 'self_heal_code',
    threshold: 11,
    kind: 'internal',
    description: 'Deepest internal recovery: trigger a full self-heal pass — re-derive all templates, re-validate all selectors, promote any quarantined modules, patch the action pipeline. The bot fixes and improves its own systems. No external dependency — this is the "the bot can fix and improve that" tier.',
  },
  {
    id: 'skip_question',
    threshold: 12,
    kind: 'internal',
    description: 'Skip the current stuck question and navigate to the next one. Some questions are genuinely unanswerable (broken UI, unsupported type). Move on rather than burn the entire cycle. Internal — the bot controls which question it attempts.',
  },
];

// When last-resort mode is active, compress the ladder: trigger every methodology
// at a lower threshold (rotate every 1-2 failures instead of every 2-3).
const LAST_RESORT_THRESHOLDS: Record<string, number> = {
  invalidate_templates: 1,
  page_reload: 2,
  clear_cache_reload: 3,
  switch_model_fallback: 4,
  switch_model_next: 5,
  rotate_session: 6,
  restart_browser: 7,
  hot_swap_modules: 8,
  self_heal_code: 9,
  skip_question: 10,
};

// ─── Failure classification ─────────────────────────────────────────────
// Maps the bot's error codes to internal (bot can fix) vs external (out of
// the bot's control — provider/network/target-site down). Aligned with the
// TRANSIENT_ERROR_CODES and HEALABLE_ERROR_CODES sets in cycle-cycle-manager.ts.
const EXTERNAL_ERROR_CODES = new Set([
  'E_NETWORK_TIMEOUT',      // network is down/slow
  'E_RATE_LIMITED',         // provider rate-limited the bot
  'E_PROVIDER_TEMPORARY',   // provider returned 5xx (temporarily down)
  'E_PROVIDER_PERMANENT',   // provider is permanently broken
  'E_CONNECTION_FAILED',    // ECONNREFUSED/ENOTFOUND — network/DNS issue
  'E_CAPTCHA_ENCOUNTERED',  // target site is challenging the bot
]);

const INTERNAL_ERROR_CODES = new Set([
  'E_SELECTOR_DRIFT',       // bot's selectors are wrong — can re-derive
  'E_UI_CHANGED',           // UI changed — bot can update selectors
  'E_STATE_DEADLOCK',       // bot's internal state is deadlocked
  'E_PATCH_FAILED',         // bot's self-heal patch failed
  'E_RESTART_LOOP',         // bot is restarting repeatedly
  'E_BROWSER_DISCONNECTED', // Playwright crashed — bot's own component
]);

// Unknown codes (E_PROGRESS_STALL, E_SLOW_PROGRESS, E_ZERO_PROGRESS, E_UNKNOWN,
// anything else) default to 'internal' — try internal recovery first, since the
// bot can always fix its own systems. Only confirmed-external codes skip the
// external methodologies.

// External error patterns (for matching against error messages when no code)
const EXTERNAL_ERROR_PATTERNS = [
  /status[:\s]*(429|500|502|503|504)/i,
  /\b(429|503|502|500|504)\s+(too many requests|service unavailable|bad gateway|internal server error|gateway timeout)/i,
  /too many requests/i,
  /rate.?limit/i,
  /service.?unavailable/i,
  /upstream.?error/i,
  /bad.?gateway/i,
  /gateway.?timeout/i,
  /internal server error/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /navigation.?timeout/i,
  /page\.goto.*timeout/i,
  /net::ERR_/i,
];

function classifyFailure(errorCode?: string, errorMessage?: string): 'internal' | 'external' {
  if (errorCode && EXTERNAL_ERROR_CODES.has(errorCode)) return 'external';
  if (errorCode && INTERNAL_ERROR_CODES.has(errorCode)) return 'internal';
  if (errorMessage) {
    for (const pattern of EXTERNAL_ERROR_PATTERNS) {
      if (pattern.test(errorMessage)) return 'external';
    }
  }
  // Unknown — default to internal (the bot can always try to fix its own systems).
  return 'internal';
}

// ─── State ──────────────────────────────────────────────────────────────
let _deps: any = {};
let _interval: any = null;

// In-memory state (mirrored to DB for persistence)
let _currentLevel = 0;                    // index into METHODOLOGIES (0 = no rotation yet)
let _triedMethodologies: Set<string> = new Set();  // what's been tried this episode
let _lastFailureCount = 0;                // consecutiveFailures when onFailure was last called
let _lastRotationAt = 0;                  // timestamp of last methodology change
let _episodeId = '';                      // unique per failure episode (changes on reset)
let _activeMethodology: string | null = null;  // methodology active when success happened
let _totalRotations = 0;
let _totalEpisodes = 0;
let _consecutiveZeroQuestionCycles = 0;   // tracks cycles with 0 questions completed (separate from consecutiveFailures which only counts error-cycles)

function _injectDependencies(deps: any) { _deps = deps || {}; }

function _log(msg: string, level: string = 'INFO'): void {
  try {
    const logger = _deps.logger || (require('./logger').log ? require('./logger') : null);
    if (logger?.log) { logger.log(msg, level, 'methodology-rotator'); return; }
  } catch {}
  const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
  (console as any)[fn](`[methodology-rotator] ${msg}`);
}

function _getDb(): any {
  try { return _deps.database?.db || require('./database').db; } catch { return null; }
}
function _getCalibration(): any {
  try { return _deps.database?.upsertCalibration || require('./database').upsertCalibration; } catch { return null; }
}
function _selectCalibration(): any {
  try { return _deps.database?.selectCalibration || require('./database').selectCalibration; } catch { return null; }
}
function _isLastResortActive(): boolean {
  try { return require('./last-resort-mode').isLastResortActive(); } catch { return false; }
}

// ─── Provider health tracking ───────────────────────────────────────────
// When switch_model_* is applied but the new provider ALSO fails (detected on
// the next cycle), the rotator marks that provider unhealthy and skips it in
// future rotations. This prevents the bot from rotating TO a dead provider.
// Providers auto-recover after PROVIDER_UNHEALTHY_TTL (1 hour) — external
// services do come back, and the bot shouldn't permanently blacklist them.
const PROVIDER_UNHEALTHY_TTL_MS = 60 * 60 * 1000; // 1 hour
let _unhealthyProviders: Map<string, number> = new Map(); // provider name → timestamp marked unhealthy

function markProviderUnhealthy(provider: string): void {
  if (!provider) return;
  _unhealthyProviders.set(provider, Date.now());
  _log(`Marked provider "${provider}" unhealthy for ${PROVIDER_UNHEALTHY_TTL_MS / 60000}min. Will skip it in model rotations until it recovers.`, 'WARN');
  // Persist so it survives restarts
  try {
    const upsertCal = _getCalibration();
    if (upsertCal) upsertCal.run('methodology_rotator_unhealthy_providers', JSON.stringify(Array.from(_unhealthyProviders.entries())));
  } catch {}
}

function isProviderHealthy(provider: string): boolean {
  if (!provider) return true;
  const markedAt = _unhealthyProviders.get(provider);
  if (!markedAt) return true;
  // Auto-recover after TTL
  if (Date.now() - markedAt > PROVIDER_UNHEALTHY_TTL_MS) {
    _unhealthyProviders.delete(provider);
    _log(`Provider "${provider}" auto-recovered (unhealthy TTL expired). Will consider it for model rotations again.`, 'INFO');
    return true;
  }
  return false;
}

function getProviderHealth(): Array<{ provider: string; markedAt: number; ageMin: number; healthy: boolean }> {
  const now = Date.now();
  return Array.from(_unhealthyProviders.entries()).map(([provider, markedAt]) => ({
    provider,
    markedAt,
    ageMin: Math.round((now - markedAt) / 60000),
    healthy: isProviderHealthy(provider),
  }));
}

function _loadUnhealthyProviders(): void {
  try {
    const selectCal = _selectCalibration();
    if (!selectCal) return;
    const row = selectCal.get('methodology_rotator_unhealthy_providers');
    if (!row?.value) return;
    const entries = JSON.parse(row.value);
    _unhealthyProviders = new Map(entries);
    // Prune expired entries on load
    for (const [provider, markedAt] of _unhealthyProviders) {
      if (Date.now() - markedAt > PROVIDER_UNHEALTHY_TTL_MS) _unhealthyProviders.delete(provider);
    }
    if (_unhealthyProviders.size > 0) {
      _log(`Loaded ${_unhealthyProviders.size} unhealthy provider(s): ${Array.from(_unhealthyProviders.keys()).join(', ')}.`, 'INFO');
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// Persistence — load/save state to calibration table
// ═══════════════════════════════════════════════════════════════════════

function _loadState(): void {
  try {
    const selectCal = _selectCalibration();
    if (!selectCal) return;
    const row = selectCal.get(STATE_KEY);
    if (!row?.value) return;
    const saved = JSON.parse(row.value);
    _currentLevel = saved.currentLevel || 0;
    _triedMethodologies = new Set(saved.triedMethodologies || []);
    _lastFailureCount = saved.lastFailureCount || 0;
    _lastRotationAt = saved.lastRotationAt || 0;
    _episodeId = saved.episodeId || '';
    _activeMethodology = saved.activeMethodology || null;
    _totalRotations = saved.totalRotations || 0;
    _totalEpisodes = saved.totalEpisodes || 0;
    _consecutiveZeroQuestionCycles = saved.consecutiveZeroQuestionCycles || 0;
    if (_currentLevel > 0 || _triedMethodologies.size > 0) {
      _log(`Loaded persisted state: level ${_currentLevel}, tried [${Array.from(_triedMethodologies).join(', ')}], episode ${_episodeId}. Continuing escalation (NOT resetting to dumb retry).`, 'INFO');
    }
  } catch (err: any) {
    _log(`Failed to load persisted state: ${err?.message || err}`, 'WARN');
  }
}

function _saveState(): void {
  try {
    const upsertCal = _getCalibration();
    if (!upsertCal) return;
    const state = {
      currentLevel: _currentLevel,
      triedMethodologies: Array.from(_triedMethodologies),
      lastFailureCount: _lastFailureCount,
      lastRotationAt: _lastRotationAt,
      episodeId: _episodeId,
      activeMethodology: _activeMethodology,
      totalRotations: _totalRotations,
      totalEpisodes: _totalEpisodes,
      consecutiveZeroQuestionCycles: _consecutiveZeroQuestionCycles,
      savedAt: Date.now(),
    };
    upsertCal.run(STATE_KEY, JSON.stringify(state));
  } catch (err: any) {
    _log(`Failed to persist state: ${err?.message || err}`, 'DEBUG');
  }
}

function _loadHistory(): Record<string, { successes: number; attempts: number }> {
  try {
    const selectCal = _selectCalibration();
    if (!selectCal) return {};
    const row = selectCal.get(HISTORY_KEY);
    if (!row?.value) return {};
    return JSON.parse(row.value);
  } catch { return {}; }
}

function _saveHistory(history: Record<string, { successes: number; attempts: number }>): void {
  try {
    const upsertCal = _getCalibration();
    if (!upsertCal) return;
    upsertCal.run(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

function _recordSuccess(methodology: string | null): void {
  if (!methodology) return;
  try {
    const history = _loadHistory();
    if (!history[methodology]) history[methodology] = { successes: 0, attempts: 0 };
    history[methodology].successes++;
    _saveHistory(history);
  } catch {}
}

function _recordAttempt(methodology: string): void {
  try {
    const history = _loadHistory();
    if (!history[methodology]) history[methodology] = { successes: 0, attempts: 0 };
    history[methodology].attempts++;
    _saveHistory(history);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// onCycleComplete — called at cycle end with questionsCompleted count.
// This is the PRIMARY trigger for methodology rotation. consecutiveFailures
// (the cycle's error counter) resets to 0 at cycle completion even when 0
// questions completed — so it can't drive methodology rotation. This method
// tracks consecutive zero-question cycles separately.
// ═══════════════════════════════════════════════════════════════════════

function onCycleComplete(questionsCompleted: number, currentState?: string, errorCode?: string, errorMessage?: string): {
  change: { id: string; description: string; level: number };
  reason: string;
  failureKind: 'internal' | 'external';
  externalBackoffMinutes?: number;
} | null {
  if (questionsCompleted > 0) {
    // Success — reset the episode and record which methodology was active.
    _consecutiveZeroQuestionCycles = 0;
    onSuccess();
    return null;
  }

  // Zero questions completed — increment the counter and check for rotation.
  _consecutiveZeroQuestionCycles++;
  _log(`Zero-question cycle #${_consecutiveZeroQuestionCycles}. Checking for methodology rotation.`, 'DEBUG');

  // Use the max of our zero-question counter and the cycle's error counter
  // (whichever is worse drives the rotation). Pass errorCode/message through
  // for failure classification (internal vs external).
  return onFailure(_consecutiveZeroQuestionCycles, currentState, errorCode, errorMessage);
}

// ═══════════════════════════════════════════════════════════════════════
// Core: onFailure — decide whether to rotate methodology
//
// errorCode + errorMessage are optional but STRONGLY RECOMMENDED — they let
// the rotator classify the failure as internal (bot can fix) vs external
// (provider/network/site down). For external failures, the rotator SKIPS
// external-dependent methodologies (switch_model_*, rotate_session) because
// switching to a dead provider won't help. It goes straight to internal
// recovery — things the bot fully controls.
// ═══════════════════════════════════════════════════════════════════════

function onFailure(consecutiveFailures: number, currentState?: string, errorCode?: string, errorMessage?: string): {
  change: { id: string; description: string; level: number };
  reason: string;
  failureKind: 'internal' | 'external';
  externalBackoffMinutes?: number;
} | null {
  // Auto-reset detection: if consecutiveFailures dropped below our last-seen
  // count, a success/reset happened that we weren't notified about. Reset.
  if (consecutiveFailures < _lastFailureCount) {
    if (_triedMethodologies.size > 0 || _currentLevel > 0) {
      _log(`Auto-reset detected (failures ${_lastFailureCount} → ${consecutiveFailures}). Starting new episode.`, 'DEBUG');
    }
    _resetEpisode();
  }
  _lastFailureCount = consecutiveFailures;

  const lastResort = _isLastResortActive();
  const failureKind = classifyFailure(errorCode, errorMessage);

  if (failureKind === 'external' && errorCode) {
    _log(`Failure classified as EXTERNAL (code: ${errorCode}). Will skip external-dependent methodologies (switch_model_*, rotate_session) — switching to a dead provider won't help. Going straight to internal recovery (things the bot controls).`, 'WARN');
  }

  // Find the highest-threshold methodology that consecutiveFailures has crossed
  // AND that hasn't been tried yet in this episode AND that is applicable.
  // For external failures, skip methodologies with kind === 'external'.
  let bestMethodology: typeof METHODOLOGIES[0] | null = null;
  let bestLevel = -1;
  let skippedDueToExternal = 0;

  for (let i = 0; i < METHODOLOGIES.length; i++) {
    const m = METHODOLOGIES[i];
    const threshold = lastResort
      ? (LAST_RESORT_THRESHOLDS[m.id] ?? m.threshold)
      : m.threshold;
    if (consecutiveFailures >= threshold && !_triedMethodologies.has(m.id)) {
      // Skip external methodologies when the failure is external — the provider/site
      // is the problem, so switching providers/sessions won't help.
      if (failureKind === 'external' && m.kind === 'external') {
        skippedDueToExternal++;
        continue;
      }
      if (i > bestLevel) {
        bestMethodology = m;
        bestLevel = i;
      }
    }
  }

  if (!bestMethodology) {
    // No applicable methodology found. If this was an external failure and we
    // skipped external methodologies, check if ALL internal methodologies are
    // also exhausted. If so, signal external backoff — wait for the external
    // service to recover instead of burning cycles.
    const internalMethodologies = METHODOLOGIES.filter(m => m.kind === 'internal');
    const internalTried = internalMethodologies.filter(m => _triedMethodologies.has(m.id)).length;
    const allInternalExhausted = internalTried === internalMethodologies.length;

    if (failureKind === 'external' && allInternalExhausted) {
      // All internal recovery exhausted on an external failure — the bot has
      // done everything it can control. The remaining problem is the external
      // service being down. Signal backoff: wait for it to recover.
      const backoffMinutes = lastResort ? 5 : 10;
      _log(
        `All internal methodologies exhausted (${internalTried}/${internalMethodologies.length}) on EXTERNAL failure #${consecutiveFailures}. ` +
        `The bot has done everything it controls. The remaining problem is an external service (provider/network/site) being down. ` +
        `Signaling ${backoffMinutes}min backoff — wait for recovery instead of burning cycles. ` +
        `Skipped ${skippedDueToExternal} external methodology(ies) (not applicable to external failures).`,
        'WARN'
      );
      _saveState();
      return {
        change: null as any,
        reason: `external backoff — all internal methodologies exhausted, external service appears down`,
        failureKind: 'external',
        externalBackoffMinutes: backoffMinutes,
      } as any;
    }

    // All methodologies tried (or all applicable ones tried). Log exhaustion.
    const applicableCount = failureKind === 'external'
      ? METHODOLOGIES.filter(m => m.kind === 'internal').length
      : METHODOLOGIES.length;
    const applicableTried = failureKind === 'external'
      ? METHODOLOGIES.filter(m => m.kind === 'internal' && _triedMethodologies.has(m.id)).length
      : _triedMethodologies.size;
    if (applicableTried >= applicableCount && _lastRotationAt > 0) {
      _log(
        `All ${applicableCount} applicable methodologies exhausted (failure #${consecutiveFailures}, kind: ${failureKind}). ` +
        `Continuing to retry with the last methodology (${_activeMethodology}). Consider manual investigation.`,
        'WARN'
      );
    }
    _saveState();
    return null;
  }

  _currentLevel = bestLevel;
  _triedMethodologies.add(bestMethodology.id);
  _activeMethodology = bestMethodology.id;
  _lastRotationAt = Date.now();
  _totalRotations++;
  _recordAttempt(bestMethodology.id);

  if (!_episodeId) {
    _episodeId = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    _totalEpisodes++;
  }

  const thresholdNote = lastResort
    ? `last-resort accelerated — threshold compressed from ${bestMethodology.threshold} to ${LAST_RESORT_THRESHOLDS[bestMethodology.id]}`
    : `threshold ${bestMethodology.threshold}`;
  const kindNote = bestMethodology.kind === 'external'
    ? ` [EXTERNAL — depends on a service being up]`
    : ` [INTERNAL — bot fully controls this]`;
  const reason = `failure #${consecutiveFailures} (${thresholdNote}, kind: ${failureKind}${kindNote})`;

  _log(
    `Methodology rotation: switching to "${bestMethodology.id}" — ${reason}. ` +
    `Level ${bestLevel + 1}/${METHODOLOGIES.length}. Tried: [${Array.from(_triedMethodologies).join(', ')}]. ` +
    (skippedDueToExternal > 0 ? `Skipped ${skippedDueToExternal} external methodology(ies) (failure is external). ` : '') +
    `${bestMethodology.description}`,
    'WARN'
  );

  _saveState();

  return {
    change: {
      id: bestMethodology.id,
      description: bestMethodology.description,
      level: bestLevel,
    },
    reason,
    failureKind,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Reset episode — called on success or auto-reset
// ═══════════════════════════════════════════════════════════════════════

function _resetEpisode(): void {
  // Record which methodology was active when success happened
  if (_activeMethodology) {
    _recordSuccess(_activeMethodology);
  }
  const prevTried = Array.from(_triedMethodologies);
  _currentLevel = 0;
  _triedMethodologies = new Set();
  _lastFailureCount = 0;
  _activeMethodology = null;
  _episodeId = '';
  _consecutiveZeroQuestionCycles = 0;
  if (prevTried.length > 0) {
    _log(`Failure episode resolved. Methodologies tried: [${prevTried.join(', ')}]. Resetting to Level 0.`, 'INFO');
  }
  _saveState();
}

function onSuccess(): void {
  _resetEpisode();
}

// ═══════════════════════════════════════════════════════════════════════
// Apply a methodology change — execute the actual switch
// ═══════════════════════════════════════════════════════════════════════

async function applyChange(change: { id: string; description: string; level: number }, deps: {
  database?: any;
  browser?: any;
  page?: any;
  config?: any;
  currentState?: string;
}): Promise<boolean> {
  const db = deps.database?.db || _getDb();
  const page = deps.page || _deps.browser?.page;
  const config = deps.config || _deps.config;

  try {
    switch (change.id) {
      case 'invalidate_templates': {
        if (!db) return false;
        // Delete templates for the current state hash (if provided) — re-derive from fresh screenshot.
        // If no state provided, clear all templates (nuclear — forces full re-derivation).
        const stateHash = deps.currentState;
        if (stateHash) {
          const info = db.prepare('DELETE FROM template_cache WHERE hash = ?').run(stateHash);
          _log(`Invalidated ${info.changes} template(s) for state ${stateHash}.`, 'INFO');
        } else {
          const info = db.prepare('DELETE FROM template_cache').run();
          _log(`Invalidated ALL ${info.changes} cached templates (no state specified — full re-derivation).`, 'INFO');
        }
        // Also invalidate action_cache entries for the current state (if action_cache exists)
        try {
          if (stateHash) {
            db.prepare('DELETE FROM action_cache WHERE current_state = ?').run(stateHash);
          }
        } catch { /* action_cache might not exist or have different schema */ }
        return true;
      }

      case 'switch_model_fallback':
      case 'switch_model_next': {
        if (!db) return false;
        // Get the current active model
        const active = db.prepare("SELECT model_id, provider FROM model_registry WHERE role = 'active' LIMIT 1").get();
        if (!active) { _log('No active model found to switch from.', 'WARN'); return false; }
        // Mark the current provider unhealthy — we're switching BECAUSE it's failing.
        // This prevents the rotator from switching BACK to it in future rotations.
        markProviderUnhealthy(active.provider);
        // Get all working models (excluding the current active one), filtered to
        // HEALTHY providers only — don't rotate TO a provider we know is down.
        const allCandidates = db.prepare(
          "SELECT model_id, provider FROM model_registry WHERE is_working = 1 AND model_id != ? ORDER BY last_success_at DESC"
        ).all(active.model_id);
        const candidates = allCandidates.filter((c: any) => isProviderHealthy(c.provider));
        if (candidates.length === 0) {
          const unhealthyCount = allCandidates.length;
          _log(
            `No healthy alternative models available. ${unhealthyCount} candidate(s) exist but all are marked unhealthy ` +
            `(providers: ${allCandidates.map((c: any) => c.provider).join(', ')}). ` +
            `Cannot switch model — all providers appear to be down. This is an external failure (out of the bot's control).`,
            'WARN'
          );
          return false;
        }
        // For switch_model_next, skip the fallback and pick the 2nd candidate (or rotate)
        let target;
        if (change.id === 'switch_model_fallback') {
          // Prefer the registered fallback (if healthy), else the first healthy candidate
          const fallback = db.prepare("SELECT model_id, provider FROM model_registry WHERE role = 'fallback' LIMIT 1").get();
          target = (fallback && isProviderHealthy(fallback.provider)) ? fallback : candidates[0];
        } else {
          // switch_model_next: pick a healthy candidate that isn't the current fallback
          const fallback = db.prepare("SELECT model_id FROM model_registry WHERE role = 'fallback' LIMIT 1").get();
          target = candidates.find((c: any) => c.model_id !== fallback?.model_id) || candidates[0];
        }
        if (!target) { _log('No healthy target model to switch to.', 'WARN'); return false; }
        // Demote current active to candidate, promote target to active
        db.prepare("UPDATE model_registry SET role = 'candidate' WHERE model_id = ?").run(active.model_id);
        db.prepare("UPDATE model_registry SET role = 'active' WHERE model_id = ?").run(target.model_id);
        _log(`Switched active model: ${active.provider}/${active.model_id} → ${target.provider}/${target.model_id}. Previous provider marked unhealthy.`, 'WARN');
        return true;
      }

      case 'page_reload':
      case 'clear_cache_reload': {
        if (!page) { _log('No page available for reload.', 'WARN'); return false; }
        if (change.id === 'clear_cache_reload') {
          try {
            // Clear cookies for the current domain
            const context = page.context();
            await context.clearCookies();
            _log('Cleared browser cookies for the domain.', 'INFO');
          } catch (e: any) { _log(`Cookie clear failed (non-fatal): ${e?.message}`, 'DEBUG'); }
          // Clear in-page caches
          try {
            await page.evaluate(() => {
              if ('caches' in window) caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
              if ('sessionStorage' in window) sessionStorage.clear();
              if ('localStorage' in window) localStorage.clear();
            });
            _log('Cleared in-page caches (sessionStorage, localStorage, Cache API).', 'INFO');
          } catch (e: any) { _log(`In-page cache clear failed (non-fatal): ${e?.message}`, 'DEBUG'); }
        }
        await page.reload({ waitUntil: 'load', timeout: 30000 });
        _log(`Page reloaded${change.id === 'clear_cache_reload' ? ' (after cache clear)' : ''}.`, 'INFO');
        return true;
      }

      case 'rotate_session': {
        // Delegate to the auth guard's session rotation (tryAllSessions)
        try {
          const authGuard = require('./cycle-auth-guard');
          if (authGuard?.tryAllSessions) {
            _log('Rotating session via auth guard (tryAllSessions).', 'INFO');
            await authGuard.tryAllSessions();
            return true;
          }
        } catch {}
        // Fallback: clear the session pool and let re-auth happen naturally
        if (db) {
          try {
            db.prepare('DELETE FROM session_pool').run();
            _log('Cleared session pool — bot will re-authenticate on next cycle.', 'WARN');
            return true;
          } catch {}
        }
        _log('No session rotation mechanism available.', 'WARN');
        return false;
      }

      case 'restart_browser': {
        // Delegate to the browser manager (if available)
        try {
          const browserMod = deps.browser || _deps.browser;
          if (browserMod?.restartBrowser) {
            _log('Restarting browser via browser manager.', 'WARN');
            await browserMod.restartBrowser();
            return true;
          }
          if (browserMod?.launch) {
            _log('Relaunching browser via browser manager.', 'WARN');
            const oldBrowser = browserMod.browser;
            if (oldBrowser) { try { await oldBrowser.close(); } catch {} }
            await browserMod.launch();
            return true;
          }
        } catch (e: any) { _log(`Browser restart failed: ${e?.message}`, 'ERROR'); }
        _log('No browser restart mechanism available — skipping (page reload will have to suffice).', 'WARN');
        return false;
      }

      case 'hot_swap_modules': {
        // WORST-CASE INTERNAL RECOVERY: swap the currently-active code modules
        // for their known-good backups. If a module has a bug that surfaced
        // under load (memory leak, race condition, edge case), this swaps in
        // the backup version WITHOUT restarting the process. The bot fully
        // controls this — no external dependency.
        try {
          const hotSwap = require('./self-heal-hot-swap');
          if (hotSwap?.hotSwapModules) {
            // Swap all registered backup modules (the hot-swap module knows
            // which files have backups available).
            const registeredFiles = hotSwap.getRegisteredFiles?.() || [];
            if (registeredFiles.length === 0) {
              _log('No backup modules registered for hot-swap. Skipping (self_heal_code will run next).', 'WARN');
              return false;
            }
            _log(`Hot-swapping ${registeredFiles.length} module(s) to backup versions: [${registeredFiles.join(', ')}].`, 'WARN');
            const summary = hotSwap.hotSwapModules(registeredFiles);
            const swapped = summary?.results?.filter((r: any) => r.swapped).length || 0;
            _log(`Hot-swap complete: ${swapped}/${registeredFiles.length} module(s) swapped successfully.`, swapped > 0 ? 'INFO' : 'WARN');
            return swapped > 0;
          }
        } catch (e: any) { _log(`Hot-swap failed: ${e?.message}`, 'ERROR'); }
        _log('No hot-swap mechanism available — skipping (self_heal_code will run next).', 'WARN');
        return false;
      }

      case 'self_heal_code': {
        // DEEPEST INTERNAL RECOVERY: trigger a full self-heal pass. The bot
        // fixes and improves its OWN systems — re-derives all templates,
        // re-validates all selectors, promotes any quarantined modules,
        // patches the action pipeline. This is the "the bot can fix and
        // improve that" tier. No external dependency.
        try {
          // Try the cycle's self-heal trigger (if accessible)
          const selfHeal = require('./self-heal');
          if (selfHeal?.performFullSelfHeal) {
            _log('Triggering full self-heal pass (self-heal.performFullSelfHeal). The bot is fixing its own systems — re-deriving templates, validating selectors, patching the action pipeline.', 'WARN');
            const result = await selfHeal.performFullSelfHeal();
            _log(`Full self-heal complete: ${typeof result === 'string' ? result : JSON.stringify(result)}.`, 'INFO');
            return true;
          }
          if (selfHeal?.runSelfHeal) {
            _log('Triggering self-heal pass (self-heal.runSelfHeal).', 'WARN');
            await selfHeal.runSelfHeal();
            return true;
          }
        } catch (e: any) { _log(`Self-heal trigger failed: ${e?.message}`, 'ERROR'); }
        // Fallback: invalidate ALL internal caches to force full re-derivation
        // on the next cycle. This is the bot clearing its own state — fully internal.
        if (db) {
          try {
            let cleared = 0;
            const tablesToClear = ['template_cache', 'ui_baselines', 'selector_versions'];
            for (const table of tablesToClear) {
              try {
                const info = db.prepare(`DELETE FROM ${table}`).run();
                cleared += info.changes;
              } catch { /* table may not exist */ }
            }
            _log(`Self-heal fallback: cleared ${cleared} internal cache entries across ${tablesToClear.length} tables. Bot will re-derive everything from scratch on next cycle.`, 'WARN');
            return true;
          } catch (e: any) { _log(`Self-heal fallback (cache clear) failed: ${e?.message}`, 'ERROR'); }
        }
        _log('No self-heal mechanism available. The bot has exhausted all internal recovery options.', 'ERROR');
        return false;
      }

      case 'skip_question': {
        // Mark the current question as skipped — the cycle will move to the next one.
        // This is handled by the cycle loop itself (the rotator just signals the intent).
        _log('Signaling skip-question: current question appears unanswerable. The cycle should move to the next question.', 'WARN');
        // Set a flag the cycle can check
        try {
          const upsertCal = _getCalibration();
          if (upsertCal) upsertCal.run('skip_current_question', String(Date.now()));
        } catch {}
        return true;
      }

      default:
        _log(`Unknown methodology: ${change.id}`, 'ERROR');
        return false;
    }
  } catch (err: any) {
    _log(`Methodology change "${change.id}" failed: ${err?.message || err}`, 'ERROR');
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════════════

function getStatus(): Record<string, any> {
  const history = _loadHistory();
  const internalMethodologies = METHODOLOGIES.filter(m => m.kind === 'internal');
  const externalMethodologies = METHODOLOGIES.filter(m => m.kind === 'external');
  return {
    currentLevel: _currentLevel,
    currentLevelName: _currentLevel > 0 && _currentLevel < METHODOLOGIES.length
      ? METHODOLOGIES[_currentLevel].id : 'none (level 0)',
    triedMethodologies: Array.from(_triedMethodologies),
    activeMethodology: _activeMethodology,
    consecutiveZeroQuestionCycles: _consecutiveZeroQuestionCycles,
    lastFailureCount: _lastFailureCount,
    lastRotationAt: _lastRotationAt,
    lastRotationAgeMin: _lastRotationAt ? Math.round((Date.now() - _lastRotationAt) / 60000) : null,
    episodeId: _episodeId,
    totalRotations: _totalRotations,
    totalEpisodes: _totalEpisodes,
    ladderSize: METHODOLOGIES.length,
    methodologiesRemaining: METHODOLOGIES.length - _triedMethodologies.size,
    lastResortAccelerated: _isLastResortActive(),
    history,
    // Failure classification stats
    internalMethodologies: internalMethodologies.map(m => m.id),
    externalMethodologies: externalMethodologies.map(m => m.id),
    internalMethodologyCount: internalMethodologies.length,
    externalMethodologyCount: externalMethodologies.length,
    // Provider health
    unhealthyProviders: getProviderHealth(),
    unhealthyProviderCount: _unhealthyProviders.size,
  };
}

function selfTest(): Record<string, any> {
  const checks: string[] = [];

  if (METHODOLOGIES.length !== 10) checks.push(`expected 10 methodologies, got ${METHODOLOGIES.length}`);
  for (const m of METHODOLOGIES) {
    if (!m.id || !m.description || typeof m.threshold !== 'number') {
      checks.push(`methodology ${m.id} has incomplete fields`);
    }
    if (m.kind !== 'internal' && m.kind !== 'external') {
      checks.push(`methodology ${m.id} has invalid kind: ${m.kind}`);
    }
  }
  // Verify all methodologies have a last-resort threshold
  for (const m of METHODOLOGIES) {
    if (!(m.id in LAST_RESORT_THRESHOLDS)) {
      checks.push(`${m.id} missing from LAST_RESORT_THRESHOLDS`);
    }
  }
  // Verify thresholds are ascending (escalation ladder)
  for (let i = 1; i < METHODOLOGIES.length; i++) {
    if (METHODOLOGIES[i].threshold <= METHODOLOGIES[i - 1].threshold) {
      checks.push(`threshold not ascending at index ${i}: ${METHODOLOGIES[i].threshold} <= ${METHODOLOGIES[i - 1].threshold}`);
    }
  }
  // Verify last-resort thresholds are ascending
  const lrThresholds = METHODOLOGIES.map(m => LAST_RESORT_THRESHOLDS[m.id]);
  for (let i = 1; i < lrThresholds.length; i++) {
    if (lrThresholds[i] <= lrThresholds[i - 1]) {
      checks.push(`last-resort threshold not ascending at index ${i}`);
    }
  }
  // Verify all last-resort thresholds < normal thresholds (acceleration)
  for (const m of METHODOLOGIES) {
    if (LAST_RESORT_THRESHOLDS[m.id] >= m.threshold) {
      checks.push(`${m.id}: last-resort threshold (${LAST_RESORT_THRESHOLDS[m.id]}) should be < normal (${m.threshold})`);
    }
  }
  // Verify the DEEPEST 3 methodologies are all internal (worst case = internal,
  // per the user's design principle)
  const deepest3 = METHODOLOGIES.slice(-3);
  for (const m of deepest3) {
    if (m.kind !== 'internal') {
      checks.push(`deepest methodology ${m.id} should be internal (worst case must be bot-controllable), got ${m.kind}`);
    }
  }
  // Verify failure classification
  if (classifyFailure('E_NETWORK_TIMEOUT') !== 'external') checks.push('E_NETWORK_TIMEOUT should classify as external');
  if (classifyFailure('E_RATE_LIMITED') !== 'external') checks.push('E_RATE_LIMITED should classify as external');
  if (classifyFailure('E_SELECTOR_DRIFT') !== 'internal') checks.push('E_SELECTOR_DRIFT should classify as internal');
  if (classifyFailure('E_STATE_DEADLOCK') !== 'internal') checks.push('E_STATE_DEADLOCK should classify as internal');
  if (classifyFailure(undefined, 'HTTP 503 Service Unavailable') !== 'external') checks.push('503 message should classify as external');
  if (classifyFailure(undefined, 'ETIMEDOUT') !== 'external') checks.push('ETIMEDOUT should classify as external');
  if (classifyFailure('E_UNKNOWN') !== 'internal') checks.push('E_UNKNOWN should default to internal');
  // Verify provider health tracking
  if (!isProviderHealthy('test-provider')) checks.push('unmarked provider should be healthy');
  markProviderUnhealthy('test-provider');
  if (isProviderHealthy('test-provider')) checks.push('marked provider should be unhealthy');

  return {
    ok: checks.length === 0,
    checks,
    ladderSize: METHODOLOGIES.length,
    internalCount: METHODOLOGIES.filter(m => m.kind === 'internal').length,
    externalCount: METHODOLOGIES.filter(m => m.kind === 'external').length,
    methodologies: METHODOLOGIES.map(m => ({ id: m.id, threshold: m.threshold, kind: m.kind, lastResortThreshold: LAST_RESORT_THRESHOLDS[m.id] })),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════

function start(): void {
  if (_interval) return;
  _loadState(); // Load persisted state (continue escalation across restarts)
  _loadUnhealthyProviders(); // Load persisted unhealthy providers (survive restarts)
  _log(
    `Started. Ladder: ${METHODOLOGIES.length} methodologies ` +
    `(${METHODOLOGIES.filter(m => m.kind === 'internal').length} internal, ${METHODOLOGIES.filter(m => m.kind === 'external').length} external). ` +
    `Worst-case (deepest) methodologies are all internal — the bot relies on its own systems when external services are down. ` +
    `State persisted (survives restarts). ${_unhealthyProviders.size} provider(s) currently marked unhealthy.`,
    'INFO'
  );
  // Periodic state save (in case onFailure isn't called for a while)
  _interval = setInterval(() => { _saveState(); }, 5 * 60 * 1000);
  if (typeof _interval.unref === 'function') _interval.unref();
}

function stop(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _saveState(); // Final save
}

function _resetForTest(): void {
  if (_interval) clearInterval(_interval);
  _interval = null;
  _currentLevel = 0;
  _triedMethodologies = new Set();
  _lastFailureCount = 0;
  _lastRotationAt = 0;
  _episodeId = '';
  _activeMethodology = null;
  _totalRotations = 0;
  _totalEpisodes = 0;
  _consecutiveZeroQuestionCycles = 0;
  _unhealthyProviders = new Map();
}

module.exports = {
  start,
  stop,
  onCycleComplete,
  onFailure,
  onSuccess,
  applyChange,
  getStatus,
  selfTest,
  classifyFailure,
  markProviderUnhealthy,
  isProviderHealthy,
  getProviderHealth,
  _injectDependencies,
  _resetForTest,
  _loadState,
  _saveState,
  METHODOLOGIES,
  LAST_RESORT_THRESHOLDS,
  EXTERNAL_ERROR_CODES,
  INTERNAL_ERROR_CODES,
  STATE_KEY,
  HISTORY_KEY,
};
