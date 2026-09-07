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
};
