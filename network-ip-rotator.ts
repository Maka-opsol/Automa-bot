// Resilience R15: IP Rotation Awareness — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// network-ip-rotator.ts — P3 IP Rotation Awareness
// ═══════════════════════════════════════════════════════════════
// On Render free plan, the server IP is fixed but may be blocked
// by provider APIs. This module checks the current IP on startup,
// tracks changes across restarts, and supports proxy rotation
// when available.
//
// Features:
//   1. Check current IP on startup via ipify.org
//   2. Store IP in DB for comparison across restarts
//   3. If 403 from 3+ providers simultaneously → assume IP blocked
//   4. Configurable proxy list (PROXY_URLS env var)
//   5. Rotate to next proxy on IP block detection
//
// Integration:
//   - container-subsystem-runner.ts calls checkIp() at startup
//   - providers-base.ts reports 403s for IP block detection
//   - providers-base.ts uses getCurrentProxy() for fetch wrapper
//
// Config:
//   PROXY_URLS — comma-separated list of proxy URLs (optional)
//   IP_CHECK_URL — IP check endpoint (default https://api.ipify.org)
//   IP_BLOCK_THRESHOLD — 403s before IP block declared (default 3)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'ip-rotator') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Constants ───
const DEFAULT_IP_CHECK_URL = 'https://api.ipify.org?format=json';
const DEFAULT_IP_BLOCK_THRESHOLD = 3;

// ─── State ───
let _currentIp: string | null = null;
let _previousIp: string | null = null;
let _proxyUrls: string[] = [];
let _currentProxyIndex = -1;  // -1 = no proxy (direct)
let _consecutive403s = 0;
let _isIpBlocked = false;
let _ipChecked = false;
let _started = false;

// ─── Helpers ───

function _getIpCheckUrl(): string {
  const CONFIG = getCONFIG();
  return String(CONFIG.IP_CHECK_URL || DEFAULT_IP_CHECK_URL);
}

function _getIpBlockThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.IP_BLOCK_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_IP_BLOCK_THRESHOLD;
}

function _loadProxyUrls(): void {
  const CONFIG = getCONFIG();
  const proxyEnv = String(CONFIG.PROXY_URLS || process.env.PROXY_URLS || '');
  if (proxyEnv.trim()) {
    _proxyUrls = proxyEnv.split(',').map(u => u.trim()).filter(u => u.length > 0);
    log(`[IP] Loaded ${_proxyUrls.length} proxy URLs`, 'INFO');
  }
}

// ─── Core API ───

/**
 * Check the current server IP and compare with previous.
 * Call at startup.
 */
async function checkIp(): Promise<string | null> {
  try {
    const response = await fetch(_getIpCheckUrl(), {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log(`[IP] IP check failed: HTTP ${response.status}`, 'WARN');
      return _currentIp;
    }

    const data = await response.json();
    const ip = data.ip || String(data);

    _previousIp = _currentIp;
    _currentIp = ip;
    _ipChecked = true;

    // Store in DB
    try {
      const db = (_deps as any).database;
      if (db?.upsertCalibration) {
        db.upsertCalibration('server_ip', ip);
        db.upsertCalibration('server_ip_checked_at', String(Date.now()));
      }
    } catch { /* non-critical */ }

    // Check for IP change
    if (_previousIp && _previousIp !== ip) {
      log(
        `[IP] IP changed: ${_previousIp} → ${ip}. Verifying provider API keys...`,
        'WARN'
      );
      // IP change doesn't require action on Render (fixed IP),
      // but log it for debugging
    } else {
      log(`[IP] Current IP: ${ip}`, 'INFO');
    }

    // Load previous IP from DB for comparison
    if (!_previousIp) {
      try {
        const db = (_deps as any).database;
        if (db?.selectCalibration) {
          const savedIp = db.selectCalibration('server_ip');
          if (savedIp && savedIp !== ip) {
            _previousIp = savedIp;
            log(`[IP] Previous IP from DB: ${savedIp}`, 'INFO');
          }
        }
      } catch { /* non-critical */ }
    }

    return ip;
  } catch (err) {
    log(`[IP] IP check failed: ${(err as Error).message}`, 'WARN');
    return _currentIp;
  }
}

/**
 * Report a 403 error from a provider (for IP block detection).
 */
function report403(providerName: string): void {
  _consecutive403s++;

  log(
    `[IP] 403 from "${providerName}" (consecutive: ${_consecutive403s}/${_getIpBlockThreshold()})`,
    _consecutive403s >= _getIpBlockThreshold() ? 'ERROR' : 'WARN'
  );

  if (_consecutive403s >= _getIpBlockThreshold() && !_isIpBlocked) {
    _declareIpBlocked();
  }
}

/**
 * Reset 403 counter (called on any successful provider call).
 */
function reset403Count(): void {
  _consecutive403s = 0;
}

/**
 * Declare IP blocked and attempt proxy rotation.
 */
function _declareIpBlocked(): void {
  _isIpBlocked = true;

  log(
    `[IP] IP BLOCKED: ${_consecutive403s} providers returned 403. Current IP: ${_currentIp || 'unknown'}`,
    'ERROR'
  );

  // Try proxy rotation
  if (_proxyUrls.length > 0) {
    const nextProxy = _rotateProxy();
    if (nextProxy) {
      log(`[IP] Rotating to proxy: ${nextProxy}`, 'INFO');
      process.env.HTTP_PROXY = nextProxy;
      process.env.HTTPS_PROXY = nextProxy;
      return;
    }
  }

  // No proxy available — alert
  try {
    const alerting = (_deps as any).alerting;
    if (alerting?.sendAlert) {
      alerting.sendAlert(
        'IP Blocked',
        `Server IP ${_currentIp || 'unknown'} has been blocked by ${_consecutive403s} providers. ` +
        `No proxy URLs available. Consider: ` +
        `1. Adding PROXY_URLS env var ` +
        `2. Waiting for IP block to expire ` +
        `3. Restarting service`
      );
    }
  } catch { /* non-critical */ }
}

/**
 * Rotate to the next proxy in the list.
 */
function _rotateProxy(): string | null {
  if (_proxyUrls.length === 0) return null;

  _currentProxyIndex = (_currentProxyIndex + 1) % _proxyUrls.length;
  return _proxyUrls[_currentProxyIndex];
}

/**
 * Get the current proxy URL (or null if using direct connection).
 */
function getCurrentProxy(): string | null {
  return _currentProxyIndex >= 0 ? _proxyUrls[_currentProxyIndex] : null;
}

/**
 * Check if IP is currently blocked.
 */
function isIpBlocked(): boolean {
  return _isIpBlocked;
}

/**
 * Manually unblock IP (e.g., after adding new proxy).
 */
function unblockIp(): void {
  _isIpBlocked = false;
  _consecutive403s = 0;
  log('[IP] IP block manually cleared.', 'INFO');
}

/**
 * Get diagnostic status.
 */
function getStatus(): {
  currentIp: string | null;
  previousIp: string | null;
  ipChanged: boolean;
  proxyCount: number;
  currentProxyIndex: number;
  currentProxy: string | null;
  consecutive403s: number;
  ipBlockThreshold: number;
  isIpBlocked: boolean;
  ipChecked: boolean;
} {
  return {
    currentIp: _currentIp,
    previousIp: _previousIp,
    ipChanged: _previousIp !== null && _previousIp !== _currentIp,
    proxyCount: _proxyUrls.length,
    currentProxyIndex: _currentProxyIndex,
    currentProxy: getCurrentProxy(),
    consecutive403s: _consecutive403s,
    ipBlockThreshold: _getIpBlockThreshold(),
    isIpBlocked: _isIpBlocked,
    ipChecked: _ipChecked,
  };
}

/**
 * Start the IP rotator.
 */
async function start(): Promise<void> {
  if (_started) return;
  _started = true;

  _loadProxyUrls();
  log('[IP] IP rotator started', 'INFO');

  // Check IP on startup
  await checkIp();
}

module.exports = {
  _injectDependencies,
  checkIp,
  report403,
  reset403Count,
  getCurrentProxy,
  isIpBlocked,
  unblockIp,
  getStatus,
  start,
};
