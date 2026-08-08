// Resilience R10b: Circular Path Detection — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// progress-circular-path-detector.ts — P1 Navigation Loop Detection
// ═══════════════════════════════════════════════════════════════
// The bot can get stuck in a navigation loop, visiting the same
// page repeatedly without making progress.
//
// Features:
//   1. Ring buffer of last 50 URLs visited (non-SPA fallback)
//   2. State+hash ring buffer for SPA detection (visual loop)
//   3. If same URL+params appears 3+ times → navigation loop (non-SPA)
//   4. If same (state+hash) appears 5+ times → visual loop (SPA)
//   5. Break loop suggestion: navigate to assignments page
//   6. Loop cooldown: after detecting a loop, wait before checking again
//   7. Full URL normalization (strip query params that change like timestamps)
//   8. Persists loop count to DB for cross-restart tracking
//
// SPA Enhancement (v6):
//   MathU is a Flutter Web SPA — the URL never changes between pages.
//   Traditional URL-based loop detection would false-positive immediately.
//   Instead, we track (tribunalState + screenshotHash) pairs. If the bot
//   sees the exact same visual state 5+ times in a row, it's stuck.
//
// Integration:
//   - cycle-cycle-manager.ts calls checkUrlLoop() / checkStateLoop() after each cycle
//   - cycle-cycle-manager.ts acts on isLooping by navigating away
//
// Config:
//   CIRCULAR_PATH_DETECTION_WINDOW — ring buffer size (default 50)
//   CIRCULAR_PATH_LOOP_THRESHOLD — visits before declaring loop (default 3)
//   CIRCULAR_PATH_COOLDOWN_MS — cooldown after loop detection (default 30000)
//   CIRCULAR_PATH_SPA_THRESHOLD — state+hash visits before declaring SPA loop (default 5)
//   MATHU_SPA_DOMAINS — comma-separated SPA domains (default: app.mathu.co.za,mathu.co.za)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'circular-path') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface LoopDetectionResult {
  isLooping: boolean;
  loopCount: number;
  loopUrl: string | null;
  suggestion: string | null;
}

// ─── Constants ───
const DEFAULT_WINDOW = 50;
const DEFAULT_LOOP_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30000;
const DEFAULT_SPA_THRESHOLD = 5;

// ─── State (URL-based) ───
let _urlRingBuffer: string[] = [];
let _urlTimestamps: number[] = [];
let _loopDetectedAt: number | null = null;
let _totalLoopsDetected = 0;
let _totalUrlsTracked = 0;
let _lastLoopUrl: string | null = null;
let _started = false;

// ─── State (SPA state+hash based) ───
let _stateHashRingBuffer: string[] = [];    // "state|hash" composite keys
let _stateHashTimestamps: number[] = [];
let _spaLoopDetectedAt: number | null = null;
let _totalSpaLoopsDetected = 0;

// ─── Helpers ───

function _getWindow(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CIRCULAR_PATH_DETECTION_WINDOW);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_WINDOW;
}

function _getLoopThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CIRCULAR_PATH_LOOP_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_LOOP_THRESHOLD;
}

function _getCooldownMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CIRCULAR_PATH_COOLDOWN_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_COOLDOWN_MS;
}

function _getSpaThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CIRCULAR_PATH_SPA_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_SPA_THRESHOLD;
}

/**
 * Check whether the current URL belongs to a known SPA domain.
 */
function _isSpaDomain(url: string): boolean {
  const CONFIG = getCONFIG();
  const raw = (CONFIG.MATHU_SPA_DOMAINS || 'app.mathu.co.za,mathu.co.za') as string;
  const domains = raw.split(',').map((d: string) => d.trim()).filter(Boolean);
  try {
    const origin = new URL(url).origin;
    const hostname = new URL(url).hostname;
    return domains.some(d => origin.includes(d) || hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

/**
 * Normalize a URL for loop detection.
 * Strips volatile query params (timestamps, tokens, nonces)
 * and fragments to catch "same page" visits with different params.
 */
function _normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Remove volatile query params
    const volatileParams = new Set([
      't', 'ts', 'timestamp', '_t', '_ts',
      'token', 'csrf', 'nonce', '_nonce',
      'session', 'session_id', 'sid',
      'cachebuster', '_', 'utm_source', 'utm_medium', 'utm_campaign',
    ]);

    const filteredParams: string[] = [];
    for (const [key, value] of parsed.searchParams) {
      if (!volatileParams.has(key.toLowerCase())) {
        filteredParams.push(`${key}=${value}`);
      }
    }

    // Sort remaining params for consistent comparison
    filteredParams.sort();

    let normalized = `${parsed.origin}${parsed.pathname}`;
    if (filteredParams.length > 0) {
      normalized += '?' + filteredParams.join('&');
    }
    // Intentionally exclude hash fragment (can change without page change)

    return normalized;
  } catch {
    // URL parsing failed — return as-is
    return url.split('#')[0].split('?')[0]; // rough normalization
  }
}

/**
 * Count how many times a normalized URL appears in the ring buffer.
 */
function _countUrlOccurrences(normalizedUrl: string): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  for (let i = 0; i < _urlRingBuffer.length; i++) {
    if (_urlRingBuffer[i] === normalizedUrl) {
      count++;
      if (firstIndex === -1) firstIndex = i;
    }
  }
  return { count, firstIndex };
}

/**
 * Build a composite key from tribunal-reported state and screenshot hash.
 * This is the SPA-aware loop detection signal.
 */
function _buildStateHashKey(tribunalState: string, screenshotHash: string): string {
  return `${(tribunalState || 'unknown').toLowerCase()}|${(screenshotHash || '')}`;
}

/**
 * Count consecutive occurrences of a state+hash key at the TAIL of the buffer.
 * We look at the tail because SPA loops are about getting stuck repeatedly,
 * not about visiting the same screen occasionally over a long session.
 */
function _countConsecutiveStateHash(key: string): number {
  let count = 0;
  // Walk backwards from the end
  for (let i = _stateHashRingBuffer.length - 1; i >= 0; i--) {
    if (_stateHashRingBuffer[i] === key) {
      count++;
    } else {
      break; // Stop at first different entry
    }
  }
  return count;
}

// ─── Core API ───

/**
 * Check if the current URL indicates a navigation loop (non-SPA).
 * Call this after each navigation/page load in the cycle manager.
 *
 * @param currentUrl — The current page URL
 * @returns LoopDetectionResult with isLooping, count, URL, and suggestion
 */
function checkUrlLoop(currentUrl: string): LoopDetectionResult {
  if (!currentUrl || typeof currentUrl !== 'string') {
    return { isLooping: false, loopCount: 0, loopUrl: null, suggestion: null };
  }

  // On SPA domains, URL-based detection is unreliable — skip it.
  // The cycle manager should call checkStateLoop() instead.
  if (_isSpaDomain(currentUrl)) {
    return { isLooping: false, loopCount: 0, loopUrl: null, suggestion: null };
  }

  const normalized = _normalizeUrl(currentUrl);
  const window = _getWindow();
  const threshold = _getLoopThreshold();
  const cooldownMs = _getCooldownMs();

  // Check cooldown
  if (_loopDetectedAt && (Date.now() - _loopDetectedAt) < cooldownMs) {
    // Still in cooldown — add URL to buffer but don't check for loops
    _urlRingBuffer.push(normalized);
    _urlTimestamps.push(Date.now());
    while (_urlRingBuffer.length > window) {
      _urlRingBuffer.shift();
      _urlTimestamps.shift();
    }
    _totalUrlsTracked++;
    return { isLooping: false, loopCount: 0, loopUrl: null, suggestion: null };
  }

  // Add to ring buffer
  _urlRingBuffer.push(normalized);
  _urlTimestamps.push(Date.now());
  _totalUrlsTracked++;

  // Trim ring buffer
  while (_urlRingBuffer.length > window) {
    _urlRingBuffer.shift();
    _urlTimestamps.shift();
  }

  // Count occurrences
  const { count, firstIndex } = _countUrlOccurrences(normalized);

  if (count >= threshold) {
    _loopDetectedAt = Date.now();
    _totalLoopsDetected++;
    _lastLoopUrl = currentUrl;

    log(
      `[LOOP] Navigation loop detected: "${currentUrl}" visited ${count} times in last ${_urlRingBuffer.length} navigations`,
      'WARN'
    );

    // Persist to DB
    try {
      const db = (_deps as any).database;
      if (db?.upsertCalibration) {
        db.upsertCalibration('loop_total_detected', String(_totalLoopsDetected));
        db.upsertCalibration('loop_last_url', currentUrl.substring(0, 200));
        db.upsertCalibration('loop_last_detected', String(Date.now()));
      }
    } catch { /* non-critical */ }

    return {
      isLooping: true,
      loopCount: count,
      loopUrl: currentUrl,
      suggestion: 'Navigate to assignments page to break the loop',
    };
  }

  // Reset loop detection time if we're below threshold
  if (count < threshold - 1) {
    _loopDetectedAt = null;
  }

  return { isLooping: false, loopCount: count, loopUrl: null, suggestion: null };
}

/**
 * Check if the bot is visually stuck on an SPA by tracking
 * (tribunalState + screenshotHash) pairs.
 *
 * Unlike URL-based detection, this works on SPAs where the URL
 * never changes. It detects when the bot sees the exact same
 * visual state repeatedly — meaning it's not making progress.
 *
 * @param tribunalState — The state reported by the AI vision tribunal (e.g. 'question', 'assignments_page')
 * @param screenshotHash — MD5 hash of the current page screenshot
 * @returns LoopDetectionResult with isLooping and suggestion
 */
function checkStateLoop(tribunalState: string, screenshotHash: string): LoopDetectionResult {
  if (!tribunalState || !screenshotHash) {
    return { isLooping: false, loopCount: 0, loopUrl: null, suggestion: null };
  }

  const window = _getWindow();
  const threshold = _getSpaThreshold();
  const cooldownMs = _getCooldownMs();

  const key = _buildStateHashKey(tribunalState, screenshotHash);

  // Check SPA loop cooldown
  if (_spaLoopDetectedAt && (Date.now() - _spaLoopDetectedAt) < cooldownMs) {
    // Still in cooldown — add to buffer but don't check
    _stateHashRingBuffer.push(key);
    _stateHashTimestamps.push(Date.now());
    while (_stateHashRingBuffer.length > window) {
      _stateHashRingBuffer.shift();
      _stateHashTimestamps.shift();
    }
    return { isLooping: false, loopCount: 0, loopUrl: null, suggestion: null };
  }

  // Add to ring buffer
  _stateHashRingBuffer.push(key);
  _stateHashTimestamps.push(Date.now());

  // Trim ring buffer
  while (_stateHashRingBuffer.length > window) {
    _stateHashRingBuffer.shift();
    _stateHashTimestamps.shift();
  }

  // Count consecutive occurrences (tail-based for SPA loop detection)
  const consecutiveCount = _countConsecutiveStateHash(key);

  // Also count total occurrences in buffer for diagnostics
  let totalCount = 0;
  for (let i = 0; i < _stateHashRingBuffer.length; i++) {
    if (_stateHashRingBuffer[i] === key) totalCount++;
  }

  if (consecutiveCount >= threshold) {
    _spaLoopDetectedAt = Date.now();
    _totalSpaLoopsDetected++;

    log(
      `[SPA LOOP] Visual loop detected: state="${tribunalState}" hash="${screenshotHash.substring(0, 8)}..." repeated ${consecutiveCount} consecutive times (total ${totalCount} in buffer)`,
      'WARN'
    );

    // Persist to DB
    try {
      const db = (_deps as any).database;
      if (db?.upsertCalibration) {
        db.upsertCalibration('spa_loop_total_detected', String(_totalSpaLoopsDetected));
        db.upsertCalibration('spa_loop_last_state', tribunalState);
        db.upsertCalibration('spa_loop_last_hash', screenshotHash.substring(0, 16));
        db.upsertCalibration('spa_loop_last_detected', String(Date.now()));
      }
    } catch { /* non-critical */ }

    return {
      isLooping: true,
      loopCount: consecutiveCount,
      loopUrl: `spa:${tribunalState}:${screenshotHash.substring(0, 8)}`,
      suggestion: 'Bot is visually stuck on same state. Try scrolling, clicking a different element, or navigating to assignments page.',
    };
  }

  // Reset cooldown if below threshold
  if (consecutiveCount < threshold - 1) {
    _spaLoopDetectedAt = null;
  }

  return {
    isLooping: false,
    loopCount: consecutiveCount,
    loopUrl: null,
    suggestion: null,
  };
}

/**
 * Get the URL visit frequency map for diagnostics.
 */
function getUrlFrequency(): { url: string; count: number; lastSeen: number }[] {
  const freq: Record<string, { count: number; lastSeen: number }> = {};
  for (let i = 0; i < _urlRingBuffer.length; i++) {
    const url = _urlRingBuffer[i];
    if (!freq[url]) {
      freq[url] = { count: 0, lastSeen: _urlTimestamps[i] };
    }
    freq[url].count++;
    freq[url].lastSeen = Math.max(freq[url].lastSeen, _urlTimestamps[i]);
  }

  return Object.entries(freq)
    .map(([url, data]) => ({ url, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10); // Top 10 most visited
}

/**
 * Get the state+hash frequency map for SPA diagnostics.
 */
function getStateHashFrequency(): { key: string; state: string; count: number; consecutive: number }[] {
  const freq: Record<string, { count: number; lastSeen: number }> = {};
  for (let i = 0; i < _stateHashRingBuffer.length; i++) {
    const k = _stateHashRingBuffer[i];
    if (!freq[k]) {
      freq[k] = { count: 0, lastSeen: _stateHashTimestamps[i] };
    }
    freq[k].count++;
  }

  return Object.entries(freq)
    .map(([key, data]) => ({
      key,
      state: key.split('|')[0],
      count: data.count,
      consecutive: _countConsecutiveStateHash(key),
    }))
    .sort((a, b) => b.consecutive - a.consecutive)
    .slice(0, 10);
}

/**
 * Reset tracking (call at cycle start).
 */
function reset(): void {
  _urlRingBuffer = [];
  _urlTimestamps = [];
  _loopDetectedAt = null;
  _stateHashRingBuffer = [];
  _stateHashTimestamps = [];
  _spaLoopDetectedAt = null;
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  bufferSize: number;
  urlsInBuffer: number;
  loopThreshold: number;
  totalLoopsDetected: number;
  totalUrlsTracked: number;
  lastLoopUrl: string | null;
  lastLoopTime: number | null;
  isInCooldown: boolean;
  cooldownRemainingMs: number;
  topUrls: { url: string; count: number }[];
  // SPA-specific fields
  spaThreshold: number;
  totalSpaLoopsDetected: number;
  stateHashInBuffer: number;
  lastSpaLoopTime: number | null;
  isInSpaCooldown: boolean;
  spaCooldownRemainingMs: number;
  topStateHashes: { state: string; count: number; consecutive: number }[];
} {
  const cooldownMs = _getCooldownMs();
  let cooldownRemainingMs = 0;
  let isInCooldown = false;
  if (_loopDetectedAt) {
    const elapsed = Date.now() - _loopDetectedAt;
    if (elapsed < cooldownMs) {
      isInCooldown = true;
      cooldownRemainingMs = cooldownMs - elapsed;
    }
  }

  let spaCooldownRemainingMs = 0;
  let isInSpaCooldown = false;
  if (_spaLoopDetectedAt) {
    const elapsed = Date.now() - _spaLoopDetectedAt;
    if (elapsed < cooldownMs) {
      isInSpaCooldown = true;
      spaCooldownRemainingMs = cooldownMs - elapsed;
    }
  }

  const topUrls = getUrlFrequency().map(({ url, count }) => ({ url, count }));
  const topStateHashes = getStateHashFrequency().map(({ state, count, consecutive }) => ({ state, count, consecutive }));

  return {
    bufferSize: _getWindow(),
    urlsInBuffer: _urlRingBuffer.length,
    loopThreshold: _getLoopThreshold(),
    totalLoopsDetected: _totalLoopsDetected,
    totalUrlsTracked: _totalUrlsTracked,
    lastLoopUrl: _lastLoopUrl,
    lastLoopTime: _loopDetectedAt,
    isInCooldown,
    cooldownRemainingMs,
    topUrls,
    // SPA-specific
    spaThreshold: _getSpaThreshold(),
    totalSpaLoopsDetected: _totalSpaLoopsDetected,
    stateHashInBuffer: _stateHashRingBuffer.length,
    lastSpaLoopTime: _spaLoopDetectedAt,
    isInSpaCooldown,
    spaCooldownRemainingMs,
    topStateHashes,
  };
}

/**
 * Start the circular path detector.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log(
    `[LOOP] Circular path detector started (window=${_getWindow()}, threshold=${_getLoopThreshold()}, cooldown=${_getCooldownMs() / 1000}s, spaThreshold=${_getSpaThreshold()})`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  checkUrlLoop,
  checkStateLoop,
  getUrlFrequency,
  getStateHashFrequency,
  reset,
  getStatus,
  start,
};
