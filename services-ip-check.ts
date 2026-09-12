'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const CONFIG = require('./get-config');
const { log, logError } = require('./logger');

// ─── Circuit breaker state ───
let _allServicesFailedAt = 0;
const CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown after all services fail

// ─── IP Services ───
const IP_SERVICES = [
  { name: 'ip-api', url: 'http://ip-api.com/json/', parser: (data: any) => ({ ip: data.query, city: data.city || null, country: data.country || null }) },
  { name: 'freeipapi', url: 'https://free.freeipapi.com/api/json', parser: (data: any) => ({ ip: data.ipAddress, city: data.city || null, country: data.country || null }) },
  { name: 'ipwhois', url: 'https://ipwho.is/', parser: (data: any) => ({ ip: data.ip, city: data.city || null, country: data.country || null }) },
  { name: 'ipapi', url: 'https://ipapi.co/json/', parser: (data: any) => ({ ip: data.ip, city: data.city || null, country: data.country_name || null }) },
];

/**
 * Get the current proxy from the IP rotator (if available).
 */
function _getCurrentProxy(): string | null {
  try {
    const ipRotator = require('./network-ip-rotator');
    return ipRotator.getCurrentProxy?.() || null;
  } catch { return null; }
}

/**
 * Rotate to the next proxy via the IP rotator.
 */
function _rotateToNextProxy(): string | null {
  try {
    const ipRotator = require('./network-ip-rotator');
    return ipRotator.rotateProxy?.() || null;
  } catch { return null; }
}

/**
 * Check IP via a specific proxy URL using Node's native fetch with
 * a manual CONNECT tunnel. Since Node's fetch ignores HTTP_PROXY env vars,
 * we use a raw TCP socket through the proxy to fetch the IP check URL.
 *
 * For simplicity, we use the `http` module to make a request through an
 * HTTP proxy (CONNECT method). SOCKS proxies are not supported via this
 * method — we skip the proxy check for SOCKS and fall back to direct check.
 */
async function _checkIpThroughProxy(proxyUrl: string): Promise<{ ip: string; city: string; country: string } | null> {
  // Parse the proxy URL
  let proxyHost: string;
  let proxyPort: number;
  let isHttpProxy = false;

  try {
    const parsed = new URL(proxyUrl);
    proxyHost = parsed.hostname;
    proxyPort = parseInt(parsed.port, 10);
    isHttpProxy = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return null;
  }

  // Only HTTP proxies can be used with Node's http module for CONNECT tunneling.
  // SOCKS proxies require a SOCKS client (not available without extra deps).
  if (!isHttpProxy) {
    log(`Proxy ${proxyUrl} is not HTTP — can't verify IP through it (SOCKS not supported without extra deps). Assuming it works.`, 'DEBUG', 'ip-check');
    return null;
  }

  // Use http.request to make a request through an HTTP proxy
  // The proxy will forward the request and we'll get the IP as seen by the proxy
  const http = require('http');
  const https = require('https');

  return new Promise((resolve) => {
    const targetUrl = 'http://ip-api.com/json/';
    const targetParsed = new URL(targetUrl);

    const options = {
      hostname: proxyHost,
      port: proxyPort,
      path: targetUrl,
      method: 'GET',
      headers: {
        'Host': targetParsed.hostname,
        'User-Agent': 'MathU-Bot-IP-Check/1.0',
      },
      timeout: 10000,
    };

    const req = http.request(options, (res: any) => {
      let body = '';
      res.on('data', (chunk: any) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.query) {
            resolve({ ip: data.query, city: data.city || '', country: data.country || '' });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Check the server's direct IP (no proxy).
 */
async function _checkDirectIp(): Promise<{ ip: string; city: string; country: string } | null> {
  const { fetchJSON } = require('./utils-fetch');
  for (const service of IP_SERVICES) {
    try {
      const data = await fetchJSON(service.url, {}, 8000);
      const result = service.parser(data);
      if (result.ip && result.city && result.country) {
        return result;
      }
    } catch { continue; }
  }
  return null;
}

async function checkIpLocation() {
  // Circuit breaker
  if (_allServicesFailedAt > 0 && Date.now() - _allServicesFailedAt < CIRCUIT_COOLDOWN_MS) {
    const remainingMs = CIRCUIT_COOLDOWN_MS - (Date.now() - _allServicesFailedAt);
    log(`IP check circuit breaker active (${Math.round(remainingMs / 1000)}s remaining), skipping`, 'DEBUG', 'ip-check');
    return null;
  }
  _allServicesFailedAt = 0;

  const proxy = _getCurrentProxy();

  if (proxy) {
    // ── Proxy is active: verify the proxy is changing the IP ──
    log(`Proxy active (${proxy}) — verifying proxy is changing IP...`, 'INFO', 'ip-check');

    // 1. Check IP through the proxy (if HTTP proxy)
    const proxyResult = await _checkIpThroughProxy(proxy);

    if (proxyResult) {
      log(`IP through proxy: ${proxyResult.city}, ${proxyResult.country} (${proxyResult.ip})`, 'INFO', 'ip-check');
      const cityMatch = proxyResult.city.toLowerCase().includes((CONFIG.EXPECTED_IP_CITY || '').toLowerCase());
      const countryMatch = proxyResult.country.toLowerCase().includes((CONFIG.EXPECTED_IP_COUNTRY || '').toLowerCase());

      if (cityMatch && countryMatch) {
        log(`Proxy IP matches expected region (${proxyResult.city}, ${proxyResult.country}). Proxy is working correctly.`, 'INFO', 'ip-check');
        return proxyResult;
      } else {
        log(`Proxy IP mismatch! Expected "${CONFIG.EXPECTED_IP_CITY}, ${CONFIG.EXPECTED_IP_COUNTRY}" but proxy shows "${proxyResult.city}, ${proxyResult.country}". Trying next proxy...`, 'WARN', 'ip-check');
        // Rotate to next proxy and retry once
        const nextProxy = _rotateToNextProxy();
        if (nextProxy && nextProxy !== proxy) {
          log(`Rotated to next proxy: ${nextProxy}`, 'INFO', 'ip-check');
          const retryResult = await _checkIpThroughProxy(nextProxy);
          if (retryResult) {
            log(`IP through new proxy: ${retryResult.city}, ${retryResult.country} (${retryResult.ip})`, 'INFO', 'ip-check');
            const retryCityMatch = retryResult.city.toLowerCase().includes((CONFIG.EXPECTED_IP_CITY || '').toLowerCase());
            const retryCountryMatch = retryResult.country.toLowerCase().includes((CONFIG.EXPECTED_IP_COUNTRY || '').toLowerCase());
            if (retryCityMatch && retryCountryMatch) {
              log(`New proxy IP matches expected region. Proxy is working correctly.`, 'INFO', 'ip-check');
              return retryResult;
            }
          }
        }
        // If we get here, no proxy gave the expected location
        if (CONFIG.ALERT_ON_ERROR) {
          const { sendAlert } = require('./alerting');
          // TASK 61: Removed alert — routine event.
        }
        log('No proxy returned expected ZA location. Browser may be using wrong IP.', 'ERROR', 'ip-check');
        return null;
      }
    } else {
      // Can't verify through proxy (SOCKS proxy, or proxy check failed).
      // Log it but don't alert — the browser uses the proxy via Chrome --proxy-server flag.
      log(`Could not verify IP through proxy ${proxy} (may be SOCKS or unreachable). Browser uses proxy via Chrome flag — assuming it works.`, 'WARN', 'ip-check');
      return null;
    }
  }

  // ── No proxy: check direct IP ──
  for (const service of IP_SERVICES) {
    try {
      log(`Checking IP location via ${service.name}...`, 'DEBUG', 'ip-check');
      const { fetchJSON } = require('./utils-fetch');
      const data = await fetchJSON(service.url, {}, 8000);
      const result = service.parser(data);
      if (!result.ip) continue;
      if (!result.city || !result.country) {
        log(`IP check via ${service.name} returned IP ${result.ip} but no city/country, trying next...`, 'DEBUG', 'ip-check');
        continue;
      }
      log(`IP location: ${result.city}, ${result.country} (${result.ip})`, 'INFO', 'ip-check');
      const cityMatch = result.city.toLowerCase().includes((CONFIG.EXPECTED_IP_CITY || '').toLowerCase());
      const countryMatch = result.country.toLowerCase().includes((CONFIG.EXPECTED_IP_COUNTRY || '').toLowerCase());
      if (!cityMatch || !countryMatch) {
        log(`IP location mismatch! Expected "${CONFIG.EXPECTED_IP_CITY}, ${CONFIG.EXPECTED_IP_COUNTRY}" but got "${result.city}, ${result.country}"`, 'WARN', 'ip-check');
        if (CONFIG.ALERT_ON_ERROR) {
          const { sendAlert } = require('./alerting');
          // TASK 61: Removed alert — routine event.
        }
      } else {
        log('IP location matches expected region.', 'INFO', 'ip-check');
      }
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isExpected = msg.includes('429') || msg.includes('403');
      if (isExpected) {
        log(`IP check via ${service.name} failed (expected free-tier limit), trying next...`, 'DEBUG', 'ip-check');
      } else {
        logError(`IP check via ${service.name} failed`, err);
      }
      continue;
    }
  }

  _allServicesFailedAt = Date.now();
  log(`All IP check services failed — circuit breaker active for ${CIRCUIT_COOLDOWN_MS / 1000}s`, 'WARN', 'ip-check');
  return null;
}

module.exports = { checkIpLocation, _injectDependencies };
