'use strict';

// Lazy requires to avoid top-level circular dependency chain
const { getAvailableProviders, addProviderFailure, recordProviderResult } = require('./providers-registry');

// TASK 54 (2026-09-11): Sequential single-provider mode.
// When the bot has proven it lacks providers across restarts (persisted in DB),
// switch from calling ALL providers in parallel to calling ONE provider at a time.
// The providers are already sorted by health score (trust) by the registry's
// getAvailableProviders() — highest health score first. We just use that order.
let _sequentialMode: boolean | null = null; // null = not checked yet
let _sequentialModeLastCheck: number = 0; // timestamp of last DB check
const SEQUENTIAL_MODE_RECHECK_MS = 60 * 1000; // re-check DB every 60s (catches midnight reset)

// TASK 69 (2026-09-22): Instant parallel→sequential switch.
// When a parallel tribunal round produces 0 valid responses (all providers
// failed: 429 rate-limit, 5xx outage, EOL model, network error, etc.), set
// this flag so the VERY NEXT tribunal call uses sequential mode — no 60s
// DB re-check wait, no 30-min "no providers" timer wait.
// Cleared after a successful sequential round (so we can try parallel again).
let _forceSequentialNext: boolean = false;

function _isSequentialMode(): boolean {
  // TASK 69: If force flag is set, use sequential IMMEDIATELY (no DB read).
  // This is set in-process when parallel mode fails entirely.
  if (_forceSequentialNext) return true;
  // TASK 60 (2026-09-11): Re-check DB periodically so the midnight reset
  // in services-work-shifts.ts takes effect without requiring a restart.
  const now = Date.now();
  if (_sequentialMode !== null && (now - _sequentialModeLastCheck) < SEQUENTIAL_MODE_RECHECK_MS) {
    return _sequentialMode;
  }
  try {
    const db = require('./database');
    const row = db.selectCalibration?.get('sequential_provider_mode');
    _sequentialMode = row && row.value === 'true';
    _sequentialModeLastCheck = now;
  } catch {
    _sequentialMode = false;
  }
  return _sequentialMode;
}

/**
 * TASK 69: Trigger sequential mode for the next tribunal call (and persist).
 * Called by the tribunal itself when a parallel round fails entirely, OR
 * externally by the cycle manager when it detects a no-providers situation.
 * Safe to call multiple times — idempotent.
 */
function triggerSequentialMode(reason: string = 'parallel round failed'): void {
  if (!_forceSequentialNext) {
    _forceSequentialNext = true;
    try {
      const { log } = _getLogger();
      log(`Tribunal: INSTANT switch to SEQUENTIAL MODE — reason: ${reason}. Next round will try providers one at a time.`, 'WARN', 'tribunal');
    } catch {}
  }
  // Persist to DB so it survives restarts (idempotent — only writes if not already true)
  try {
    const db = require('./database');
    const row = db.selectCalibration?.get('sequential_provider_mode');
    if (!row || row.value !== 'true') {
      db.upsertCalibration?.run('sequential_provider_mode', 'true', Date.now());
      // Update cached value so _isSequentialMode sees it immediately
      _sequentialMode = true;
      _sequentialModeLastCheck = Date.now();
    }
  } catch {}
}

/**
 * TASK 69: Clear the instant force flag (allow trying parallel again).
 * Called after a successful sequential round so the tribunal can attempt
 * parallel mode on the next cycle (since parallel gives weighted consensus
 * across multiple providers — strictly better than a single-provider result).
 *
 * TASK 85 (2026-09-25): Also clear the DB flag `sequential_provider_mode`.
 * Previously, only the in-memory `_forceSequentialNext` flag was cleared,
 * but the DB flag persisted — so the bot stayed in sequential mode (calling
 * only 1 provider) even after a successful sequential round. This caused
 * the bot to only use Agnes and never try the other 6 providers in parallel.
 */
function _clearSequentialForceFlag(): void {
  if (_forceSequentialNext) {
    _forceSequentialNext = false;
    try {
      const { log } = _getLogger();
      log('Tribunal: sequential round succeeded — clearing instant force flag. Next round will try parallel mode.', 'INFO', 'tribunal');
    } catch {}
  }
  // TASK 85: Also clear the DB flag so the next cycle uses parallel mode.
  // This is idempotent — safe to call when the flag is already false.
  try {
    const db = require('./database');
    const row = db.selectCalibration?.get('sequential_provider_mode');
    if (row && row.value === 'true') {
      db.upsertCalibration?.run('sequential_provider_mode', 'false', Date.now());
      _sequentialMode = false;
      _sequentialModeLastCheck = Date.now();
      try {
        const { log } = _getLogger();
        log('Tribunal: cleared sequential_provider_mode DB flag — next cycle will try parallel mode with ALL providers.', 'INFO', 'tribunal');
      } catch {}
    }
  } catch {}
}

// Lazy logger - loaded on first use
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

// Lazy providers-base - loaded on first use
let _providersBase: any = null;
let _baseFailed = false;
function _getProvidersBase() {
  if (_baseFailed) return null;
  if (!_providersBase) {
    try {
      _providersBase = require('./providers-base');
    } catch (err: any) {
      _getLogger().log(`providers-base failed to load: ${String(err.message || err).substring(0, 200)}`, 'ERROR', 'tribunal');
      _baseFailed = true;
      return null;
    }
  }
  return _providersBase;
}

// Lazy providers-prompts - loaded on first use
// Guarded: if the module is corrupted (OOM heap damage, bad overlay),
// fall back to a minimal prompt so the tribunal can still function.
let _prompts: any = null;
let _promptsFailed = false;
function _getPrompts() {
  if (_promptsFailed) return _getFallbackPrompts();
  if (!_prompts) {
    try {
      _prompts = require('./providers-prompts');
    } catch (err: any) {
      _getLogger().log(`providers-prompts failed to load, using minimal fallback: ${String(err.message || err).substring(0, 200)}`, 'WARN', 'tribunal');
      _promptsFailed = true;
      return _getFallbackPrompts();
    }
  }
  return _prompts;
}

/** Minimal prompt stubs when providers-prompts.ts is corrupted. */
function _getFallbackPrompts() {
  return {
    getSystemPrompt: () => 'You are an AI assistant controlling a web browser to solve math problems on a website. Analyze the screenshot and decide the next action. Return JSON with actionType, currentState, reasoning, targetX, targetY, confidence.',
    getUserInstruction: () => 'Analyze the screenshot. Return a JSON object with: actionType (click/input_email/input_password/keypad_input/flutter_tap/flutter_swipe/scroll_vertical/scroll_horizontal/wait), currentState (describe what you see), reasoning (why), targetX, targetY (pixel coordinates), confidence (0-1). AUTH: On login pages, ALWAYS click "Sign in with Microsoft". NEVER type in phone number fields.',
  };
}

// Lazy health module - loaded on first use
let _healthMod: any = null;
function _getHealth() { if (!_healthMod) _healthMod = require('./providers-health'); return _healthMod; }

// ===============================================================================
// WEIGHTED CONSENSUS ALGORITHM (P12)
// ===============================================================================
//
// Each provider vote is weighted by three factors:
//   1. Health score (0.0-1.0) - from providers-health, reflects success rate,
//      latency, error diversity, recency
//   2. Confidence (0.0-1.0) - extracted from the provider's response if it
//      includes a 'confidence' field, otherwise estimated from reasoning length
//   3. Latency inverse (normalized) - faster responses get slightly higher
//      weight (1 / normalizedLatency), capped to prevent extreme values
//
// Final weight = healthScore * confidence * latencyInverse
//
// Consensus: the action with the highest TOTAL weight wins, provided it has
// at least 30% of the total weight (prevents a single high-weight outlier
// from dominating). If no action reaches 30%, the highest-weight action
// still wins (fail-open - better than returning 'wait' and idling).

interface WeightedVote {
  action: any;
  providerName: string;
  healthScore: number;
  confidence: number;
  latencyMs: number;
  weight: number;
}

interface WeightedConsensus {
  winningAction: any;
  totalWeight: number;
  winnerWeight: number;
  agreementPct: number;
  clusterSize: number;
  totalVoters: number;
  details: Array<{ providerName: string; actionType: string; weight: number }>;
}

/**
 * Estimate confidence from a provider response.
 * If the response includes a numeric 'confidence' field, use it.
 * Otherwise, estimate from reasoning length: longer reasoning = higher confidence.
 * Range: 0.0 - 1.0
 */
function extractConfidence(action: any): number {
  if (!action) return 0.5;
  // Explicit confidence from LLM response
  if (typeof action.confidence === 'number' && action.confidence >= 0 && action.confidence <= 1) {
    return action.confidence;
  }
  // FIX: Use neutral default instead of verbosity-based heuristic.
  // Length of reasoning does not correlate with accuracy — verbose models
  // get artificially high confidence. Return a flat neutral value.
  return 0.5;
}

/**
 * Compute latency inverse weight.
 * Faster responses get higher weight, but capped to prevent
 * a 100ms response from completely dominating a 5000ms one.
 * Uses reciprocal with floor: 1 / max(latency, 500)
 * Then normalized across all votes.
 */
function computeLatencyInverse(latencyMs: number, minLatency: number, maxLatency: number): number {
  if (maxLatency <= minLatency) return 1.0;
  // Normalize to 0.0-1.0 range (inverse: lower latency = higher value)
  const normalized = 1.0 - ((latencyMs - minLatency) / (maxLatency - minLatency));
  // Apply floor at 0.5 so even the slowest provider retains some influence
  return Math.max(0.5, Math.min(1.0, normalized + 0.5));
}

/**
 * Run the weighted consensus algorithm.
 * Returns the consensus result or null if no valid votes.
 */
function findWeightedConsensus(votes: WeightedVote[]): WeightedConsensus | null {
  if (votes.length === 0) return null;

  // Single voter - accept directly
  if (votes.length === 1) {
    return {
      winningAction: votes[0].action,
      totalWeight: votes[0].weight,
      winnerWeight: votes[0].weight,
      agreementPct: 1.0,
      clusterSize: 1,
      totalVoters: 1,
      details: [{ providerName: votes[0].providerName, actionType: votes[0].action.actionType, weight: votes[0].weight }],
    };
  }

  // Group votes by actionType only.
  // v13: Removed currentState from the cluster key. currentState is a
  // free-text description that naturally varies between providers
  // ("loading" vs "signin_page" vs "unknown" for the same visual).
  // Clustering on it split unanimous "wait" votes into separate clusters,
  // producing phantom low-agreement warnings. The tribunal cares about
  // whether providers agree on the ACTION, not the state label.
  const clusters = new Map<string, WeightedVote[]>();
  for (const vote of votes) {
    const key = vote.action.actionType;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(vote);
  }

  // Sum weights per cluster
  const clusterWeights = new Map<string, number>();
  for (const [key, clusterVotes] of clusters) {
    const totalWeight = clusterVotes.reduce((sum, v) => sum + v.weight, 0);
    clusterWeights.set(key, totalWeight);
  }

  // Total weight across all votes
  const totalWeight = votes.reduce((sum, v) => sum + v.weight, 0);

  // Find the cluster with highest total weight
  let bestKey = '';
  let bestWeight = -1;
  for (const [key, weight] of clusterWeights) {
    if (weight > bestWeight) { bestWeight = weight; bestKey = key; }
  }

  const bestCluster = clusters.get(bestKey)!;
  const rep = bestCluster[0].action;
  const agreementPct = totalWeight > 0 ? bestWeight / totalWeight : 0;

  // Build details for logging
  const details = votes.map(v => ({
    providerName: v.providerName,
    actionType: v.action.actionType,
    weight: Math.round(v.weight * 1000) / 1000,
  }));

  return {
    winningAction: rep,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    winnerWeight: Math.round(bestWeight * 1000) / 1000,
    agreementPct: Math.round(agreementPct * 100) / 100,
    clusterSize: bestCluster.length,
    totalVoters: votes.length,
    details,
  };
}

// ===============================================================================
// BLANK IMAGE DETECTION
// ===============================================================================
//
// Fast pixel-level check: decode base64, sample N points, check if the image
// is essentially one flat color (blank white/gray page). If so, short-circuit
// the tribunal immediately — no point burning 7 provider calls on nothing.
//
// A JPEG of a solid white 1280×720 compresses to ~3-5 KB, so size alone
// is unreliable. We sample pixel variance instead.
//
// Cost: ~2-5ms (decode + sample). Saves: ~45s of wasted tribunal + API quota.

/**
 * Check if a base64 image is blank (uniform color, no visible content).
 * Samples 256 pixels from the decoded buffer and checks color variance.
 * Returns true if the image is blank.
 */
function isBlankImage(base64Image: string): boolean {
  try {
    const buf = Buffer.from(base64Image, 'base64');
    if (buf.length < 500) return true; // suspiciously tiny

    // Try to decode as JPEG or PNG
    // JPEG: SOI marker FF D8. PNG: signature 89 50 4E 47
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;

    // For JPEG, we can't easily decode raw pixels without sharp/jimp.
    // Instead, check the buffer size + byte entropy as a heuristic.
    // A blank white JPEG has very low byte entropy (repeated DCT blocks).
    if (isJpeg) {
      // Check byte entropy on a sample of the buffer (skip headers)
      const sampleStart = Math.min(200, buf.length - 1); // skip JPEG headers
      const sampleLen = Math.min(4096, buf.length - sampleStart);
      if (sampleLen <= 0) return true;

      // Count unique byte values in the sample
      const seen = new Set<number>();
      for (let i = sampleStart; i < sampleStart + sampleLen; i++) {
        seen.add(buf[i]);
      }
      // A blank white JPEG has very few unique byte values (< 40)
      // A real screenshot typically has 100+ unique byte values in any 4KB window
      if (seen.size < 40) {
        return true;
      }
    }

    if (isPng) {
      // PNGs store raw pixel data. For a blank image, most pixels will be
      // the same color. Sample the raw byte values (after PNG headers).
      // A blank PNG's raw data after the 8-byte signature will be mostly
      // repeated IDAT chunk data with very low variance.
      const sampleLen = Math.min(8192, buf.length - 8);
      if (sampleLen <= 0) return true;

      const seen = new Set<number>();
      for (let i = 8; i < 8 + sampleLen; i++) {
        seen.add(buf[i]);
      }
      if (seen.size < 30) {
        return true;
      }
    }

    // For non-JPEG/PNG or ambiguous cases, also check total file size.
    // A real screenshot at quality 30, 768px wide should be > 10KB.
    // A blank white page at those settings is typically < 8KB.
    if (buf.length < 3000) return true;

    return false;
  } catch {
    // If we can't decode, assume not blank (safer — don't skip real pages)
    return false;
  }
}

// ===============================================================================
// TRIBUNAL EXECUTION
// ===============================================================================

async function runTribunal(base64Image: any, pageUrl: any = null, uiMap: any = null, signal: any = null) {
  const { log } = _getLogger();

  // ── Blank image guard ──
  // If the screenshot is a blank/white page, immediately return 'wait'
  // IMPORTANT: BUG FIX (2026-09-06) — DISABLED the byte-entropy blank check.
  // The old code used isBlankImage(base64Image) to skip providers if the
  // screenshot "appeared blank" by checking JPEG byte entropy. But this is
  // a LOSSY heuristic that false-positives on compressed JPEGs of dark or
  // low-contrast pages. The cycle manager's pixel-level blank detection
  // (auth-guard._isPageBlank) is FAR more accurate — it decodes the PNG,
  // samples 35 pixels, and computes actual RGBA standard deviation. If the
  // cycle manager let the screenshot through, it already confirmed the page
  // has content. The tribunal's byte-entropy check was blocking ALL provider
  // calls on pages with dark backgrounds, causing the bot to waste 25 seconds
  // waiting instead of asking the AI what to do.
  //
  // The pixel check (auth-guard) takes priority over byte entropy. If the
  // pixel check says NOT blank, we trust it and proceed to providers.
  // (isBlankImage code is kept above for reference but no longer called.)

  const base = _getProvidersBase();
  const { getSystemPrompt, getUserInstruction } = _getPrompts();

  // --- Get health-weighted providers from registry ---
  const providers = await getAvailableProviders();
  if (providers.length === 0) {
    log('No providers available after health filtering.', 'ERROR', 'tribunal');
    return { actionType: 'wait', currentState: 'error', reasoning: 'No providers', targetX: 0, targetY: 0 };
  }

  // If providers-base is corrupted (OOM heap damage), we can't use
  // safeCall with retries. Call providers directly with basic timeout.
  const safeCall = base?.safeCall || ((fn: any, _label: any, opts: any) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), opts?.timeoutMs || 60000);
    (opts?.signal || signal)?.addEventListener?.('abort', () => controller.abort(), { once: true });
    return fn(controller.signal).finally(() => clearTimeout(timer));
  });

  // --- Build prompt ---
  let mapHint = '';
  if (uiMap) { mapHint = `\nUI MAP (from exploration): ${JSON.stringify(uiMap).substring(0, 500)}\nUse this map to guide actions.\n`; }
  const urlHint = pageUrl ? `\nCURRENT PAGE URL: ${pageUrl}\nUse this URL as an additional hint for state detection.\n` : '';
  const fullPrompt = `${getSystemPrompt()}${urlHint}${mapHint}\n${getUserInstruction()}`;

  const providerNames = providers.map((p: any) => `${p.name}(${(p.healthScore || 0).toFixed(2)})`).join(', ');
  log(`Tribunal: consulting ${providers.length} provider(s) [${providerNames}]`, 'INFO', 'tribunal');

  // ── Pre-provider memory shield ──
  // v8: If heap is above 50% of max-old-space-size, force a page reload
  // (L2 shed) BEFORE calling providers. Provider calls allocate large
  // base64 strings and JSON responses. With 7 parallel providers, each
  // call uses ~100KB transient memory = ~700KB total. On the assignments
  // page, base heap is already ~280MB, so even small allocations can
  // push past the 330MB hard restart threshold.
  //
  // TASK 89 (2026-09-25): Lowered from 70% (268MB) to 50% (192MB).
  // The bot was OOM-looping on the assignments page because the pre-call
  // shield wasn't aggressive enough. At 50%, the shield fires BEFORE
  // memory gets critical, giving GC time to clean up before the provider
  // calls allocate their transient memory.
  const NODE_HEAP_LIMIT_MB = 384;
  const PRE_CALL_SHED_THRESHOLD = NODE_HEAP_LIMIT_MB * 0.5; // 192MB
  const preCallHeapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (preCallHeapMB > PRE_CALL_SHED_THRESHOLD) {
    log(`Pre-provider memory shield: heap=${preCallHeapMB.toFixed(1)}MB > ${PRE_CALL_SHED_THRESHOLD.toFixed(0)}MB — forcing L2 page reload before tribunal calls`, 'WARN', 'tribunal');
    try {
      const memoryMode = require('./memory-mode');
      await memoryMode.shedMemory('pre-tribunal-shield', { preserveBrowser: true, maxLevel: 2 });
    } catch (e: any) {
      log(`Pre-tribunal shed failed: ${e.message}`, 'WARN', 'tribunal');
    }
  }
  // TASK 89: Also force GC before provider calls — clears any dangling
  // references from the previous cycle's screenshot/action processing.
  if (global.gc) {
    try { global.gc(); } catch {}
  }

  // --- Consult providers ---
  // TASK 54 (2026-09-11): If sequential mode is active (proven lack of providers
  // across restarts), call ONE provider at a time, most trusted first.
  // Stop as soon as one succeeds — saves free-tier API quota.
  // Otherwise, call ALL providers in parallel (original behavior).
  const TRIBUNAL_TIMEOUT_MS = 120000; // 120s total
  const tribunalController = new AbortController();
  const tribunalTimeout = setTimeout(() => tribunalController.abort(), TRIBUNAL_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) { tribunalController.abort(); }
    else { signal.addEventListener('abort', () => tribunalController.abort(), { once: true }); }
  }

  let fulfilled: any[] = [];

  if (_isSequentialMode()) {
    // SEQUENTIAL MODE: try providers one at a time, most trusted first.
    // getAvailableProviders() already sorts by health score (highest first),
    // so we just iterate in order — no extra sorting needed.
    log(`Tribunal: SEQUENTIAL MODE — trying providers one at a time (by health score): ${providers.map(p => `${p.name}(${(p.healthScore||0).toFixed(2)})`).join(' → ')}`, 'INFO', 'tribunal');
    for (const provider of providers) {
      if (tribunalController.signal.aborted) break;
      const start = Date.now();
      try {
        const maxRetries = 0;
        const res = await safeCall(
          (sig: any) => provider.fn(base64Image, fullPrompt, sig || signal, { validate: true, maxRetries }),
          `Tribunal ${provider.name}`,
          { url: provider.name, signal: tribunalController.signal }
        );
        const latency = Date.now() - start;
        recordProviderResult(provider.name, true, latency);
        log(`Tribunal: ${provider.name} SUCCEEDED (${latency}ms) — using this result, skipping remaining providers.`, 'INFO', 'tribunal');
        fulfilled = [{ ...res, _model: provider.name, _healthScore: provider.healthScore || 0.5, _latency: latency }];
        // TASK 69: Clear the instant force flag — sequential mode succeeded,
        // so we can try parallel mode on the next cycle (parallel gives
        // weighted consensus across multiple providers, which is strictly
        // better than a single-provider result when quota permits).
        _clearSequentialForceFlag();
        break; // Got a result — don't call any more providers
      } catch (err: any) {
        const latency = Date.now() - start;
        recordProviderResult(provider.name, false, latency);
        addProviderFailure(provider.name, err);
        const errMsg = err && err.message ? String(err.message) : String(err);
        log(`Tribunal: ${provider.name} failed — moving to next provider. (${errMsg.substring(0, 100)})`, 'WARN', 'tribunal');
        // Continue to next provider
      }
    }
    clearTimeout(tribunalTimeout);
  } else {
    // PARALLEL MODE: call all providers at once (original behavior)
    const results: PromiseSettledResult<any>[] = await Promise.allSettled(
      providers.map(async (provider: any) => {
        const start = Date.now();
        try {
          const maxRetries = 0;
          const res = await safeCall(
            (sig: any) => provider.fn(base64Image, fullPrompt, sig || signal, { validate: true, maxRetries }),
            `Tribunal ${provider.name}`,
            { url: provider.name, signal: tribunalController.signal }
          );
          const latency = Date.now() - start;
          recordProviderResult(provider.name, true, latency);
          return { ...res, _model: provider.name, _healthScore: provider.healthScore || 0.5, _latency: latency };
        } catch (err: any) {
          const latency = Date.now() - start;
          recordProviderResult(provider.name, false, latency);
          addProviderFailure(provider.name, err);
          const errMsg = err && err.message ? String(err.message) : String(err);
          log(`Tribunal: ${provider.name} failed: ${errMsg}`, 'WARN', 'tribunal');
          return null;
        }
      })
    );
    clearTimeout(tribunalTimeout);
    fulfilled = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
  }

  const valid = fulfilled.filter(r => {
    if (!r) return false;
    const hasAction = r.actionType && typeof r.actionType === 'string' && r.actionType.trim().length > 0;
    if (!hasAction) {
      log(`Tribunal: filtered malformed result from ${r._model || 'unknown'} (no actionType)`, 'WARN', 'tribunal');
      return false;
    }
    // currentState is desirable but not required - validateActionResponse only
    // mandates actionType. Default to 'unknown' so the vote still counts.
    if (!r.currentState || typeof r.currentState !== 'string' || r.currentState.trim().length === 0) {
      log(`Tribunal: ${r._model || 'unknown'} returned valid action but no currentState - defaulting to 'unknown'`, 'DEBUG', 'tribunal');
      r.currentState = 'unknown';
    }
    return true;
  });

  if (valid.length === 0) {
    log('No valid model responses -- falling back to wait.', 'WARN', 'tribunal');
    // TASK 69 (2026-09-22): If this was a PARALLEL round that produced 0 valid
    // responses, INSTANTLY switch to sequential mode for the next round.
    // Don't wait for the 30-min "no providers" timer in the cycle manager —
    // if all parallel providers just failed, the very next call should try
    // providers one at a time (conserves free-tier API quota, and a single
    // surviving provider can still produce a useful action).
    //
    // The pixel fallback + session-preservation swipe (in the cycle manager)
    // will still run for THIS round's action — the instant switch only
    // affects the NEXT round.
    if (!_isSequentialMode()) {
      triggerSequentialMode(`all ${providers.length} parallel providers returned no valid response`);
    }
    return { actionType: 'wait', currentState: 'error', reasoning: 'No valid responses from any provider', targetX: 0, targetY: 0 };
  }

  // Log success rate for observability - don't abort unless literally nobody responded
  const successRate = valid.length / providers.length;
  log(`Tribunal success: ${valid.length}/${providers.length} (${Math.round(successRate * 100)}%)`, 'INFO', 'tribunal');
  if (successRate < 0.25 && providers.length >= 3) {
    log('Majority of providers unavailable - proceeding with surviving votes', 'WARN', 'tribunal');
  }

  // --- Compute vote weights (P12) ---
  const latencies = valid.map(r => r._latency || 1000);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);

  const votes: WeightedVote[] = valid.map(r => {
    const healthScore = r._healthScore || 0.5;
    const confidence = extractConfidence(r);
    const latencyInv = computeLatencyInverse(r._latency || 1000, minLatency, maxLatency);
    const weight = healthScore * confidence * latencyInv;
    return {
      action: r,
      providerName: r._model,
      healthScore,
      confidence,
      latencyMs: r._latency || 0,
      weight,
    };
  });

  // --- Run weighted consensus ---
  const consensus = findWeightedConsensus(votes);
  if (!consensus) {
    // Should never happen since we checked valid.length > 0
    const { _model, ...action } = valid[0];
    return { ...action, reasoning: `Tribunal (fallback): ${action.reasoning}` };
  }

  const rep = consensus.winningAction;

  // --- Log consensus details (P20) ---
  if (valid.length === 1) {
    log(`Tribunal (1 provider - ${valid[0]._model}, weight=${consensus.winnerWeight.toFixed(3)}): ${rep.currentState} / ${rep.actionType}`, 'INFO', 'tribunal');
  } else {
    // Log the weight distribution for transparency
    const weightLog = consensus.details
      .sort((a, b) => b.weight - a.weight)
      .map(d => `${d.providerName}:${d.weight.toFixed(3)}(${d.actionType})`)
      .join(', ');
    const pctDisplay = Math.round(consensus.agreementPct * 100);
    log(`Tribunal consensus (${consensus.clusterSize}/${consensus.totalVoters} providers, ${pctDisplay}% weight agreement): ${rep.currentState} / ${rep.actionType} | weights: [${weightLog}]`, 'INFO', 'tribunal');

    // Warn on low agreement (threshold: <40% of weight on the winning action)
    if (consensus.agreementPct < 0.4 && consensus.totalVoters >= 3) {
      log(`Low tribunal agreement (${pctDisplay}%) -- providers disagree on action`, 'WARN', 'tribunal');
    }
  }

  // --- Build and return the winning action ---
  // FIX: Strip internal tracking metadata from the returned action
  const { _model, _healthScore, _latency, ...cleanRep } = rep as any;

  // Validate actionType — reject unrecognized actions to prevent
  // "Unknown action" warnings in the executor. Fall back to 'wait'.
  const VALID_ACTIONS = new Set([
    'click', 'input_email', 'input_password', 'keypad_input',
    'scroll_vertical', 'scroll_horizontal', 'wait',
    'flutter_swipe', 'flutter_tap',
  ]);
  const safeActionType = VALID_ACTIONS.has(cleanRep.actionType)
    ? cleanRep.actionType
    : 'wait';
  if (safeActionType !== cleanRep.actionType) {
    log(`Tribunal: unrecognized actionType "${cleanRep.actionType}" from ${valid[0]?._model || 'unknown'} — falling back to 'wait'`, 'WARN', 'tribunal');
  }

  const reasoningPrefix = valid.length === 1
    ? `Tribunal (1 model - ${valid[0]._model}, w=${consensus.winnerWeight.toFixed(2)})`
    : `Tribunal (${consensus.clusterSize}/${consensus.totalVoters} models, ${Math.round(consensus.agreementPct * 100)}% agreement)`;

  return {
    currentState: cleanRep.currentState,
    reasoning: `${reasoningPrefix}: ${cleanRep.reasoning}`,
    actionType: safeActionType,
    targetX: cleanRep.targetX ?? 0,
    targetY: cleanRep.targetY ?? 0,
    value: cleanRep.value ?? '',
    keypadSequence: cleanRep.keypadSequence,
    submitX: cleanRep.submitX ?? 0,
    submitY: cleanRep.submitY ?? 0,
    // TASK 74 (2026-09-23): Pass through AI-decided flags.
    // repeatable: AI says this action is always the same (e.g., clicking "Next")
    //   → allows caching even on banned states.
    // skipExactMatch: AI says this action should NOT be reused for exact matching
    //   (e.g., clicking a popup button on a login page) → prevents the cache
    //   from returning this action when the bot later sees a different page
    //   with the same state label.
    repeatable: cleanRep.repeatable === true,
    skipExactMatch: cleanRep.skipExactMatch === true,
  };
}

module.exports = { runTribunal, triggerSequentialMode };
