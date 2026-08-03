'use strict';

// Lazy logger to avoid top-level circular dependency
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const USER_AGENTS_FILE = path.join(PROJECT_ROOT, 'data', 'user-agents.json');
const USER_AGENTS_TTL = 24 * 60 * 60 * 1000;
let cachedAgents: any = null;
let cacheTimestamp = 0;
let _cachePromise: any = null;

const DEFAULT_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

const BROWSER_PROFILES = [
  {
    name: 'chrome-windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    screen: { width: 1920, height: 1080 },
    platform: 'Windows',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"Windows"',
    prefersDark: false,
    reducedMotion: 'no-preference'
  },
  {
    name: 'chrome-macos',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    screen: { width: 2560, height: 1440 },
    platform: 'Mac',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"macOS"',
    prefersDark: false,
    reducedMotion: 'no-preference'
  }
];

function getRandomBrowserProfile() {  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)]; }

async function fetchLatestUserAgents() { 
  try {
    const { fetchWithTimeout } = require('./utils-fetch');
    const response = await fetchWithTimeout('https://raw.githubusercontent.com/microlinkhq/top-user-agents/master/src/index.json', {}, 10000);
    if (response.ok) {
      const agents = await response.json();
      return agents.filter((ua: any) => ua.includes('Windows NT 10') || ua.includes('Macintosh')).slice(0, 20);
    }
  } catch (err: any) { _getLogger().log(`Failed to fetch user agents: ${err.message}`, 'DEBUG', 'user-agent'); }
  return DEFAULT_AGENTS;
}

async function getUserAgent() {
  if (_cachePromise) return _cachePromise;
  _cachePromise = _loadUserAgents().finally(() => { _cachePromise = null; });
  return _cachePromise;
}

async function _loadUserAgents() { 
  const now = Date.now();
  if (!cachedAgents || (now - cacheTimestamp > USER_AGENTS_TTL)) {
    try {
      if (fs.existsSync(USER_AGENTS_FILE)) {
        const stat = fs.statSync(USER_AGENTS_FILE);
        if (now - stat.mtimeMs < USER_AGENTS_TTL) {
          cachedAgents = JSON.parse(fs.readFileSync(USER_AGENTS_FILE, 'utf8'));
          cacheTimestamp = stat.mtimeMs;
        }
      }
    } catch {}
    if (!cachedAgents) {
      cachedAgents = await fetchLatestUserAgents();
      cacheTimestamp = now;
      if (cachedAgents !== DEFAULT_AGENTS) {
        try {
          const dir = path.dirname(USER_AGENTS_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(USER_AGENTS_FILE, JSON.stringify(cachedAgents, null, 2));
        } catch {}
      }
    }
  }
  if (!cachedAgents || cachedAgents.length === 0) return DEFAULT_AGENTS[Math.floor(Math.random() * DEFAULT_AGENTS.length)];
  return cachedAgents[Math.floor(Math.random() * cachedAgents.length)];
}

async function getRealisticBrowserContext() { 
  const profile = getRandomBrowserProfile();
  return {
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    screen: profile.screen,
    locale: 'en-US',
    timezoneId: 'Africa/Johannesburg',
    geolocation: { latitude: -26.2041, longitude: 28.0473 },
    permissions: ['geolocation'],
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    colorScheme: profile.prefersDark ? 'dark' : 'light',
    reducedMotion: profile.reducedMotion,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': profile.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': profile.secChUaPlatform,
    }
  };
}

module.exports = { getUserAgent, getRealisticBrowserContext };
