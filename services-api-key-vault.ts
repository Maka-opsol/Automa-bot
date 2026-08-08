'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// API Key Vault — Centralized API Key Validation & Health Tracking
//
// Problem: API keys are scattered across 15+ env vars in multiple files.
// When a key expires or gets revoked, debugging is painful.
//
// Solution: Single module that knows about ALL API keys and can:
//   - Validate keys on startup (make a lightweight test call)
//   - Track key health (last validated, expiry hints, error count)
//   - Report key status in heartbeat endpoint
//   - Alert via NTFY when a key flips valid → invalid
//
// Key registry: Each entry has envVar, service name, and a validate function
// that makes a minimal API call. Results stored in DB calibration table.
// Validation runs at startup + every 6 hours (configurable).
//
// Integration:
//   - render-free-plan.ts: starts periodic validation
//   - services-heartbeat-endpoint.ts: calls getKeyHealthSummary()
//   - services-ntfy-alerts.ts: receives alertKeyGoneBad() on failures
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

interface KeyEntry {
  envVar: string;
  envVar2?: string;        // Some services need 2 keys (e.g., MATHPIX_APP_KEY)
  service: string;
  id: string;              // Lowercase, no spaces (for DB keys)
  validate: () => Promise<{ valid: boolean; error?: string }>;
}

interface KeyHealth {
  valid: boolean;
  lastChecked: string;
  error?: string;
}

// ─── Dependencies ───────────────────────────────────────────────────────────

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

const fetch: any = globalThis.fetch;

// ─── Key Registry ─────────────────────────────────────────────────────────────

function _getKey(): string | undefined { return process.env.OPENROUTER_API_KEY; }

const KEY_REGISTRY: KeyEntry[] = [
  {
    envVar: 'OPENROUTER_API_KEY',
    service: 'OpenRouter',
    id: 'openrouter',
    validate: async () => {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { valid: true };
        return { valid: false, error: `HTTP ${res.status}` };
      } catch (e: any) {
        return { valid: false, error: e.message };
      }
    },
  },
  {
    envVar: 'CF_API_KEY',
    envVar2: 'CF_ACCOUNT_ID',
    service: 'Cloudflare Workers AI',
    id: 'cloudflare',
    validate: async () => {
      const key = process.env.CF_API_KEY;
      const accountId = process.env.CF_ACCOUNT_ID;
      if (!key || !accountId) return { valid: false, error: 'no key or account ID' };
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { valid: true };
        return { valid: false, error: `HTTP ${res.status}` };
      } catch (e: any) {
        return { valid: false, error: e.message };
      }
    },
  },
  {
    envVar: 'GROQ_API_KEY',
    service: 'Groq',
    id: 'groq',
    validate: async () => {
      const key = process.env.GROQ_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { valid: true };
        return { valid: false, error: `HTTP ${res.status}` };
      } catch (e: any) {
        return { valid: false, error: e.message };
      }
    },
  },
  {
    envVar: 'ZAI_API_KEY',
    service: 'Z.ai',
    id: 'zai',
    validate: async () => {
      // Z.ai doesn't have a public models endpoint — just check key exists and has length
      const key = process.env.ZAI_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      if (key.length < 10) return { valid: false, error: 'key too short' };
      return { valid: true };
    },
  },
  {
    envVar: 'AGNES_API_KEY',
    service: 'Agnes',
    id: 'agnes',
    validate: async () => {
      const key = process.env.AGNES_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      if (key.length < 10) return { valid: false, error: 'key too short' };
      return { valid: true };
    },
  },
  {
    envVar: 'GEMINI_API_KEY',
    service: 'Google Gemini',
    id: 'gemini',
    validate: async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { valid: true };
        return { valid: false, error: `HTTP ${res.status}` };
      } catch (e: any) {
        return { valid: false, error: e.message };
      }
    },
  },
  {
    envVar: 'NVIDIA_API_KEY',
    service: 'NVIDIA NIM',
    id: 'nvidia',
    validate: async () => {
      const key = process.env.NVIDIA_API_KEY;
      if (!key) return { valid: false, error: 'no key' };
      if (key.length < 10) return { valid: false, error: 'key too short' };
      return { valid: true };
    },
  },
  {
    envVar: 'WOLFRAM_APP_ID',
    service: 'WolframAlpha',
    id: 'wolfram',
    validate: async () => {
      const appId = process.env.WOLFRAM_APP_ID;
      if (!appId) return { valid: false, error: 'no key' };
      try {
        const res = await fetch(`https://api.wolframalpha.com/v2/query?input=test&appid=${appId}&format=plaintext&output=json`, {
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        if (data.error) return { valid: false, error: data.error.msg || 'API error' };
        return { valid: true };
      } catch (e: any) {
        return { valid: false, error: e.message };
      }
    },
  },
  {
    envVar: 'MATHPIX_APP_ID',
    envVar2: 'MATHPIX_APP_KEY',
    service: 'Mathpix',
    id: 'mathpix',
    validate: async () => {
      const appId = process.env.MATHPIX_APP_ID;
      const appKey = process.env.MATHPIX_APP_KEY;
      if (!appId || !appKey) return { valid: false, error: 'no key' };
      // Mathpix has no lightweight test endpoint — just check key format
      if (appId.length < 10 || appKey.length < 10) return { valid: false, error: 'key too short' };
      return { valid: true };
    },
  },
  {
    envVar: 'NTFY_TOPIC',
    service: 'NTFY',
    id: 'ntfy',
    validate: async () => {
      const topic = process.env.NTFY_TOPIC;
      if (!topic) return { valid: false, error: 'no topic' };
      // NTFY topics are public — just check format
      if (topic.length < 3) return { valid: false, error: 'topic too short' };
      return { valid: true };
    },
  },
];

// ─── State ──────────────────────────────────────────────────────────────────

interface KeyHealthRecord {
  valid: boolean;
  lastChecked: number;
  error?: string;
}

let _keyHealth: Map<string, KeyHealthRecord> = new Map();
let _validationInterval: ReturnType<typeof setInterval> | null = null;

// ─── DB Persistence ─────────────────────────────────────────────────────────

function _saveHealthToDB(id: string, health: KeyHealthRecord): void {
  try {
    const db = _deps.database;
    if (db?.setCalibration) {
      db.setCalibration(`key_health_${id}`, JSON.stringify(health));
    }
  } catch { /* non-critical */ }
}

function _loadHealthFromDB(): void {
  try {
    const db = _deps.database;
    if (!db?.getCalibration) return;
    for (const entry of KEY_REGISTRY) {
      const saved = db.getCalibration(`key_health_${entry.id}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          _keyHealth.set(entry.id, parsed);
        } catch { /* skip corrupt entries */ }
      }
    }
  } catch { /* non-critical */ }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validateAllKeys(): Promise<void> {
  log(`Validating ${KEY_REGISTRY.length} API keys...`, 'INFO', 'api-key-vault');

  // Validate in sequence (not parallel) to avoid rate limits and memory pressure
  for (const entry of KEY_REGISTRY) {
    try {
      const result = await entry.validate();
      const previous = _keyHealth.get(entry.id);
      const health: KeyHealthRecord = {
        valid: result.valid,
        lastChecked: Date.now(),
        error: result.error,
      };

      _keyHealth.set(entry.id, health);
      _saveHealthToDB(entry.id, health);

      // Check for valid → invalid transition
      if (previous && previous.valid && !result.valid) {
        log(`API key gone bad: ${entry.service} (${entry.id}) — ${result.error}`, 'ERROR', 'api-key-vault');
        // Alert via contextual alerts
        try {
          const alerts = require('./services-ntfy-alerts');
          alerts.alertKeyGoneBad?.(entry.service, result.error || 'unknown').catch(() => {});
        } catch { /* non-critical */ }
      }

      const icon = result.valid ? 'OK' : 'FAIL';
      const detail = result.error ? ` (${result.error})` : '';
      log(`  [${icon}] ${entry.service}${detail}`, result.valid ? 'DEBUG' : 'WARN', 'api-key-vault');
    } catch (e: any) {
      log(`  [ERROR] ${entry.service}: ${e.message}`, 'WARN', 'api-key-vault');
    }
  }

  const validCount = Array.from(_keyHealth.values()).filter(h => h.valid).length;
  log(`Key validation complete: ${validCount}/${KEY_REGISTRY.length} valid`, 'INFO', 'api-key-vault');
}

async function validateSingleKey(id: string): Promise<KeyHealth | null> {
  const entry = KEY_REGISTRY.find(e => e.id === id);
  if (!entry) return null;

  try {
    const result = await entry.validate();
    const health: KeyHealthRecord = {
      valid: result.valid,
      lastChecked: Date.now(),
      error: result.error,
    };

    _keyHealth.set(entry.id, health);
    _saveHealthToDB(entry.id, health);
    return { valid: result.valid, lastChecked: new Date(health.lastChecked).toISOString(), error: result.error };
  } catch (e: any) {
    return { valid: false, lastChecked: new Date().toISOString(), error: e.message };
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

function getKeyHealthSummary(): Record<string, KeyHealth> | null {
  if (_keyHealth.size === 0) return null;
  const summary: Record<string, KeyHealth> = {};
  for (const entry of KEY_REGISTRY) {
    const health = _keyHealth.get(entry.id);
    if (health) {
      summary[entry.id] = {
        valid: health.valid,
        lastChecked: new Date(health.lastChecked).toISOString(),
        error: health.error,
      };
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function getKeyRegistry(): KeyEntry[] {
  return KEY_REGISTRY;
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

function start(validationIntervalMs: number = 6 * 60 * 60 * 1000): void {
  // Load cached health from DB first
  _loadHealthFromDB();

  // Run initial validation (with 30s delay to avoid startup contention)
  setTimeout(() => {
    validateAllKeys().catch(() => {});
  }, 30000);

  // Periodic re-validation
  if (_validationInterval) clearInterval(_validationInterval);
  _validationInterval = setInterval(() => {
    validateAllKeys().catch(() => {});
  }, validationInterval);

  log(`API key vault started (re-validate every ${validationIntervalMs / 3600000}h)`, 'INFO', 'api-key-vault');
}

function stop(): void {
  if (_validationInterval) {
    clearInterval(_validationInterval);
    _validationInterval = null;
  }
}

module.exports = {
  _injectDependencies,
  start,
  stop,
  validateAllKeys,
  validateSingleKey,
  getKeyHealthSummary,
  getKeyRegistry,
};
