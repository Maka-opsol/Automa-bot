'use strict';

// Lazy requires to avoid top-level circular dependency chain
const { getAvailableProviders, addProviderFailure, recordProviderResult } = require('./providers-registry');

// Lazy logger - loaded on first use
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

// Lazy providers-base - loaded on first use
let _providersBase: any = null;
function _getProvidersBase() { if (!_providersBase) _providersBase = require('./providers-base'); return _providersBase; }

// Lazy providers-prompts - loaded on first use
let _prompts: any = null;
function _getPrompts() { if (!_prompts) _prompts = require('./providers-prompts'); return _prompts; }

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

  // Group votes by action key (currentState::actionType)
  const clusters = new Map<string, WeightedVote[]>();
  for (const vote of votes) {
    const key = `${vote.action.currentState || 'unknown'}::${vote.action.actionType}`;
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
  // without calling any providers. This saves ~45s and API quota.
  if (base64Image && typeof base64Image === 'string' && isBlankImage(base64Image)) {
    log('Tribunal: screenshot is blank/white — skipping all providers, returning wait', 'WARN', 'tribunal');
    return { actionType: 'wait', currentState: 'blank_page', reasoning: 'Screenshot is blank/white — page not rendered yet', targetX: 0, targetY: 0 };
  }

  const { safeCall } = _getProvidersBase();
  const { getSystemPrompt, getUserInstruction } = _getPrompts();

  // --- Get health-weighted providers from registry ---
  const providers = await getAvailableProviders();
  if (providers.length === 0) {
    log('No providers available after health filtering.', 'ERROR', 'tribunal');
    return { actionType: 'wait', currentState: 'error', reasoning: 'No providers', targetX: 0, targetY: 0 };
  }

  // --- Build prompt ---
  let mapHint = '';
  if (uiMap) { mapHint = `\nUI MAP (from exploration): ${JSON.stringify(uiMap).substring(0, 500)}\nUse this map to guide actions.\n`; }
  const urlHint = pageUrl ? `\nCURRENT PAGE URL: ${pageUrl}\nUse this URL as an additional hint for state detection.\n` : '';
  const fullPrompt = `${getSystemPrompt()}${urlHint}${mapHint}\n${getUserInstruction()}`;

  const providerNames = providers.map((p: any) => `${p.name}(${(p.healthScore || 0).toFixed(2)})`).join(', ');
  log(`Tribunal: consulting ${providers.length} provider(s) [${providerNames}]`, 'INFO', 'tribunal');

  // --- Consult all providers in parallel ---
  // FIX: Add overall timeout so slow providers don't block the tribunal forever.
  const TRIBUNAL_TIMEOUT_MS = 45000; // 45s total (3 providers × 15s max each)
  const tribunalController = new AbortController();
  const tribunalTimeout = setTimeout(() => tribunalController.abort(), TRIBUNAL_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) { tribunalController.abort(); }
    else { signal.addEventListener('abort', () => tribunalController.abort(), { once: true }); }
  }

  const results: PromiseSettledResult<any>[] = await Promise.allSettled(
    providers.map(async (provider: any) => {
      const start = Date.now();
      try {
        const res = await safeCall(
          (sig: any) => provider.fn(base64Image, fullPrompt, sig || signal, { validate: true }),
          `Tribunal ${provider.name}`,
          { url: provider.name, maxRetries: 2, baseDelay: 1000, signal: tribunalController.signal }
        );
        const latency = Date.now() - start;
        // Note: safeCall already records to providers-health via recordCallResult internally.
        // We also record to the registry for DB persistence.
        recordProviderResult(provider.name, true, latency);
        return { ...res, _model: provider.name, _healthScore: provider.healthScore || 0.5, _latency: latency };
      } catch (err: any) {
        const latency = Date.now() - start;
        recordProviderResult(provider.name, false, latency);
        addProviderFailure(provider.name);
        const errMsg = err && err.message ? String(err.message) : String(err);
        log(`Tribunal: ${provider.name} failed: ${errMsg}`, 'WARN', 'tribunal');
        return null;
      }
    })
  );
  clearTimeout(tribunalTimeout);

  // --- Filter valid results ---
  const fulfilled = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

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
    log(`Tribunal consensus (${consensus.clusterSize}/${consensus.totalVoters} providers, ${consensus.agreementPct}% weight agreement): ${rep.currentState} / ${rep.actionType} | weights: [${weightLog}]`, 'INFO', 'tribunal');

    // Warn on low agreement
    if (consensus.agreementPct < 0.4 && consensus.totalVoters >= 3) {
      log(`Low tribunal agreement (${consensus.agreementPct}%) -- providers disagree on action`, 'WARN', 'tribunal');
    }
  }

  // --- Build and return the winning action ---
  // FIX: Strip internal tracking metadata from the returned action
  const { _model, _healthScore, _latency, ...cleanRep } = rep as any;
  const reasoningPrefix = valid.length === 1
    ? `Tribunal (1 model - ${valid[0]._model}, w=${consensus.winnerWeight.toFixed(2)})`
    : `Tribunal (${consensus.clusterSize}/${consensus.totalVoters} models, ${consensus.agreementPct}% agreement)`;

  return {
    currentState: cleanRep.currentState,
    reasoning: `${reasoningPrefix}: ${cleanRep.reasoning}`,
    actionType: cleanRep.actionType,
    targetX: cleanRep.targetX ?? 0,
    targetY: cleanRep.targetY ?? 0,
    value: cleanRep.value ?? '',
    keypadSequence: cleanRep.keypadSequence,
    submitX: cleanRep.submitX ?? 0,
    submitY: cleanRep.submitY ?? 0,
  };
}

module.exports = { runTribunal };
