// Resilience R15: IP Rotation Awareness — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// network-ip-rotator.ts — ProxyScrape Integration + IP Rotation
// ═══════════════════════════════════════════════════════════════
// Fetches South African proxies from ProxyScrape API on startup,
// rotates through them when the current IP is blocked or when
// manual rotation is requested.
//
// ProxyScrape API:
//   https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies
//   &proxy_format=protocolipport&format=json&protocol=http,socks4,socks5&country=za
//
// Integration:
//   - container-subsystem-runner.ts calls checkIp() at startup
//   - providers-base.ts reports 403s for IP block detection
//   - browser.ts uses getCurrentProxy() for Chrome --proxy-server flag
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
const PROXYSCRAPE_API_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json&protocol=http%2Csocks4%2Csocks5&country=za';
const PROXY_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // refresh proxy list every 10 min

// ─── State ───
let _currentIp: string | null = null;
let _previousIp: string | null = null;
let _proxyUrls: string[] = [];
let _currentProxyIndex = -1;  // -1 = no proxy (direct)
let _consecutive403s = 0;
let _isIpBlocked = false;
let _ipChecked = false;
let _started = false;
let _proxyRefreshTimer: ReturnType<typeof setInterval> | null = null;

// ─── Proxy outcome / network error tracking (for dashboard) ───
// These are surfaced to the dashboard via `__setLatestProxyOutcome` and
// `__setLatestNetworkError` globals (set by render-free-plan.ts).
interface ProxyOutcome {
  timestamp: number;
  action: 'validated' | 'rotated' | 'bypassed' | 'failed' | 'disabled';
  proxy?: string | null;
  reason?: string;
  testUrl?: string;
  latencyMs?: number;
}

interface NetworkErrorRecord {
  timestamp: number;
  errorType: string;        // e.g. 'ERR_CONNECTION_CLOSED', 'NAV_TIMEOUT'
  url?: string;
  proxy?: string | null;
  message: string;
  cycleCount?: number;
}

let _latestProxyOutcome: ProxyOutcome | null = null;
let _latestNetworkError: NetworkErrorRecord | null = null;
let _networkErrorHistory: NetworkErrorRecord[] = [];   // bounded ring buffer
const MAX_NETWORK_ERROR_HISTORY = 20;

function _recordProxyOutcome(outcome: ProxyOutcome): void {
  _latestProxyOutcome = outcome;
  try {
    const setter = (globalThis as any).__setLatestProxyOutcome;
    if (typeof setter === 'function') setter(outcome);
  } catch { /* dashboard not loaded yet */ }
}

function _recordNetworkError(rec: NetworkErrorRecord): void {
  _latestNetworkError = rec;
  _networkErrorHistory.push(rec);
  if (_networkErrorHistory.length > MAX_NETWORK_ERROR_HISTORY) {
    _networkErrorHistory.shift();
  }
  try {
    const setter = (globalThis as any).__setLatestNetworkError;
    if (typeof setter === 'function') setter(rec);
  } catch { /* dashboard not loaded yet */ }
}

function getLatestProxyOutcome(): ProxyOutcome | null {
  return _latestProxyOutcome;
}

function getLatestNetworkError(): NetworkErrorRecord | null {
  return _latestNetworkError;
}

function getNetworkErrorHistory(): NetworkErrorRecord[] {
  return _networkErrorHistory.slice();
}

// ─── ProxyScrape Integration ───

/**
 * Fetch South African proxies from ProxyScrape API.
 * Returns an array of proxy URLs like ["socks4://105.214.0.91:5678", "http://102.68.98.94:3128"].
 */
async function _fetchProxyScrapeProxies(): Promise<string[]> {
  try {
    log('[IP] Fetching ZA proxies from ProxyScrape API...', 'INFO');
    const response = await fetch(PROXYSCRAPE_API_URL, {
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      log(`[IP] ProxyScrape API returned HTTP ${response.status}`, 'WARN');
      return [];
    }

    const data = await response.json();
    if (!data?.proxies || !Array.isArray(data.proxies)) {
      log('[IP] ProxyScrape API returned no proxies array', 'WARN');
      return [];
    }

    // Extract alive proxies with their city for sorting
    const aliveProxies: Array<{ url: string; city: string }> = [];
    for (const p of data.proxies) {
      if (p.alive && p.proxy) {
        const city = (p.ip_data?.city || '').toLowerCase();
        aliveProxies.push({ url: p.proxy, city });
      }
    }

    // Sort: Johannesburg first, then other Gauteng cities, then everything else
    const gautengCities = ['johannesburg', 'pretoria', 'centurion', 'midrand', 'sandton', 'randburg', 'roodepoort', 'germiston', 'kempton park', 'boksburg', 'springs', 'benoni', 'brakpan', 'vanderbijlpark', 'vereeniging', 'krugersdorp', 'soweto'];
    aliveProxies.sort((a, b) => {
      const aJoburg = a.city === 'johannesburg';
      const bJoburg = b.city === 'johannesburg';
      if (aJoburg && !bJoburg) return -1;
      if (!aJoburg && bJoburg) return 1;
      const aGauteng = gautengCities.includes(a.city);
      const bGauteng = gautengCities.includes(b.city);
      if (aGauteng && !bGauteng) return -1;
      if (!aGauteng && bGauteng) return 1;
      return 0;
    });

    const proxies = aliveProxies.map(p => p.url);
    const joburgCount = aliveProxies.filter(p => p.city === 'johannesburg').length;
    const gautengCount = aliveProxies.filter(p => gautengCities.includes(p.city)).length;
    log(`[IP] ProxyScrape returned ${data.proxies.length} proxies, ${proxies.length} alive (${joburgCount} Johannesburg, ${gautengCount} Gauteng, ${proxies.length - gautengCount} other)`, 'INFO');
    return proxies;
  } catch (err) {
    log(`[IP] ProxyScrape API fetch failed: ${(err as Error).message}`, 'WARN');
    return [];
  }
}

/**
 * Load proxies from ProxyScrape API + PROXY_URLS env var.
 */
async function _loadProxyUrls(): Promise<void> {
  // First, check for manual PROXY_URLS env var (static list)
  const CONFIG = getCONFIG();
  const proxyEnv = String(CONFIG.PROXY_URLS || process.env.PROXY_URLS || '');
  if (proxyEnv.trim()) {
    _proxyUrls = proxyEnv.split(',').map(u => u.trim()).filter(u => u.length > 0);
    log(`[IP] Loaded ${_proxyUrls.length} proxy URLs from PROXY_URLS env var`, 'INFO');
    return;
  }

  // Otherwise, fetch from ProxyScrape API
  const scrapeProxies = await _fetchProxyScrapeProxies();
  if (scrapeProxies.length > 0) {
    _proxyUrls = scrapeProxies;
    log(`[IP] Loaded ${_proxyUrls.length} ZA proxies from ProxyScrape`, 'INFO');
  } else {
    _proxyUrls = [];
    log('[IP] No proxies available (ProxyScrape returned empty)', 'WARN');
  }
}

// ─── Core API ───

/**
 * Validate a proxy by attempting a TCP socket connection to the proxy's
 * host:port. This is the fastest and most reliable way to verify a proxy
 * is alive — it works for HTTP, SOCKS4, and SOCKS5 proxies alike, and
 * doesn't depend on undici or proxy-agent packages.
 *
 * We don't try to route an actual HTTP request through the proxy here
 * because:
 *   1. SOCKS proxies require the `socks-proxy-agent` package which may not
 *      be installed.
 *   2. The Playwright browser will do the actual routing test when it
 *      tries to navigate. If the proxy is alive (TCP connects) but can't
 *      route, the navigation retry logic in cycle-cycle-manager will
 *      rotate to a different proxy.
 *
 * So `validateProxy` is a fast pre-filter: "is this proxy's port open?"
 * The full routing validation happens during `page.goto`.
 */
async function validateProxy(
  proxyUrl: string,
  testUrl?: string,
  timeoutMs: number = 5000
): Promise<{ ok: boolean; latencyMs?: number; reason?: string; statusCode?: number }> {
  const start = Date.now();
  let host: string | null = null;
  let port: number | null = null;

  // Parse the proxy URL to extract host and port
  try {
    const parsed = new URL(proxyUrl);
    host = parsed.hostname;
    port = parseInt(parsed.port, 10);
    if (!host || !port || port <= 0 || port > 65535) {
      return { ok: false, latencyMs: 0, reason: `invalid host/port: ${host}:${port}` };
    }
  } catch (e: any) {
    return { ok: false, latencyMs: 0, reason: `URL parse failed: ${e.message}` };
  }

  // Use Node's built-in `net` module to open a TCP socket
  const net = require('net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* best effort */ }
    };
    const timer = setTimeout(() => {
      cleanup();
      const latencyMs = Date.now() - start;
      resolve({ ok: false, latencyMs, reason: `connect timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      cleanup();
      // Connection succeeded — proxy port is open and accepting connections.
      // We return ok=true with statusCode=0 (no HTTP status — we only verified
      // TCP connectivity). The caller treats this as "proxy is alive".
      resolve({ ok: true, latencyMs, statusCode: 0 });
    });

    socket.once('error', (err: any) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      cleanup();
      const code = err?.code || err?.errno || 'UNKNOWN';
      const msg = String(err?.message || err);
      // Common errors: ECONNREFUSED, ECONNRESET, ETIMEDOUT, EHOSTUNREACH, ENETUNREACH
      resolve({ ok: false, latencyMs, reason: `${code}: ${msg.substring(0, 100)}` });
    });

    try {
      socket.connect(port, host);
    } catch (e: any) {
      clearTimeout(timer);
      cleanup();
      const latencyMs = Date.now() - start;
      resolve({ ok: false, latencyMs, reason: `socket.connect failed: ${e.message}` });
    }
  });
}

/**
 * Rotate to the next validated proxy. Tries each proxy in the list with
 * `validateProxy` until one passes, then activates it. If all proxies fail
 * validation, returns null (caller should fall back to direct connection).
 *
 * `maxToTry` bounds the number of proxies we test (default: 5) so we don't
 * spend 30s+ testing a long proxy list.
 */
async function rotateToValidatedProxy(maxToTry: number = 5): Promise<string | null> {
  if (_proxyUrls.length === 0) {
    log('[IP] rotateToValidatedProxy: no proxies available', 'WARN');
    return null;
  }
  // Start from the next proxy in the list
  const tried: string[] = [];
  const triedReasons: Array<{ proxy: string; reason: string; latencyMs?: number }> = [];
  for (let i = 0; i < Math.min(maxToTry, _proxyUrls.length); i++) {
    const candidate = _rotateProxy();
    if (!candidate || tried.includes(candidate)) continue;
    tried.push(candidate);
    const result = await validateProxy(candidate);
    if (result.ok) {
      _recordProxyOutcome({
        timestamp: Date.now(),
        action: 'rotated',
        proxy: candidate,
        reason: `validated after ${tried.length} attempt(s)`,
        testUrl: getCONFIG().APP_URL || 'https://app.mathu.co.za',
        latencyMs: result.latencyMs,
      });
      log(`[IP] Validated proxy ${candidate} in ${result.latencyMs}ms (HTTP ${result.statusCode || '?'})`, 'INFO');
      // Update env vars so HTTP clients that read them (e.g. fetch in Node) use the new proxy
      process.env.HTTP_PROXY = candidate;
      process.env.HTTPS_PROXY = candidate;
      return candidate;
    }
    triedReasons.push({ proxy: candidate, reason: result.reason || 'unknown', latencyMs: result.latencyMs });
    log(`[IP] Proxy ${candidate} FAILED validation (${result.reason || 'unknown'}, ${result.latencyMs}ms)`, 'DEBUG');
  }
  // All tested proxies failed
  _recordProxyOutcome({
    timestamp: Date.now(),
    action: 'failed',
    proxy: null,
    reason: `all ${tried.length} tested proxies failed validation`,
    testUrl: getCONFIG().APP_URL || 'https://app.mathu.co.za',
  });
  log(`[IP] rotateToValidatedProxy: all ${tried.length} tested proxies failed. Reasons: ${JSON.stringify(triedReasons)}`, 'WARN');
  return null;
}

/**
 * Bypass the proxy — FULLY shut it down so no code path uses it anymore.
 *
 * BUG FIX (2026-09-09): The old `bypassProxy()` only set `__proxyDisabled = true`
 * but did NOT clear:
 *   - `process.env.HTTP_PROXY` / `process.env.HTTPS_PROXY` — Node's `fetch()`
 *     (used by vision providers, self-heal, ip-rotator's own validateProxy, etc.)
 *     respects these env vars and STILL routes through the dead proxy.
 *   - `_currentProxyIndex` — `getCurrentProxy()` still returns the old proxy URL,
 *     so any code that checks it thinks a proxy is active.
 *
 * This was causing `ERR_PROXY_CONNECTION_FAILED` and `ERR_EMPTY_RESPONSE` even
 * AFTER the proxy was "disabled" — the bot kept using the dead proxy via env vars.
 *
 * Now `bypassProxy()` is the SINGLE canonical way to disable the proxy. It:
 *   1. Sets `__proxyDisabled = true` (stops Playwright context from using proxy)
 *   2. Clears `process.env.HTTP_PROXY` / `HTTPS_PROXY` (stops Node fetch)
 *   3. Resets `_currentProxyIndex = -1` (stops `getCurrentProxy()` from returning stale proxy)
 *   4. Records the bypass in the proxy outcome log
 */
function bypassProxy(reason: string): void {
  const wasActive = !!(globalThis as any).__proxyDisabled === false && getCurrentProxy();
  if (!(globalThis as any).__proxyDisabled) {
    (globalThis as any).__proxyDisabled = true;
    log(`[IP] Proxy BYPASSED — reason: ${reason}. Fully shutting down proxy (env vars + state).`, 'WARN');
  }
  // Clear environment variables so Node's fetch() / HTTP clients stop using the proxy
  if (process.env.HTTP_PROXY) {
    const _oldProxy = process.env.HTTP_PROXY;
    delete process.env.HTTP_PROXY;
    log(`[IP] Cleared process.env.HTTP_PROXY (was: ${_oldProxy})`, 'DEBUG');
  }
  if (process.env.HTTPS_PROXY) {
    delete process.env.HTTPS_PROXY;
    log('[IP] Cleared process.env.HTTPS_PROXY', 'DEBUG');
  }
  if (process.env.NO_PROXY) {
    delete process.env.NO_PROXY;
    log('[IP] Cleared process.env.NO_PROXY', 'DEBUG');
  }
  // Reset the ip-rotator state so getCurrentProxy() returns null
  const _oldIndex = _currentProxyIndex;
  _currentProxyIndex = -1;
  if (wasActive || _oldIndex >= 0) {
    log(`[IP] Reset _currentProxyIndex from ${_oldIndex} to -1 (no proxy active)`, 'DEBUG');
  }
  _recordProxyOutcome({
    timestamp: Date.now(),
    action: 'bypassed',
    proxy: null, // proxy is now null — fully shut down
    reason,
  });
}

/**
 * Validate the current proxy (or rotate to a new one if it fails).
 * Called by `browser.ts` `setupContext` BEFORE creating the browser context.
 *
 * Returns:
 *   - 'current'   — current proxy passed validation, use it
 *   - 'rotated'   — current proxy failed, rotated to a new validated one
 *   - 'bypassed'  — all proxies failed, fall back to direct connection
 *   - 'direct'    — no proxy was active (already on direct)
 */
async function ensureValidProxy(): Promise<'current' | 'rotated' | 'bypassed' | 'direct'> {
  // If proxies are already disabled (e.g. by chrome-error handler), don't re-enable
  if ((globalThis as any).__proxyDisabled) return 'direct';

  const currentProxy = getCurrentProxy();
  if (!currentProxy) {
    // No proxy active — try to activate one
    if (_proxyUrls.length === 0) return 'direct';
    const validated = await rotateToValidatedProxy();
    if (validated) return 'rotated';
    bypassProxy('all proxies failed validation during ensureValidProxy');
    return 'bypassed';
  }

  // Validate the current proxy
  const result = await validateProxy(currentProxy);
  if (result.ok) {
    _recordProxyOutcome({
      timestamp: Date.now(),
      action: 'validated',
      proxy: currentProxy,
      reason: 'pre-launch validation passed',
      testUrl: getCONFIG().APP_URL || 'https://app.mathu.co.za',
      latencyMs: result.latencyMs,
    });
    log(`[IP] Pre-launch validation: current proxy OK (${currentProxy}, ${result.latencyMs}ms, HTTP ${result.statusCode})`, 'DEBUG');
    return 'current';
  }

  // Current proxy failed — try to rotate
  log(`[IP] Pre-launch validation: current proxy FAILED (${currentProxy}, ${result.reason}, ${result.latencyMs}ms). Rotating...`, 'WARN');
  const newProxy = await rotateToValidatedProxy();
  if (newProxy) return 'rotated';

  // All proxies failed
  bypassProxy(`current proxy failed validation (${result.reason}); rotation exhausted`);
  return 'bypassed';
}

/**
 * Report a network error (called by cycle manager when navigation fails).
 * Categorizes the error and records it for dashboard display.
 */
function recordNetworkError(error: any, context?: { url?: string; cycleCount?: number }): void {
  const msg = String(error?.message || error);
  let errorType = 'UNKNOWN';

  // Categorize common Playwright / Node network errors
  if (/ERR_CONNECTION_CLOSED/i.test(msg)) errorType = 'ERR_CONNECTION_CLOSED';
  else if (/ERR_CONNECTION_RESET/i.test(msg)) errorType = 'ERR_CONNECTION_RESET';
  else if (/ERR_CONNECTION_REFUSED/i.test(msg)) errorType = 'ERR_CONNECTION_REFUSED';
  else if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/i.test(msg)) errorType = 'ERR_CONNECTION_TIMED_OUT';
  else if (/ERR_NAME_NOT_RESOLVED/i.test(msg)) errorType = 'ERR_NAME_NOT_RESOLVED';
  else if (/ERR_PROXY_CONNECTION_FAILED/i.test(msg)) errorType = 'ERR_PROXY_CONNECTION_FAILED';
  else if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(msg)) errorType = 'ERR_TUNNEL_CONNECTION_FAILED';
  else if (/ERR_INTERNET_DISCONNECTED/i.test(msg)) errorType = 'ERR_INTERNET_DISCONNECTED';
  else if (/ERR_BLOCKED_BY_CLIENT/i.test(msg)) errorType = 'ERR_BLOCKED_BY_CLIENT';
  else if (/ERR_CERT/i.test(msg)) errorType = 'ERR_CERT';
  else if (/chrome-error/i.test(msg)) errorType = 'CHROME_ERROR_PAGE';
  else if (/Timeout \d+ms exceeded/i.test(msg)) errorType = 'NAV_TIMEOUT';
  else if (/Target closed|Target page.*closed/i.test(msg)) errorType = 'TARGET_CLOSED';
  else if (/net::ERR/i.test(msg)) {
    const m = msg.match(/net::(ERR_[A-Z_]+)/i);
    if (m) errorType = m[1];
  }

  const rec: NetworkErrorRecord = {
    timestamp: Date.now(),
    errorType,
    url: context?.url,
    proxy: getCurrentProxy(),
    message: msg.substring(0, 300),
    cycleCount: context?.cycleCount,
  };
  _recordNetworkError(rec);
  log(`[IP] Network error recorded: ${errorType}${context?.url ? ' @ ' + context.url : ''}${rec.proxy ? ' (via ' + rec.proxy + ')' : ''}`, 'WARN');
}

/**
 * Check the current server IP and compare with previous.
 * Call at startup.
 */
async function checkIp(): Promise<string | null> {
  try {
    // If we have a proxy active, check IP through the proxy
    const proxy = getCurrentProxy();
    const fetchOptions: any = { signal: AbortSignal.timeout(10000) };

    const response = await fetch(_getIpCheckUrl(), fetchOptions);

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

    if (_previousIp && _previousIp !== ip) {
      log(`[IP] IP changed: ${_previousIp} → ${ip}`, 'WARN');
    } else {
      log(`[IP] Current IP: ${ip}${proxy ? ' (via proxy ' + proxy + ')' : ''}`, 'INFO');
    }

    return ip;
  } catch (err) {
    log(`[IP] IP check failed: ${(err as Error).message}`, 'WARN');
    return _currentIp;
  }
}

function _getIpCheckUrl(): string {
  const CONFIG = getCONFIG();
  return String(CONFIG.IP_CHECK_URL || DEFAULT_IP_CHECK_URL);
}

function _getIpBlockThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.IP_BLOCK_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_IP_BLOCK_THRESHOLD;
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

function reset403Count(): void {
  _consecutive403s = 0;
}

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
        `No proxies available. ProxyScrape may be down or returned empty list.`
      );
    }
  } catch { /* non-critical */ }
}

function _rotateProxy(): string | null {
  if (_proxyUrls.length === 0) return null;

  _currentProxyIndex = (_currentProxyIndex + 1) % _proxyUrls.length;
  const proxy = _proxyUrls[_currentProxyIndex];
  log(`[IP] Rotated to proxy ${_currentProxyIndex + 1}/${_proxyUrls.length}: ${proxy}`, 'INFO');
  return proxy;
}

function getCurrentProxy(): string | null {
  return _currentProxyIndex >= 0 ? _proxyUrls[_currentProxyIndex] : null;
}

function isIpBlocked(): boolean {
  return _isIpBlocked;
}

function unblockIp(): void {
  _isIpBlocked = false;
  _consecutive403s = 0;
  log('[IP] IP block manually cleared.', 'INFO');
}

/**
 * Manually rotate to the next proxy.
 */
function rotateProxy(): string | null {
  return _rotateProxy();
}

/**
 * Get diagnostic status.
 */
function getStatus(): Record<string, any> {
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
    proxySource: _proxyUrls.length > 0 ? 'proxyscrape' : 'none',
    // New: dashboard surface
    proxyDisabled: !!(globalThis as any).__proxyDisabled,
    latestProxyOutcome: _latestProxyOutcome,
    latestNetworkError: _latestNetworkError,
    networkErrorCount: _networkErrorHistory.length,
  };
}

/**
 * Start the IP rotator.
 */
async function start(): Promise<void> {
  if (_started) return;
  _started = true;

  // Load proxies FIRST (before checking IP)
  await _loadProxyUrls();

  // If we have proxies, activate the first one immediately (before IP check)
  // so the IP check goes through the proxy
  if (_proxyUrls.length > 0) {
    _currentProxyIndex = 0;
    const firstProxy = _proxyUrls[0];
    process.env.HTTP_PROXY = firstProxy;
    process.env.HTTPS_PROXY = firstProxy;
    log(`[IP] Activated proxy before IP check: ${firstProxy}`, 'INFO');
  } else {
    log('[IP] No proxies available — using direct connection', 'WARN');
  }

  log('[IP] IP rotator started', 'INFO');

  // Check IP (will go through the proxy if one is active)
  await checkIp();

  // Set up periodic proxy list refresh (every 10 min)
  _proxyRefreshTimer = setInterval(async () => {
    try {
      log('[IP] Refreshing proxy list from ProxyScrape...', 'DEBUG');
      const oldCount = _proxyUrls.length;
      await _loadProxyUrls();
      if (_proxyUrls.length !== oldCount) {
        log(`[IP] Proxy list refreshed: ${oldCount} → ${_proxyUrls.length} proxies`, 'INFO');
      }
    } catch { /* non-critical */ }
  }, PROXY_REFRESH_INTERVAL_MS);
  if (_proxyRefreshTimer && typeof (_proxyRefreshTimer as any).unref === 'function') {
    (_proxyRefreshTimer as any).unref();
  }
}

module.exports = {
  _injectDependencies,
  checkIp,
  report403,
  reset403Count,
  getCurrentProxy,
  isIpBlocked,
  unblockIp,
  rotateProxy,
  getStatus,
  start,
  // New: proxy validation + recovery
  validateProxy,
  rotateToValidatedProxy,
  ensureValidProxy,
  bypassProxy,
  // New: network error tracking
  recordNetworkError,
  getLatestProxyOutcome,
  getLatestNetworkError,
  getNetworkErrorHistory,
};
