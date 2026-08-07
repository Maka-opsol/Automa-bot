'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const { fetchJSON } = require('./utils-fetch');
const CONFIG = require('./get-config');
const { log, logError } = require('./logger');

const IP_SERVICES = [
  { name: 'freeipapi', url: 'https://free.freeipapi.com/api/json', parser: (data: any) => ({ ip: data.ipAddress, city: data.city || null, country: data.country || null }) },
  { name: 'ipapi', url: 'https://ipapi.co/json/', parser: (data: any) => ({ ip: data.ip, city: data.city || null, country: data.country_name || null }) },
  { name: 'ip-api', url: 'https://ip-api.com/json/', parser: (data: any) => ({ ip: data.query, city: data.city || null, country: data.country || null }) },
  { name: 'ipify-geo', url: 'https://geo.ipify.org/api/v2/country?apiKey=demo', parser: (data: any) => ({ ip: data.ip, city: data.location?.city || null, country: data.location?.country || null }) }
];

async function checkIpLocation() { 
  for (const service of IP_SERVICES) {
    try {
      log(`🌐 Checking IP location via ${service.name}...`, 'DEBUG', 'ip-check');
      const data = await fetchJSON(service.url, {}, 10000);
      const result = service.parser(data);
      if (!result.ip) continue;
      // Require city AND country — skip services that don't provide full location
      if (!result.city || !result.country) { log(`IP check via ${service.name} returned IP ${result.ip} but no city/country, trying next...`, 'DEBUG', 'ip-check'); continue; }
      log(`📍 IP location: ${result.city}, ${result.country} (${result.ip})`, 'INFO', 'ip-check');
      const cityMatch = result.city.toLowerCase().includes((CONFIG.EXPECTED_IP_CITY || '').toLowerCase());
      const countryMatch = result.country.toLowerCase().includes((CONFIG.EXPECTED_IP_COUNTRY || '').toLowerCase());
      if (!cityMatch || !countryMatch) { log(`⚠️ IP location mismatch! Expected "${CONFIG.EXPECTED_IP_CITY}, ${CONFIG.EXPECTED_IP_COUNTRY}" but got "${result.city}, ${result.country}"`, 'WARN', 'ip-check'); if (CONFIG.ALERT_ON_ERROR) { const { sendAlert } = require('./alerting'); sendAlert(`IP location mismatch: ${result.city}, ${result.country}`); } } else { log('✅ IP location matches expected region.', 'INFO', 'ip-check'); }
      return result;
    } catch (err: any) { logError(`IP check via ${service.name} failed`, err); continue; }
  }
  log(`⚠️ All IP check services failed (ignoring)`, 'WARN', 'ip-check');
  return null;
}

module.exports = { checkIpLocation, _injectDependencies };
