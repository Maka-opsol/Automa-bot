'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const CONFIG = require('./get-config');
const { log, logError } = require('./logger');

// ─── Circuit breaker state ───
let _allServicesFailedAt = 0;
const CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown after all services fail

// ─── IP Services ───
// Ordered by reliability on Render free plan:
//   1. ip-api — free, no key, but requires HTTP (not HTTPS) for free tier
//   2. freeipapi — free, no key, no rate limit issues
//   3. ipwhois — free, no key, 10K/month
//   4. ipapi — rate-limited on free tier (429), kept as fallback
// NOTE: ipify-geo removed — requires paid API key (demo key returns 403)
const IP_SERVICES = [
  { name: 'ip-api', url: 'http://ip-api.com/json/', parser: (data: any) => ({ ip: data.query, city: data.city || null, country: data.country || null }) },
  { name: 'freeipapi', url: 'https://free.freeipapi.com/api/json', parser: (data: any) => ({ ip: data.ipAddress, city: data.city || null, country: data.country || null }) },
  { name: 'ipwhois', url: 'https://ipwho.is/', parser: (data: any) => ({ ip: data.ip, city: data.city || null, country: data.country || null }) },
  { name: 'ipapi', url: 'https://ipapi.co/json/', parser: (data: any) => ({ ip: data.ip, city: data.city || null, country: data.country_name || null }) },
];

async function fetchIP(service: { name: string; url: string }): Promise<any> {
  // Use dynamic require to avoid top-level import issues
  const { fetchJSON } = require('./utils-fetch');
  return fetchJSON(service.url, {}, 8000);
}

async function checkIpLocation() { 
  // Circuit breaker: if all services failed recently, skip entirely
  if (_allServicesFailedAt > 0 && Date.now() - _allServicesFailedAt < CIRCUIT_COOLDOWN_MS) {
    const remainingMs = CIRCUIT_COOLDOWN_MS - (Date.now() - _allServicesFailedAt);
    log(`IP check circuit breaker active (${Math.round(remainingMs / 1000)}s remaining), skipping`, 'DEBUG', 'ip-check');
    return null;
  }

  // Reset circuit breaker on new attempt
  _allServicesFailedAt = 0;

  for (const service of IP_SERVICES) {
    try {
      log(`Checking IP location via ${service.name}...`, 'DEBUG', 'ip-check');
      const data = await fetchIP(service);
      const result = service.parser(data);
      if (!result.ip) continue;
      // Require city AND country — skip services that don't provide full location
      if (!result.city || !result.country) { log(`IP check via ${service.name} returned IP ${result.ip} but no city/country, trying next...`, 'DEBUG', 'ip-check'); continue; }
      log(`IP location: ${result.city}, ${result.country} (${result.ip})`, 'INFO', 'ip-check');
      const cityMatch = result.city.toLowerCase().includes((CONFIG.EXPECTED_IP_CITY || '').toLowerCase());
      const countryMatch = result.country.toLowerCase().includes((CONFIG.EXPECTED_IP_COUNTRY || '').toLowerCase());
      if (!cityMatch || !countryMatch) { log(`IP location mismatch! Expected "${CONFIG.EXPECTED_IP_CITY}, ${CONFIG.EXPECTED_IP_COUNTRY}" but got "${result.city}, ${result.country}"`, 'WARN', 'ip-check'); if (CONFIG.ALERT_ON_ERROR) { const { sendAlert } = require('./alerting'); sendAlert(`IP location mismatch: ${result.city}, ${result.country}`); } } else { log('IP location matches expected region.', 'INFO', 'ip-check'); }
      return result;
    } catch (err: any) {
      // Downgrade 429/403 to DEBUG — these are expected for free-tier services
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
  
  // All services failed — activate circuit breaker
  _allServicesFailedAt = Date.now();
  log(`All IP check services failed — circuit breaker active for ${CIRCUIT_COOLDOWN_MS / 1000}s`, 'WARN', 'ip-check');
  return null;
}

module.exports = { checkIpLocation, _injectDependencies };
