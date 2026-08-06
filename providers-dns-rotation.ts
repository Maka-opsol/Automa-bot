// Resilience R3b: DNS-over-HTTPS Fallback — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// providers-dns-rotation.ts — DNS Resolution Fallback
// ═══════════════════════════════════════════════════════════════
// On Render free tier, DNS resolution can fail silently or return
// NXDOMAIN for API endpoints. This module wraps fetch() calls with
// DNS fallback: if primary DNS fails, try CloudFlare DoH (1.1.1.1)
// and Google DoH (8.8.8.8) before giving up.
//
// Usage:
//   const dnsRotation = require('./providers-dns-rotation');
//   const response = await dnsRotation.fetchWithDnsFallback(url, options);
//
// Also provides: dnsResolveWithFallback(hostname) for manual resolution.
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'dns-rotation') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [dns-rotation] ${msg}`, err);
}

// ─── DoH Servers ───
const DOH_SERVERS = [
  { name: 'CloudFlare', url: 'https://1.1.1.1/dns-query' },
  { name: 'Google', url: 'https://8.8.8.8/dns-query' },
];

// ─── Cache: hostname → [IPs] with TTL ───
const _dnsCache: Map<string, { ips: string[]; expiresAt: number }> = new Map();
const DNS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Resolution stats ───
const _stats = {
  totalResolutions: 0,
  primarySuccess: 0,
  fallbackSuccess: 0,
  failures: 0,
};

/**
 * Perform a DNS-over-HTTPS query for a hostname.
 * Returns an array of IP addresses or empty array on failure.
 */
async function dohResolve(hostname: string, dohServer: { name: string; url: string }): Promise<string[]> {
  const dohUrl = `${dohServer.url}?name=${encodeURIComponent(hostname)}&type=A`;
  try {
    const response = await fetch(dohUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/dns-json' },
    });
    if (!response.ok) return [];

    const data = await response.json() as any;
    if (!data.Answer) return [];

    return data.Answer
      .filter((a: any) => a.type === 4) // A records only
      .map((a: any) => a.data)
      .filter((ip: string) => ip && ip.length > 0);
  } catch (e: any) {
    log(`DoH ${dohServer.name} query for ${hostname} failed: ${e.message || String(e)}`, 'DEBUG');
    return [];
  }
}

/**
 * Get cached DNS result if still valid.
 */
function getCached(hostname: string): string[] | null {
  const cached = _dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ips;
  }
  _dnsCache.delete(hostname);
  return null;
}

/**
 * Store DNS result in cache.
 */
function setCache(hostname: string, ips: string[]): void {
  if (ips.length === 0) return;
  _dnsCache.set(hostname, { ips, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
}

/**
 * Resolve a hostname with fallback through DoH servers.
 * 
 * Strategy:
 *   1. Check cache first
 *   2. Try system DNS (dns.promises.resolve)
 *   3. If fails, try CloudFlare DoH
 *   4. If fails, try Google DoH
 *   5. Cache result
 */
async function dnsResolveWithFallback(hostname: string): Promise<string[]> {
  _stats.totalResolutions++;

  // Step 1: Check cache
  const cached = getCached(hostname);
  if (cached) {
    return cached;
  }

  // Step 2: Try system DNS
  try {
    const dns = require('dns').promises;
    const ips = await dns.resolve4(hostname);
    if (ips && ips.length > 0) {
      _stats.primarySuccess++;
      setCache(hostname, ips);
      return ips;
    }
  } catch (e: any) {
    log(`System DNS failed for ${hostname}: ${e.code || e.message || String(e)}`, 'WARN');
  }

  // Step 3+4: Try DoH fallback servers
  for (const server of DOH_SERVERS) {
    try {
      const ips = await dohResolve(hostname, server);
      if (ips.length > 0) {
        _stats.fallbackSuccess++;
        log(`DoH ${server.name} resolved ${hostname} → ${ips.join(', ')}`, 'INFO');
        setCache(hostname, ips);
        return ips;
      }
    } catch (e: any) {
      log(`DoH ${server.name} failed for ${hostname}: ${e.message || String(e)}`, 'WARN');
    }
  }

  // All resolution methods failed
  _stats.failures++;
  log(`All DNS resolution failed for ${hostname}`, 'ERROR');
  return [];
}

/**
 * Fetch with DNS rotation fallback.
 * 
 * If a fetch fails with an ECONNREFUSED or ENOTFOUND error that
 * looks like a DNS issue, re-resolve the hostname via DoH and retry
 * with the explicit IP in the Host header.
 * 
 * This is transparent — callers just use this instead of global fetch.
 */
async function fetchWithDnsFallback(input: string | Request | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  try {
    // First try: normal fetch (system DNS)
    const response = await fetch(input, init);
    return response;
  } catch (err: any) {
    const errorCode = err.code || err.cause?.code;
    const isDnsError = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ESERVFAIL', 'ECONNREFUSED'].includes(errorCode);

    if (!isDnsError) {
      throw err; // Not a DNS error, rethrow
    }

    // DNS error — try DoH resolution
    let hostname: string | null = null;
    try {
      const parsedUrl = new URL(url);
      hostname = parsedUrl.hostname;
    } catch {
      throw err; // Can't parse URL, rethrow original
    }

    if (!hostname) throw err;

    log(`DNS error (${errorCode}) for ${hostname}, attempting DoH fallback...`, 'WARN');
    const ips = await dnsResolveWithFallback(hostname);

    if (ips.length === 0) {
      log(`DoH fallback failed — no IPs for ${hostname}`, 'ERROR');
      throw err; // Can't recover
    }

    // Retry with first resolved IP, using Host header for virtual hosting
    for (const ip of ips) {
      try {
        const fallbackUrl = url.replace(hostname, ip);
        const fallbackInit: RequestInit = {
          ...init,
          headers: {
            ...(init?.headers || {}),
            'Host': hostname,
          },
        };

        log(`Retrying fetch for ${hostname} via ${ip}`, 'DEBUG');
        const response = await fetch(fallbackUrl, fallbackInit);
        log(`DoH fallback succeeded for ${hostname} via ${ip} (status ${response.status})`, 'INFO');
        return response;
      } catch (retryErr: any) {
        log(`DoH fallback retry with ${ip} failed: ${retryErr.code || retryErr.message || String(retryErr)}`, 'WARN');
      }
    }

    // All retries failed
    throw err;
  }
}

/**
 * Clear the DNS cache. Useful when network conditions change.
 */
function clearDnsCache(): void {
  _dnsCache.clear();
  log('DNS cache cleared', 'DEBUG');
}

/**
 * Get DNS resolution stats for diagnostics.
 */
function getDnsStats(): Record<string, any> {
  return {
    totalResolutions: _stats.totalResolutions,
    primarySuccess: _stats.primarySuccess,
    fallbackSuccess: _stats.fallbackSuccess,
    failures: _stats.failures,
    cacheSize: _dnsCache.size,
    fallbackRate: _stats.totalResolutions > 0
      ? ((_stats.fallbackSuccess / _stats.totalResolutions) * 100).toFixed(1) + '%'
      : '0%',
  };
}

/**
 * Pre-resolve known API endpoints at startup.
 * Populates the cache so first requests are fast.
 */
async function preResolveEndpoints(endpoints: string[]): Promise<void> {
  log(`Pre-resolving ${endpoints.length} endpoints...`, 'INFO');
  const promises = endpoints.map(async (endpoint) => {
    try {
      const parsed = new URL(endpoint);
      await dnsResolveWithFallback(parsed.hostname);
    } catch (e: any) {
      log(`Pre-resolve failed for ${endpoint}: ${e.message || String(e)}`, 'WARN');
    }
  });
  await Promise.allSettled(promises);
  log(`Pre-resolution complete (cache: ${_dnsCache.size} entries)`, 'INFO');
}

module.exports = {
  fetchWithDnsFallback,
  dnsResolveWithFallback,
  clearDnsCache,
  getDnsStats,
  preResolveEndpoints,
  _injectDependencies,
};
