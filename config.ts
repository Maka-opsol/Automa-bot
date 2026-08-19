'use strict';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ConfigMutationEntry {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: number;
  source: string;
}

interface KeyDerivationCacheEntry {
  key: Buffer;
  timestamp: number;
}

interface RemoteConfigStatus {
  applied: boolean;
  error: string | null;
}

interface OverrideSchemaItem {
  type: string;
  min?: number;
  max?: number;
  maxLength?: number;
  allowed?: string[];
  regex?: RegExp;
}

// ─── Requires ────────────────────────────────────────────────────────────────
//
// v5-fix: CIRCULAR DEPENDENCY GUARD
// This module MUST NOT require './logger' at any point (top-level or lazy).
// The cycle is: container-container → logger → config (lazy, safe).
// If config also required logger, it would become a hard circular crash.
// All logging from this module uses console.warn / console.log / console.error.
//
// v5-fix #2: config-remote-config is now LAZY-loaded inside applyRemoteOverridesAsync()
// instead of eagerly required here. The previous eager require created a fragile
// chain: config → config-remote-config → logger → config (lazy). While it
// didn't crash because logger's CONFIG() accessor is deferred, any future edit
// to config-remote-config.ts that added a top-level log call would create a
// hard circular crash. Lazy-loading eliminates this risk entirely.
//

// eslint-disable-next-line @typescript-eslint/no-require-imports
const envalid = require('envalid');
const { str, num, bool, json } = envalid;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('./project-root');

// ─── Crypto constants ────────────────────────────────────────────────────────

const ALGORITHM: string = 'aes-256-gcm';
const IV_LENGTH: number = 16;
const SALT_LENGTH: number = 32;
const TAG_LENGTH: number = 16;
const KEY_LENGTH: number = 32;
const PBKDF2_ITERATIONS: number = 100000;
const PBKDF2_DIGEST: string = 'sha256';
const MAX_ENCRYPTION_INPUT_BYTES: number = 1024 * 1024;
const keyDerivationCache: Map<string, KeyDerivationCacheEntry> = new Map();
const KEY_CACHE_MAX: number = 100;
const KEY_CACHE_TTL_MS: number = 5 * 60 * 1000;

// ─── Internal state ──────────────────────────────────────────────────────────

let _encryptionPassphrase: string | null = null;

// ─── Encryption helpers ──────────────────────────────────────────────────────

function getEncryptionPassphrase(): string {
  if (_encryptionPassphrase === null) {
    const raw: string | undefined = process.env.ENCRYPTION_PASSPHRASE;
    if (!raw) {
      // Only warn if credentials look encrypted (base64-encoded, >40 chars)
      const email: string = process.env.MICROSOFT_EMAIL || '';
      const password: string = process.env.MICROSOFT_PASSWORD || '';
      const looksEncrypted: boolean = (email.length > 100 || password.length > 100);
      if (looksEncrypted) {
        throw new Error(
          'ENCRYPTION_PASSPHRASE is required when credentials are encrypted. ' +
          'Set it to a strong passphrase (>= 16 characters). ' +
          'Without it, encrypted credentials cannot be decrypted.'
        );
      }
      _encryptionPassphrase = '';
    } else {
      if (raw.length < 16) {
        console.warn('ENCRYPTION_PASSPHRASE is set but shorter than 16 characters. Encryption will be weakened.');
      }
      _encryptionPassphrase = raw;
    }
  }
  return _encryptionPassphrase;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  const cacheKey: string = `${passphrase}:${salt.toString('hex')}`;
  const cached: KeyDerivationCacheEntry | undefined = keyDerivationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < KEY_CACHE_TTL_MS)) {
    return cached.key;
  }
  const key: Buffer = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  if (keyDerivationCache.size >= KEY_CACHE_MAX) {
    // OOM-safe: avoid spread on Map iterator (can fail under memory pressure)
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    try {
      for (const [k, v] of keyDerivationCache) {
        if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k; }
      }
    } catch { /* corrupted iterator — evict first key */ }
    if (oldestKey) keyDerivationCache.delete(oldestKey);
  }
  keyDerivationCache.set(cacheKey, { key, timestamp: Date.now() });
  return key;
}

function encrypt(text: string): string {
  if (typeof text !== 'string') throw new Error('encrypt() requires a string input');
  if (!_encryptionPassphrase) throw new Error('encrypt() requires ENCRYPTION_PASSPHRASE to be set');
  try {
    const passphrase: string = getEncryptionPassphrase();
    const salt: Buffer = crypto.randomBytes(SALT_LENGTH);
    const iv: Buffer = crypto.randomBytes(IV_LENGTH);
    const key: Buffer = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted: Buffer;
    try {
      encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    } catch (err: unknown) {
      throw new Error(`Encryption failed: ${(err as Error).message}`);
    }
    const tag: Buffer = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
  } catch (err: unknown) {
    throw new Error(`Encryption error: ${(err as Error).message}`);
  }
}

function decrypt(encryptedBase64: string): string {
  if (!encryptedBase64 || typeof encryptedBase64 !== 'string') {
    throw new Error('decrypt() requires a non-empty string input');
  }
  try {
    const passphrase: string = getEncryptionPassphrase();
    const base64Regex: RegExp = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(encryptedBase64)) throw new Error('Invalid base64 format');
    let buffer: Buffer;
    try {
      buffer = Buffer.from(encryptedBase64, 'base64');
    } catch (err: unknown) {
      throw new Error('Base64 decoding failed');
    }
    const minBufferSize: number = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
    if (buffer.length < minBufferSize) {
      throw new Error('Encrypted data too short - possibly corrupted');
    }
    let offset: number = 0;
    const salt: Buffer = buffer.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
    const iv: Buffer = buffer.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
    const tag: Buffer = buffer.subarray(offset, offset + TAG_LENGTH); offset += TAG_LENGTH;
    const encrypted: Buffer = buffer.subarray(offset);
    if (encrypted.length === 0) throw new Error('No encrypted payload found');
    const key: Buffer = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted: Buffer;
    try {
      decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (err: unknown) {
      const errMsg: string = (err as Error).message;
      if (errMsg.includes('authenticat') || errMsg.includes('Unsupported state')) {
        throw new Error('Authentication failed - wrong passphrase or corrupted data');
      }
      throw new Error(`Decryption failed: ${errMsg}`);
    }
    const result: string = decrypted.toString('utf8');
    if (result.includes('\ufffd')) {
      throw new Error('Decrypted data contains invalid UTF-8 sequences');
    }
    return result;
  } catch (err: unknown) {
    const errMsg: string = (err as Error).message;
    if (errMsg.includes('Authentication failed') ||
        errMsg.includes('too short') ||
        errMsg.includes('base64') ||
        errMsg.includes('UTF-8')) {
      throw err;
    }
    throw new Error(`Decryption error: ${errMsg}`);
  }
}

// ─── Credential handling ─────────────────────────────────────────────────────

let _decryptedEmail: string | null = null;
let _decryptedPassword: string | null = null;
let _credentialValidationFailed: boolean = false;

function validateEmail(email: unknown): email is string {
  if (!email || typeof email !== 'string') return false;
  const emailRegex: RegExp = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

function validatePassword(password: unknown): password is string {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 4 && !/[\x00-\x1F\x7F]/.test(password);
}

function getMicrosoftEmail(): string {
  if (_credentialValidationFailed) throw new Error('Credentials previously failed validation');
  if (_decryptedEmail === null) {
    const raw: string = process.env.MICROSOFT_EMAIL || '';
    if (!raw) { _credentialValidationFailed = true; throw new Error('MICROSOFT_EMAIL environment variable is empty'); }
    // Try decryption first (for encrypted values), fall back to plain text
    try { _decryptedEmail = decrypt(raw); } catch (err: unknown) {
      // Decryption failed - treat as plain text
      _decryptedEmail = raw;
    }
    if (!validateEmail(_decryptedEmail)) { _decryptedEmail = null; _credentialValidationFailed = true; throw new Error(`MICROSOFT_EMAIL is invalid (expected a valid email address)`); }
  }
  return _decryptedEmail;
}

function getMicrosoftPassword(): string {
  if (_credentialValidationFailed) throw new Error('Credentials previously failed validation');
  if (_decryptedPassword === null) {
    const raw: string = process.env.MICROSOFT_PASSWORD || '';
    if (!raw) { _credentialValidationFailed = true; throw new Error('MICROSOFT_PASSWORD environment variable is empty'); }
    // Try decryption first (for encrypted values), fall back to plain text
    try { _decryptedPassword = decrypt(raw); } catch (err: unknown) {
      // Decryption failed - treat as plain text
      _decryptedPassword = raw;
    }
    if (!validatePassword(_decryptedPassword)) { _decryptedPassword = null; _credentialValidationFailed = true; throw new Error('MICROSOFT_PASSWORD failed validation (min 4 chars, no control characters)'); }
  }
  return _decryptedPassword;
}

// ─── Path / URL sanitizers ───────────────────────────────────────────────────

function safeMkdir(dirPath: string, description: string = 'directory'): string {
  try {
    if (!dirPath || typeof dirPath !== 'string') throw new Error(`Invalid ${description} path`);
    const normalized: string = path.normalize(dirPath);
    if (normalized.includes('..')) throw new Error(`Path traversal detected in ${description}: ${dirPath}`);
    if (!fs.existsSync(normalized)) fs.mkdirSync(normalized, { recursive: true, mode: 0o750 });
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${normalized}`);
    return normalized;
  } catch (err: unknown) {
    throw new Error(`Failed to create ${description} at ${dirPath}: ${(err as Error).message}`);
  }
}

function sanitizePathString(str: unknown): string {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function sanitizeUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch { return ''; }
}

// ─── Remote override validation ──────────────────────────────────────────────

function isValidRemoteOverride(key: string, value: unknown): boolean {
  const BLOCKED_KEYS: Set<string> = new Set([
    'DB_PATH', 'AUTH_STATE_PATH', 'USER_DATA_DIR', 'LOG_DIR',
    'SLACK_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
    'MISTRAL_CODE_API_KEY', 'QWEN_CODE_API_KEY', 'DEEPSEEK_CODE_API_KEY',
    'BAZAARLINK_API_KEY',
    'OPENROUTER_API_KEY', 'GITHUB_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
    'CF_API_KEY', 'CF_ACCOUNT_ID', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
    'CAPTCHA_API_KEY', 'BRAIN_API_KEY', 'REMOTE_BRAIN_URL',
    'STATUS_PORT', 'ENABLE_STATUS_SERVER', 'CHROMIUM_EXECUTABLE_PATH', 'RUNTIME_MANIFEST_URL',
    // Security-critical flags that must not be overridden remotely
    'AUDITOR_ENABLED', 'SELF_HEAL_ENABLED', 'SELF_HEAL_ALLOW_ALL', 'SANDBOX_MODE',
    'ADMIN_SECRET', 'POLICY_ENFORCED', 'SELF_DEPLOY_ENABLED',
    'HEALER_SELF_TEST_ENABLED', 'ADVERSARIAL_TESTER_ENABLED', 'CRITICAL_SHADOW_MODE_ENABLED',
    'EXECUTIVE_KEY',
  ]);
  if (BLOCKED_KEYS.has(key)) return false;
  const schema: Record<string, OverrideSchemaItem> = {
    RETRY_ATTEMPTS: { type: 'number', min: 1, max: 10 },
    POST_CLICK_MS: { type: 'number', min: 1000, max: 60000 },
    BETWEEN_STEPS_MS: { type: 'number', min: 5000, max: 120000 },
    SCROLL_AMOUNT: { type: 'number', min: 100, max: 2000 },
    VIDEO_SPEED: { type: 'number', min: 1, max: 32 },
    MAX_QUESTIONS: { type: 'number', min: 1, max: 999999 },
    SLEEP_MIN_HOURS: { type: 'number', min: 0.5, max: 48 },
    SLEEP_MAX_HOURS: { type: 'number', min: 0.5, max: 48 },
    HEADLESS: { type: 'boolean' },
    SAVE_SCREENSHOTS: { type: 'boolean' },
    ENABLE_IP_CHECK: { type: 'boolean' },
    LOG_LEVEL: { type: 'string', maxLength: 10, allowed: ['debug', 'info', 'warn', 'error', 'fatal'] },
    EXPECTED_IP_CITY: { type: 'string', maxLength: 100, regex: /^[a-zA-Z\s\-']+$/ },
    EXPECTED_IP_COUNTRY: { type: 'string', maxLength: 100, regex: /^[a-zA-Z\s\-']+$/ },
    AUTO_INSTALL_DEPENDENCIES: { type: 'boolean' },
    // SANDBOX_MODE intentionally omitted from schema — it is in BLOCKED_KEYS
    WEB_SEARCH_ENABLED: { type: 'boolean' },
    RAW_RESPONSE_TTL_MS: { type: 'number', min: 5000, max: 300000 },
  };
  const schemaItem: OverrideSchemaItem | undefined = schema[key];
  if (!schemaItem) return false;
  if (schemaItem.type === 'number' && (typeof value !== 'number' || isNaN(value as number))) return false;
  if (schemaItem.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schemaItem.type === 'string' && typeof value !== 'string') return false;
  if (schemaItem.min !== undefined && (value as number) < schemaItem.min) return false;
  if (schemaItem.max !== undefined && (value as number) > schemaItem.max) return false;
  if (schemaItem.maxLength !== undefined && String(value).length > schemaItem.maxLength) return false;
  if (schemaItem.allowed && !schemaItem.allowed.includes((value as string).toLowerCase())) return false;
  if (schemaItem.regex && !schemaItem.regex.test(value as string)) return false;
  if (schemaItem.type === 'number' && (!isFinite(value as number))) return false;
  return true;
}

// ─── Remote override application ─────────────────────────────────────────────

let _remoteOverridesApplied: boolean = false;
let _remoteOverridePromise: Promise<void> | null = null;
async function applyRemoteOverridesAsync(): Promise<void> {
  if (_remoteOverridesApplied) return;
  try {
    // v5-fix: Lazy-require config-remote-config here (not at module top-level)
    // to eliminate the fragile circular dependency chain:
    //   config → config-remote-config → logger → config (lazy)
    const remoteConfigMod = require('./config-remote-config');
    await remoteConfigMod.loadRemoteConfig();
    const overrides = remoteConfigMod.getRemoteOverrides();
    if (!overrides || typeof overrides !== 'object') { console.warn('Remote config returned invalid overrides'); return; }
    for (const [key, value] of Object.entries(overrides)) {
      if ((key in _configStore) && isValidRemoteOverride(key, value)) {
        // v5-fix: Write directly to _configStore — no defineProperty hack needed
        const oldValue = _configStore[key];
        _configStore[key] = value;
        const entry: ConfigMutationEntry = { key, oldValue, newValue: value, timestamp: Date.now(), source: 'remote' };
        _configMutationLog.push(entry);
        console.log(`[CONFIG] Remote override applied: ${key}`);
      } else if (key in _configStore) {
        console.warn(`[CONFIG] Remote override rejected for: ${key}`);
      }
    }
    _remoteOverridesApplied = true;
  } catch (err: unknown) {
    console.warn(`Remote config loading failed (using defaults): ${(err as Error).message}`);
    _remoteOverridesApplied = true;
  }
}

// ─── Environment validation (envalid) ────────────────────────────────────────

// HF Spaces detection — used to adjust defaults for 16GB container
const IS_HF_SPACE = !!(process.env.HF_SPACE || process.env.SPACE_ID || process.env.SPACE_AUTHOR_NAME);

const env = envalid.cleanEnv(process.env, {
  ENCRYPTION_PASSPHRASE: str({ default: '' }),
  MICROSOFT_EMAIL: str({ default: '' }),
  MICROSOFT_PASSWORD: str({ default: '' }),
  APP_URL: str({ default: 'https://app.mathu.co.za/' }),
  LOG_DIR: str({ default: path.join(PROJECT_ROOT, 'logs') }),
  AUTH_STATE_PATH: str({ default: path.join(PROJECT_ROOT, 'state.json') }),
  HEADLESS: bool({ default: true }),
  CHROMIUM_EXECUTABLE_PATH: str({ default: '' }),
  USER_DATA_DIR: str({ default: path.join(PROJECT_ROOT, '.browser-data') }),
  HTTP_PROXY: str({ default: '' }),
  HTTPS_PROXY: str({ default: '' }),
  NO_PROXY: str({ default: '' }),
  SAVE_SCREENSHOTS: bool({ default: false }),
  SCREENSHOT_DIR: str({ default: path.join(PROJECT_ROOT, 'logs', 'screenshots') }),
  MAX_SCREENSHOTS: num({ default: 10 }),
  POST_CLICK_MS: num({ default: 20000 }),
  BETWEEN_STEPS_MS: num({ default: 25000 }),
  SCROLL_PAUSE_MS: num({ default: 20000 }),
  SCROLL_AMOUNT: num({ default: 800 }),
  VIDEO_SPEED: num({ default: 16 }),
  VIDEO_TIMEOUT_MS: num({ default: 90000 }),
  // 5.3 FIX: Browser timeout values — were hardcoded in browser.ts
  BROWSER_LAUNCH_TIMEOUT_MS: num({ default: 60000 }),
  BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS: num({ default: 120000 }),
  BROWSER_CONTEXT_TIMEOUT_MS: num({ default: 30000 }),
  BROWSER_PAGE_TIMEOUT_MS: num({ default: 30000 }),
  BROWSER_CLOSE_TIMEOUT_MS: num({ default: 5000 }),
  HUMAN_MOUSE_JITTER_PX: num({ default: 3 }),
  HUMAN_MOUSE_STEPS: num({ default: 5 }),
  MAX_QUESTIONS: num({ default: 999999 }),
  MAX_CONSECUTIVE_SAME_ACTION: num({ default: 5 }),
  SCROLL_NO_CHANGE_THRESHOLD: num({ default: 2 }),
  AUTH_TIMEOUT_MS: num({ default: 450000 }),
  MAX_AUTH_ATTEMPTS: num({ default: 30 }),
  CAPTCHA_MAX_ATTEMPTS: num({ default: 3 }),
  PROGRESS_TIMEOUT_MS: num({ default: 30 * 60 * 1000 }),
  PROGRESS_SLOW_TIMEOUT_MS: num({ default: 60 * 60 * 1000 }),
  MAX_RUNTIME_PER_CYCLE_MS: num({ default: 2 * 60 * 60 * 1000 }),
  CHECK_INTERVAL_HOURS: num({ default: 12 }),
  MAX_BACKOFF_MULTIPLIER: num({ default: 16 }),
  // HF Spaces: 16GB RAM available — use generous defaults.
  // Render free plan: 512MB total — use tight defaults.
  MAX_MEMORY_MB: num({ default: IS_HF_SPACE ? 4096 : 448 }),
  ENABLE_GC_ON_CYCLE: bool({ default: true }),
  MAX_CYCLES_BEFORE_RESTART: num({ default: IS_HF_SPACE ? 500 : 100 }),
  MEMORY_WARNING_THRESHOLD_MB: num({ default: IS_HF_SPACE ? 3072 : 350 }),
  MEMORY_RESTART_THRESHOLD_MB: num({ default: IS_HF_SPACE ? 3584 : 360 }),
  MAX_UPTIME_HOURS: num({ default: IS_HF_SPACE ? 168 : 24 }),
  STATE_HISTORY_MAX: num({ default: 100 }),
  STATUS_PORT: num({ default: 8080 }),
  ENABLE_STATUS_SERVER: bool({ default: true }),
  REPLIT_VM: bool({ default: false }),
  UPDATER_ENABLED: bool({ default: true }),
  UPDATER_INTERVAL_HOURS: num({ default: 168 }),
  UPDATER_TIMEOUT_MS: num({ default: 120000 }),
  ENABLE_UI_PROMPT_UPDATER: bool({ default: true }),
  UI_PROMPT_UPDATE_INTERVAL_DAYS: num({ default: 30 }),
  SLACK_WEBHOOK_URL: str({ default: '' }),
  TELEGRAM_BOT_TOKEN: str({ default: '' }),
  TELEGRAM_CHAT_ID: str({ default: '' }),
  ALERT_ON_ERROR: bool({ default: true }),
  ALERT_ON_STAGNATION: bool({ default: true }),
  ALERT_ON_AUTH_FAILURE: bool({ default: true }),
  CAPTCHA_SERVICE: str({ default: 'none' }),
  CAPTCHA_API_KEY: str({ default: '' }),
  CAPTCHA_QUEUE_MAX: num({ default: 5 }),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: num({ default: 5 }),
  CIRCUIT_BREAKER_TIMEOUT_MS: num({ default: 600000 }),
  PROGRESS_LOG_PATH: str({ default: path.join(PROJECT_ROOT, 'logs', 'progress.jsonl') }),
  LAST_STATE_PATH: str({ default: path.join(PROJECT_ROOT, 'last-state.json') }),
  LOG_MAX_SIZE_MB: num({ default: 50 }),
  LOG_MAX_FILES: num({ default: 5 }),
  RAW_RESPONSE_TTL_MS: num({ default: 30000 }),
  LOG_ROTATE_INTERVAL: str({ default: '1d' }),
  SLEEP_MIN_HOURS: num({ default: 10 }),
  SLEEP_MAX_HOURS: num({ default: 16 }),
  STARTUP_DELAY_MIN_MINUTES: num({ default: 15 }),
  STARTUP_DELAY_MAX_MINUTES: num({ default: 45 }),
  WARMUP_PROBABILITY: num({ default: 0.3 }),
  ALLOWED_ACTIVITY_START_HOUR: num({ default: 7 }),
  ALLOWED_ACTIVITY_END_HOUR: num({ default: 22 }),
  ENABLE_IP_CHECK: bool({ default: true }),
  EXPECTED_IP_CITY: str({ default: 'Johannesburg' }),
  EXPECTED_IP_COUNTRY: str({ default: 'South Africa' }),
  DB_PATH: str({ default: path.join(PROJECT_ROOT, 'mathu-bot.db') }),
  TEMPLATE_CACHE_ENABLED: bool({ default: true }),
  TEMPLATE_MATCH_THRESHOLD: num({ default: 0.85 }),
  SELF_HEAL_ENABLED: bool({ default: true }),
  SELF_HEAL_FAILURE_THRESHOLD: num({ default: 5 }),
  SELF_HEAL_MAX_ATTEMPTS: num({ default: 3 }),
  SELF_HEAL_DEBUG_ATTEMPTS: num({ default: 3 }),
  SELF_HEAL_BACKUP_DIR: str({ default: path.join(PROJECT_ROOT, 'backups') }),
  SELF_HEAL_MAX_BACKUPS: num({ default: 5 }),
  SELF_HEAL_TEST_DEPTH: num({ default: 5 }),
  SELF_HEAL_MANUAL_OVERRIDE: str({ default: '' }),
  STATE_TIMEOUT_MS: num({ default: 300000 }),
  SELF_HEAL_STAGING_DIR: str({ default: path.join(PROJECT_ROOT, 'staging') }),
  PATCH_HISTORY_MAX: num({ default: 20 }),
  HEARTBEAT_FILE: str({ default: path.join(PROJECT_ROOT, '.heartbeat') }),
  HEARTBEAT_INTERVAL_MS: num({ default: 60000 }),
  CHECKPOINT_FILE: str({ default: path.join(PROJECT_ROOT, 'checkpoint.json') }),
  OCR_FALLBACK_ENABLED: bool({ default: true }),
  PROVIDER_HEALTH_CHECK_INTERVAL_MS: num({ default: 3600000 }),
  MISTRAL_CODE_API_KEY: str({ default: '' }),
  QWEN_CODE_API_KEY: str({ default: '' }),
  DEEPSEEK_CODE_API_KEY: str({ default: '' }),
  BAZAARLINK_API_KEY: str({ default: '' }),
  OPENROUTER_API_KEY: str({ default: '' }),
  CODE_GEN_MODEL_MISTRAL: str({ default: 'codestral-latest' }),
  CODE_GEN_MODEL_QWEN: str({ default: 'qwen-coder-plus' }),
  CODE_GEN_MODEL_DEEPSEEK: str({ default: 'deepseek-coder' }),
  CODE_GEN_MODEL_OPENROUTER: str({ default: 'openrouter/free' }),
  CODE_GEN_MODEL_BAZAARLINK: str({ default: 'auto:free' }),
  CODE_GEN_PROVIDERS: json({ default: [{ name: 'mistral', envKey: 'MISTRAL_CODE_API_KEY', endpoint: 'https://api.mistral.ai/v1' }, { name: 'bazaarlink', envKey: 'BAZAARLINK_API_KEY', endpoint: 'https://api.bazaarlink.ai/v1' }, { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/v1' }] }),
  CODE_GEN_FALLBACK_MODELS: json({ default: { mistral: 'codestral-latest', bazaarlink: 'auto:free', openrouter: 'openrouter/free' } }),
  CODE_GEN_CONSENSUS_THRESHOLD: num({ default: 5 }),
  AUTO_INSTALL_DEPENDENCIES: bool({ default: false }),
  SANDBOX_MODE: bool({ default: false }),
  WEB_SEARCH_ENABLED: bool({ default: true }),
  GITHUB_API_KEY: str({ default: '' }),
  GROQ_API_KEY: str({ default: '' }),
  ZAI_API_KEY: str({ default: '' }),
  AGNES_API_KEY: str({ default: '' }),
  NVIDIA_API_KEY: str({ default: '' }),
  CF_API_KEY: str({ default: '' }),
  CF_ACCOUNT_ID: str({ default: '' }),
  CEREBRAS_API_KEY: str({ default: '' }),
  GEMINI_API_KEY: str({ default: '' }),
  EVOLUTION_INTERVAL_DAYS: num({ default: 30 }),
  GITOPS_ENABLED: bool({ default: true }),
  GITOPS_ROLLBACK_DEPTH: num({ default: 10 }),
  PROVIDER_BUDGET_OPENROUTER: num({ default: 0.5 }),
  PROVIDER_BUDGET_MISTRAL: num({ default: 0.2 }),
  PROVIDER_BUDGET_GITHUB: num({ default: 0.1 }),
  BARGAIN_HUNTER_INTERVAL_HOURS: num({ default: 6 }),
  CAPTCHA_HUMAN_TIMEOUT_MS: num({ default: 300000 }),
  UI_DRIFT_THRESHOLD: num({ default: 10 }),
  BRUTE_FORCE_MAX_TRIES: num({ default: 50 }),
  AUTO_FIX_DEPENDENCIES: bool({ default: true }),
  FORCE_NODE_VERSION: str({ default: 'v20.11.0' }),
  ENABLE_FLUTTER_SEMANTICS: bool({ default: true }),
  ENABLE_NETWORK_INTERCEPT: bool({ default: true }),
  ENABLE_CANVAS_OCR: bool({ default: true }),
  FLUTTER_DPR_AUTO_CALIBRATE: bool({ default: true }),
  NETWORK_REPLAY_ON_CLICK_FAIL: bool({ default: true }),
  SWIPE_DURATION_MS: num({ default: 800 }),
  LONG_PRESS_DELAY_MS: num({ default: 600 }),
  REMOTE_BRAIN_URL: str({ default: '' }),
  BRAIN_API_KEY: str({ default: '' }),
  ENABLE_BLACKBOX: bool({ default: true }),
  BLACKBOX_MAX_ENTRIES: num({ default: 50 }),
  // M1 FIX: BLACKBOX_REPLAY_ENABLED was referenced in container-subsystem-runner.ts
  // flagMap but was missing from envalid + CONFIG — caused silent skip at startup.
  BLACKBOX_REPLAY_ENABLED: bool({ default: true }),
  ENABLE_ADAPTIVE_PERFORMANCE: bool({ default: true }),
  PERFORMANCE_BASELINE_MS: num({ default: 500 }),
  ENABLE_PROTOCOL_CHAMELEON: bool({ default: true }),
  PROTOCOL_CHAMELEON_SCHEMA_URLS: json({ default: { openrouter: 'https://openrouter.ai/api/v1/openapi.json', mistral: 'https://api.mistral.ai/v1/openapi.json', groq: 'https://api.groq.com/openai/v1/openapi.json' } }),
  ENABLE_GAN_TELEMETRY: bool({ default: false }),
  GAN_MODEL_PATH: str({ default: './models/mouse-gan.onnx' }),
  ENABLE_EXPLORATION_PASS: bool({ default: true }),
  EXPLORATION_CONSECUTIVE_FAILURES: num({ default: 3 }),
  ENABLE_LOCAL_VLM: bool({ default: false }),
  LOCAL_VLM_MODEL: str({ default: 'onnx-community/Phi-3.5-vision-instruct-ONNX' }),
  ENABLE_PUZZLE_SANDBOX: bool({ default: false }),
  ENABLE_RUNTIME_GUARDIAN: bool({ default: true }),
  RUNTIME_MANIFEST_URL: str({ default: 'https://example.com/runtime-manifest.json' }),
  SELF_HEAL_ALLOW_ALL: str({ default: '' }),
  ADMIN_ALLOWED_IPS: str({ default: '' }),
  NTFY_TOPIC: str({ default: '' }),
  SMTP_HOST: str({ default: '' }),
  SMTP_PORT: str({ default: '587' }),
  SMTP_USER: str({ default: '' }),
  SMTP_PASS: str({ default: '' }),
  SMTP_FROM: str({ default: '' }),
  ALERT_EMAIL_TO: str({ default: '' }),
  SMTP_SECURE: bool({ default: false }),
  POLICY_ENFORCED: bool({ default: true }),
  POLICY_BLOCKED_DOMAINS: str({ default: '' }),
  DASHBOARD_PORT: num({ default: 8080 }),
  WAIT_MULTIPLIER: num({ default: 1.0 }),
  VISION_PRIORITY: str({ default: 'cloud' }),
  PROVIDER_ORDER: str({ default: '' }),
  PREDICTIVE_HEAL_ENABLED: bool({ default: true }),
  PREDICTIVE_HEAL_LATENCY_SPIKE_THRESHOLD: num({ default: 2.0 }),
  PREDICTIVE_HEAL_CLICK_DROP_THRESHOLD: num({ default: 0.3 }),
  SELECTOR_DRIFT_HEAL_ENABLED: bool({ default: true }),
  REGRESSION_BANK_ENABLED: bool({ default: true }),
  REGRESSION_BANK_DIR: str({ default: path.join(PROJECT_ROOT, 'test', 'regression', 'generated') }),
  CANARY_ROLLOUT_ENABLED: bool({ default: true }),
  CANARY_OBSERVATION_HOURS: num({ default: 6 }),
  CANARY_ERROR_RATE_MULTIPLIER: num({ default: 2.0 }),
  DIFF_MINIMIZER_ENABLED: bool({ default: true }),
  ADVERSARIAL_TESTER_ENABLED: bool({ default: true }),
  CRITICAL_SHADOW_MODE_ENABLED: bool({ default: true }),
  PROMPT_EVOLUTION_ENABLED: bool({ default: true }),
  PROMPT_EVOLUTION_MIN_ENTRIES: num({ default: 100 }),
  DB_HEALER_ENABLED: bool({ default: true }),
  DB_HEALER_QUARANTINE_MAX_AGE_DAYS: num({ default: 30 }),
  AUTH_HEALER_ENABLED: bool({ default: true }),
  AUTH_HEALER_MAX_FAILURES: num({ default: 3 }),
  STATE_RECOVERY_ENABLED: bool({ default: true }),
  STATE_RECOVERY_PROMOTE_AFTER: num({ default: 3 }),
  STATE_RECOVERY_TTL_DAYS: num({ default: 7 }),
  DEPENDENCY_HEALER_ENABLED: bool({ default: true }),
  CONFIG_RECONCILER_ENABLED: bool({ default: true }),
  EXTENDED_CHECKPOINT_ENABLED: bool({ default: true }),
  BLACKBOX_FULL_ENABLED: bool({ default: true }),
  BLACKBOX_FULL_MAX_ENTRIES: num({ default: 20 }),
  PATCH_MEMORY_ENABLED: bool({ default: true }),
  PATCH_MEMORY_TOP_K: num({ default: 5 }),
  HEAL_REWARD_TRACKER_ENABLED: bool({ default: true }),
  SELF_HEAL_TIMELINE_ENABLED: bool({ default: true }),
  HEALER_SELF_TEST_ENABLED: bool({ default: true }),
  HEALER_SELF_TEST_INTERVAL_HOURS: num({ default: 168 }),
  HEALER_CIRCUIT_BREAKER_ENABLED: bool({ default: true }),
  HEALER_CB_FAILURE_RATE: num({ default: 0.7 }),
  HEALER_CB_SLIDING_WINDOW: num({ default: 10 }),
  SUBSYSTEM_CB_MESH_ENABLED: bool({ default: true }),
  CLEAN_ROOM_TEST_ENABLED: bool({ default: true }),
  CLEAN_ROOM_TEST_INTERVAL_HOURS: num({ default: 168 }),
  DEGRADATION_LADDER_ENABLED: bool({ default: true }),
  SELF_DEPLOY_ENABLED: bool({ default: false }),
  EXECUTIVE_KEY: str({ default: '' }),
  // ACCEPT_ANY_FIX removed from config — now session-only in-memory flag
  // in self-heal.ts. Resets to false on every restart. Opt-in via dashboard.
  // Critical patch consensus safety timeouts
  CRITICAL_CONSENSUS_COOLING_OFF_MS: num({ default: 5 * 60 * 1000 }),
  CRITICAL_CONSENSUS_VERIFY_WINDOW_MS: num({ default: 10 * 60 * 1000 }),
  // Cloudinary screenshot storage
  CLOUDINARY_CLOUD_NAME: str({ default: 'xlhumi67' }),
  CLOUDINARY_API_KEY: str({ default: '' }),
  CLOUDINARY_API_SECRET: str({ default: '' }),
  CLOUDINARY_FOLDER: str({ default: 'mathu-bot/screenshots' }),
  SCREENSHOT_STORAGE_ENABLED: bool({ default: true }),
  // Pixel self-training
  PIXEL_TRAINING_ENABLED: bool({ default: true }),
  PIXEL_TRAINING_MAX_CACHE: num({ default: 200 }),
  PIXEL_TRAINING_SIMILARITY_THRESHOLD: num({ default: 0.3 }),
  PIXEL_TRAINING_MAX_RESULTS: num({ default: 5 }),
}, { strict: false, reporter: (errors: any) => { if (Object.keys(errors).length > 0) { console.warn('Environment validation warnings:', Object.values(errors as any)); } } });

// ─── CONFIG object ───────────────────────────────────────────────────────────

const _configStore: Record<string, any> = {
  DEGRADED_MODE: false,
  // HF Spaces: exposed so all modules can detect the environment
  HF_SPACE: IS_HF_SPACE,
  APP_URL: sanitizeUrl(env.APP_URL) || 'https://app.mathu.co.za/',
  // v5-fix: safeMkdir can throw during module evaluation if LOG_DIR is unwritable
  // (e.g. permission denied, invalid path). Previously this crashed config.ts
  // with no clear message. Now falls back to ./logs with a warning.
  LOG_DIR: (() => { try { return safeMkdir(sanitizePathString(env.LOG_DIR), 'LOG_DIR'); } catch (mkdirErr: unknown) {
    console.warn(`\u26A0\uFE0F LOG_DIR creation failed (${(mkdirErr as Error).message}), falling back to os.tmpdir()`);
    try { return safeMkdir(path.join(require('os').tmpdir(), 'mathu-logs'), 'LOG_DIR (fallback)'); } catch { return path.join(require('os').tmpdir(), 'mathu-logs'); }
  } })(),
  AUTH_STATE_PATH: (env.AUTH_STATE_PATH || '').replace(/[^a-zA-Z0-9_\-\/\.]/g, ''),
  HEADLESS: env.HEADLESS,
  CHROMIUM_EXECUTABLE_PATH: env.CHROMIUM_EXECUTABLE_PATH || null,
  USER_DATA_DIR: (env.USER_DATA_DIR || '').replace(/[^a-zA-Z0-9_\-\/\.]/g, ''),
  HTTP_PROXY: env.HTTP_PROXY || null,
  HTTPS_PROXY: env.HTTPS_PROXY || null,
  NO_PROXY: env.NO_PROXY || null,
  DISPLAY_WIDTH: 1280,
  DISPLAY_HEIGHT: 800,
  COORDINATE_TOLERANCE_PX: 50,
  MAX_TOKENS: 256,
  TEMPERATURE: 0.0,
  RETRY_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 2000,
  TRIBUNAL_TIMEOUT_MS: 120000,
  REQUEST_TIMEOUT_MS: 120000,
  RATE_LIMIT_DELAY_MS: 10000,
  SCREENSHOT_CACHE_TTL_MS: 5000,
  SAVE_SCREENSHOTS: env.SAVE_SCREENSHOTS,
  SCREENSHOT_DIR: env.SCREENSHOT_DIR,
  MAX_SCREENSHOTS: env.MAX_SCREENSHOTS,
  POST_CLICK_MS: env.POST_CLICK_MS,
  BETWEEN_STEPS_MS: env.BETWEEN_STEPS_MS,
  SCROLL_PAUSE_MS: env.SCROLL_PAUSE_MS,
  SCROLL_AMOUNT: env.SCROLL_AMOUNT,
  VIDEO_SPEED: env.VIDEO_SPEED,
  VIDEO_TIMEOUT_MS: env.VIDEO_TIMEOUT_MS,
  BROWSER_LAUNCH_TIMEOUT_MS: env.BROWSER_LAUNCH_TIMEOUT_MS,
  BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS: env.BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS,
  BROWSER_CONTEXT_TIMEOUT_MS: env.BROWSER_CONTEXT_TIMEOUT_MS,
  BROWSER_PAGE_TIMEOUT_MS: env.BROWSER_PAGE_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS: env.BROWSER_CLOSE_TIMEOUT_MS,
  HUMAN_MOUSE_JITTER_PX: env.HUMAN_MOUSE_JITTER_PX,
  HUMAN_MOUSE_STEPS: env.HUMAN_MOUSE_STEPS,
  MAX_QUESTIONS: env.MAX_QUESTIONS,
  MAX_CONSECUTIVE_SAME_ACTION: env.MAX_CONSECUTIVE_SAME_ACTION,
  SCROLL_NO_CHANGE_THRESHOLD: env.SCROLL_NO_CHANGE_THRESHOLD,
  AUTH_TIMEOUT_MS: env.AUTH_TIMEOUT_MS,
  MAX_AUTH_ATTEMPTS: env.MAX_AUTH_ATTEMPTS,
  CAPTCHA_MAX_ATTEMPTS: env.CAPTCHA_MAX_ATTEMPTS,
  PROGRESS_TIMEOUT_MS: env.PROGRESS_TIMEOUT_MS,
  PROGRESS_SLOW_TIMEOUT_MS: env.PROGRESS_SLOW_TIMEOUT_MS,
  MAX_RUNTIME_PER_CYCLE_MS: env.MAX_RUNTIME_PER_CYCLE_MS,
  CHECK_INTERVAL_HOURS: env.CHECK_INTERVAL_HOURS,
  MAX_BACKOFF_MULTIPLIER: env.MAX_BACKOFF_MULTIPLIER,
  MAX_MEMORY_MB: env.MAX_MEMORY_MB,
  ENABLE_GC_ON_CYCLE: env.ENABLE_GC_ON_CYCLE,
  MAX_CYCLES_BEFORE_RESTART: env.MAX_CYCLES_BEFORE_RESTART,
  MEMORY_WARNING_THRESHOLD_MB: env.MEMORY_WARNING_THRESHOLD_MB,
  MEMORY_RESTART_THRESHOLD_MB: env.MEMORY_RESTART_THRESHOLD_MB,
  MAX_UPTIME_HOURS: env.MAX_UPTIME_HOURS,
  STATE_HISTORY_MAX: env.STATE_HISTORY_MAX,
  STATUS_PORT: env.STATUS_PORT,
  ENABLE_STATUS_SERVER: env.ENABLE_STATUS_SERVER,
  REPLIT_VM: env.REPLIT_VM,
  UPDATER_ENABLED: env.UPDATER_ENABLED,
  UPDATER_INTERVAL_HOURS: env.UPDATER_INTERVAL_HOURS,
  UPDATER_TIMEOUT_MS: env.UPDATER_TIMEOUT_MS,
  ENABLE_UI_PROMPT_UPDATER: env.ENABLE_UI_PROMPT_UPDATER,
  UI_PROMPT_UPDATE_INTERVAL_DAYS: env.UI_PROMPT_UPDATE_INTERVAL_DAYS,
  SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL || null,
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || null,
  ALERT_ON_ERROR: env.ALERT_ON_ERROR,
  ALERT_ON_STAGNATION: env.ALERT_ON_STAGNATION,
  ALERT_ON_AUTH_FAILURE: env.ALERT_ON_AUTH_FAILURE,
  CAPTCHA_SERVICE: env.CAPTCHA_SERVICE,
  CAPTCHA_API_KEY: env.CAPTCHA_API_KEY || null,
  CAPTCHA_QUEUE_MAX: env.CAPTCHA_QUEUE_MAX,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_TIMEOUT_MS: env.CIRCUIT_BREAKER_TIMEOUT_MS,
  PROGRESS_LOG_PATH: env.PROGRESS_LOG_PATH,
  LAST_STATE_PATH: env.LAST_STATE_PATH,
  LOG_MAX_SIZE_MB: env.LOG_MAX_SIZE_MB,
  LOG_MAX_FILES: env.LOG_MAX_FILES,
  RAW_RESPONSE_TTL_MS: env.RAW_RESPONSE_TTL_MS,
  LOG_ROTATE_INTERVAL: env.LOG_ROTATE_INTERVAL,
  SLEEP_MIN_HOURS: env.SLEEP_MIN_HOURS,
  SLEEP_MAX_HOURS: env.SLEEP_MAX_HOURS,
  STARTUP_DELAY_MIN_MINUTES: env.STARTUP_DELAY_MIN_MINUTES,
  STARTUP_DELAY_MAX_MINUTES: env.STARTUP_DELAY_MAX_MINUTES,
  WARMUP_PROBABILITY: env.WARMUP_PROBABILITY,
  ALLOWED_ACTIVITY_START_HOUR: env.ALLOWED_ACTIVITY_START_HOUR,
  ALLOWED_ACTIVITY_END_HOUR: env.ALLOWED_ACTIVITY_END_HOUR,
  ENABLE_IP_CHECK: env.ENABLE_IP_CHECK,
  EXPECTED_IP_CITY: env.EXPECTED_IP_CITY,
  EXPECTED_IP_COUNTRY: env.EXPECTED_IP_COUNTRY,
  DB_PATH: env.DB_PATH,
  TEMPLATE_CACHE_ENABLED: env.TEMPLATE_CACHE_ENABLED,
  TEMPLATE_MATCH_THRESHOLD: env.TEMPLATE_MATCH_THRESHOLD,
  SELF_HEAL_ENABLED: env.SELF_HEAL_ENABLED,
  SELF_HEAL_FAILURE_THRESHOLD: env.SELF_HEAL_FAILURE_THRESHOLD,
  SELF_HEAL_MAX_ATTEMPTS: env.SELF_HEAL_MAX_ATTEMPTS,
  SELF_HEAL_DEBUG_ATTEMPTS: env.SELF_HEAL_DEBUG_ATTEMPTS,
  SELF_HEAL_BACKUP_DIR: env.SELF_HEAL_BACKUP_DIR,
  SELF_HEAL_MAX_BACKUPS: env.SELF_HEAL_MAX_BACKUPS,
  SELF_HEAL_TEST_DEPTH: env.SELF_HEAL_TEST_DEPTH,
  SELF_HEAL_MANUAL_OVERRIDE: env.SELF_HEAL_MANUAL_OVERRIDE || null,
  STATE_TIMEOUT_MS: env.STATE_TIMEOUT_MS,
  SELF_HEAL_STAGING_DIR: env.SELF_HEAL_STAGING_DIR,
  PATCH_HISTORY_MAX: env.PATCH_HISTORY_MAX,
  HEARTBEAT_FILE: env.HEARTBEAT_FILE,
  HEARTBEAT_INTERVAL_MS: env.HEARTBEAT_INTERVAL_MS,
  CHECKPOINT_FILE: env.CHECKPOINT_FILE,
  OCR_FALLBACK_ENABLED: env.OCR_FALLBACK_ENABLED,
  PROVIDER_HEALTH_CHECK_INTERVAL_MS: env.PROVIDER_HEALTH_CHECK_INTERVAL_MS,
  MISTRAL_CODE_API_KEY: env.MISTRAL_CODE_API_KEY || null,
  QWEN_CODE_API_KEY: env.QWEN_CODE_API_KEY || null,
  DEEPSEEK_CODE_API_KEY: env.DEEPSEEK_CODE_API_KEY || null,
  BAZAARLINK_API_KEY: env.BAZAARLINK_API_KEY || null,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || null,
  CODE_GEN_MODEL_MISTRAL: env.CODE_GEN_MODEL_MISTRAL,
  CODE_GEN_MODEL_QWEN: env.CODE_GEN_MODEL_QWEN,
  CODE_GEN_MODEL_DEEPSEEK: env.CODE_GEN_MODEL_DEEPSEEK,
  CODE_GEN_MODEL_OPENROUTER: env.CODE_GEN_MODEL_OPENROUTER,
  CODE_GEN_MODEL_BAZAARLINK: env.CODE_GEN_MODEL_BAZAARLINK,
  CODE_GEN_PROVIDERS: env.CODE_GEN_PROVIDERS,
  CODE_GEN_FALLBACK_MODELS: env.CODE_GEN_FALLBACK_MODELS,
  CODE_GEN_CONSENSUS_THRESHOLD: env.CODE_GEN_CONSENSUS_THRESHOLD,
  AUTO_INSTALL_DEPENDENCIES: env.AUTO_INSTALL_DEPENDENCIES,
  SANDBOX_MODE: env.SANDBOX_MODE,
  WEB_SEARCH_ENABLED: env.WEB_SEARCH_ENABLED,
  GITHUB_API_KEY: env.GITHUB_API_KEY || null,
  GROQ_API_KEY: env.GROQ_API_KEY || null,
  ZAI_API_KEY: env.ZAI_API_KEY || null,
  AGNES_API_KEY: env.AGNES_API_KEY || null,
  NVIDIA_API_KEY: env.NVIDIA_API_KEY || null,
  CF_API_KEY: env.CF_API_KEY || null,
  CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || null,
  CEREBRAS_API_KEY: env.CEREBRAS_API_KEY || null,
  GEMINI_API_KEY: env.GEMINI_API_KEY || null,
  EVOLUTION_INTERVAL_DAYS: env.EVOLUTION_INTERVAL_DAYS,
  GITOPS_ENABLED: env.GITOPS_ENABLED,
  GITOPS_ROLLBACK_DEPTH: env.GITOPS_ROLLBACK_DEPTH,
  PROVIDER_BUDGET_OPENROUTER: env.PROVIDER_BUDGET_OPENROUTER,
  PROVIDER_BUDGET_MISTRAL: env.PROVIDER_BUDGET_MISTRAL,
  PROVIDER_BUDGET_GITHUB: env.PROVIDER_BUDGET_GITHUB,
  BARGAIN_HUNTER_INTERVAL_HOURS: env.BARGAIN_HUNTER_INTERVAL_HOURS,
  CAPTCHA_HUMAN_TIMEOUT_MS: env.CAPTCHA_HUMAN_TIMEOUT_MS,
  UI_DRIFT_THRESHOLD: env.UI_DRIFT_THRESHOLD,
  BRUTE_FORCE_MAX_TRIES: env.BRUTE_FORCE_MAX_TRIES,
  AUTO_FIX_DEPENDENCIES: env.AUTO_FIX_DEPENDENCIES,
  FORCE_NODE_VERSION: env.FORCE_NODE_VERSION,
  ENABLE_FLUTTER_SEMANTICS: env.ENABLE_FLUTTER_SEMANTICS,
  ENABLE_NETWORK_INTERCEPT: env.ENABLE_NETWORK_INTERCEPT,
  ENABLE_CANVAS_OCR: env.ENABLE_CANVAS_OCR,
  FLUTTER_DPR_AUTO_CALIBRATE: env.FLUTTER_DPR_AUTO_CALIBRATE,
  NETWORK_REPLAY_ON_CLICK_FAIL: env.NETWORK_REPLAY_ON_CLICK_FAIL,
  SWIPE_DURATION_MS: env.SWIPE_DURATION_MS,
  LONG_PRESS_DELAY_MS: env.LONG_PRESS_DELAY_MS,
  REMOTE_BRAIN_URL: env.REMOTE_BRAIN_URL || null,
  BRAIN_API_KEY: env.BRAIN_API_KEY || null,
  ENABLE_BLACKBOX: env.ENABLE_BLACKBOX,
  BLACKBOX_MAX_ENTRIES: env.BLACKBOX_MAX_ENTRIES,
  BLACKBOX_REPLAY_ENABLED: env.BLACKBOX_REPLAY_ENABLED,
  ENABLE_ADAPTIVE_PERFORMANCE: env.ENABLE_ADAPTIVE_PERFORMANCE,
  PERFORMANCE_BASELINE_MS: env.PERFORMANCE_BASELINE_MS,
  ENABLE_PROTOCOL_CHAMELEON: env.ENABLE_PROTOCOL_CHAMELEON,
  PROTOCOL_CHAMELEON_SCHEMA_URLS: env.PROTOCOL_CHAMELEON_SCHEMA_URLS,
  ENABLE_GAN_TELEMETRY: env.ENABLE_GAN_TELEMETRY,
  GAN_MODEL_PATH: env.GAN_MODEL_PATH,
  ENABLE_EXPLORATION_PASS: env.ENABLE_EXPLORATION_PASS,
  EXPLORATION_CONSECUTIVE_FAILURES: env.EXPLORATION_CONSECUTIVE_FAILURES,
  ENABLE_LOCAL_VLM: env.ENABLE_LOCAL_VLM,
  LOCAL_VLM_MODEL: env.LOCAL_VLM_MODEL,
  ENABLE_PUZZLE_SANDBOX: env.ENABLE_PUZZLE_SANDBOX,
  ENABLE_RUNTIME_GUARDIAN: env.ENABLE_RUNTIME_GUARDIAN,
  RUNTIME_MANIFEST_URL: env.RUNTIME_MANIFEST_URL,
  SELF_HEAL_ALLOW_ALL: env.SELF_HEAL_ALLOW_ALL || null,
  ADMIN_ALLOWED_IPS: env.ADMIN_ALLOWED_IPS || null,
  NTFY_TOPIC: env.NTFY_TOPIC || null,
  SMTP_HOST: env.SMTP_HOST || null,
  SMTP_PORT: env.SMTP_PORT || '587',
  SMTP_USER: env.SMTP_USER || null,
  SMTP_PASS: env.SMTP_PASS || null,
  SMTP_FROM: env.SMTP_FROM || null,
  ALERT_EMAIL_TO: env.ALERT_EMAIL_TO || null,
  SMTP_SECURE: env.SMTP_SECURE ?? false,
  POLICY_ENFORCED: env.POLICY_ENFORCED,
  POLICY_BLOCKED_DOMAINS: env.POLICY_BLOCKED_DOMAINS || '',
  DASHBOARD_PORT: env.DASHBOARD_PORT || 8080,
  WAIT_MULTIPLIER: env.WAIT_MULTIPLIER || 1.0,
  VISION_PRIORITY: env.VISION_PRIORITY || 'cloud',
  PROVIDER_ORDER: env.PROVIDER_ORDER || '',
  // Self-heal v2 predictive
  PREDICTIVE_HEAL_ENABLED: env.PREDICTIVE_HEAL_ENABLED,
  PREDICTIVE_HEAL_LATENCY_SPIKE_THRESHOLD: env.PREDICTIVE_HEAL_LATENCY_SPIKE_THRESHOLD,
  PREDICTIVE_HEAL_CLICK_DROP_THRESHOLD: env.PREDICTIVE_HEAL_CLICK_DROP_THRESHOLD,
  SELECTOR_DRIFT_HEAL_ENABLED: env.SELECTOR_DRIFT_HEAL_ENABLED,
  // Smarter patch generation
  REGRESSION_BANK_ENABLED: env.REGRESSION_BANK_ENABLED,
  REGRESSION_BANK_DIR: env.REGRESSION_BANK_DIR,
  CANARY_ROLLOUT_ENABLED: env.CANARY_ROLLOUT_ENABLED,
  CANARY_OBSERVATION_HOURS: env.CANARY_OBSERVATION_HOURS,
  CANARY_ERROR_RATE_MULTIPLIER: env.CANARY_ERROR_RATE_MULTIPLIER,
  DIFF_MINIMIZER_ENABLED: env.DIFF_MINIMIZER_ENABLED,
  ADVERSARIAL_TESTER_ENABLED: env.ADVERSARIAL_TESTER_ENABLED,
  CRITICAL_SHADOW_MODE_ENABLED: env.CRITICAL_SHADOW_MODE_ENABLED,
  PROMPT_EVOLUTION_ENABLED: env.PROMPT_EVOLUTION_ENABLED,
  PROMPT_EVOLUTION_MIN_ENTRIES: env.PROMPT_EVOLUTION_MIN_ENTRIES,
  // Beyond code
  DB_HEALER_ENABLED: env.DB_HEALER_ENABLED,
  DB_HEALER_QUARANTINE_MAX_AGE_DAYS: env.DB_HEALER_QUARANTINE_MAX_AGE_DAYS,
  AUTH_HEALER_ENABLED: env.AUTH_HEALER_ENABLED,
  AUTH_HEALER_MAX_FAILURES: env.AUTH_HEALER_MAX_FAILURES,
  STATE_RECOVERY_ENABLED: env.STATE_RECOVERY_ENABLED,
  STATE_RECOVERY_PROMOTE_AFTER: env.STATE_RECOVERY_PROMOTE_AFTER,
  STATE_RECOVERY_TTL_DAYS: env.STATE_RECOVERY_TTL_DAYS,
  DEPENDENCY_HEALER_ENABLED: env.DEPENDENCY_HEALER_ENABLED,
  CONFIG_RECONCILER_ENABLED: env.CONFIG_RECONCILER_ENABLED,
  EXTENDED_CHECKPOINT_ENABLED: env.EXTENDED_CHECKPOINT_ENABLED,
  // Observability
  BLACKBOX_FULL_ENABLED: env.BLACKBOX_FULL_ENABLED,
  BLACKBOX_FULL_MAX_ENTRIES: env.BLACKBOX_FULL_MAX_ENTRIES,
  PATCH_MEMORY_ENABLED: env.PATCH_MEMORY_ENABLED,
  PATCH_MEMORY_TOP_K: env.PATCH_MEMORY_TOP_K,
  HEAL_REWARD_TRACKER_ENABLED: env.HEAL_REWARD_TRACKER_ENABLED,
  SELF_HEAL_TIMELINE_ENABLED: env.SELF_HEAL_TIMELINE_ENABLED,
  // Meta-healing
  HEALER_SELF_TEST_ENABLED: env.HEALER_SELF_TEST_ENABLED,
  HEALER_SELF_TEST_INTERVAL_HOURS: env.HEALER_SELF_TEST_INTERVAL_HOURS,
  HEALER_CIRCUIT_BREAKER_ENABLED: env.HEALER_CIRCUIT_BREAKER_ENABLED,
  HEALER_CB_FAILURE_RATE: env.HEALER_CB_FAILURE_RATE,
  HEALER_CB_SLIDING_WINDOW: env.HEALER_CB_SLIDING_WINDOW,
  SUBSYSTEM_CB_MESH_ENABLED: env.SUBSYSTEM_CB_MESH_ENABLED,
  // Last mile
  CLEAN_ROOM_TEST_ENABLED: env.CLEAN_ROOM_TEST_ENABLED,
  CLEAN_ROOM_TEST_INTERVAL_HOURS: env.CLEAN_ROOM_TEST_INTERVAL_HOURS,
  DEGRADATION_LADDER_ENABLED: env.DEGRADATION_LADDER_ENABLED,
  SELF_DEPLOY_ENABLED: env.SELF_DEPLOY_ENABLED,
  EXECUTIVE_KEY: env.EXECUTIVE_KEY || '',
  // ACCEPT_ANY_FIX removed — now session-only in-memory flag in self-heal.ts
  CRITICAL_CONSENSUS_COOLING_OFF_MS: env.CRITICAL_CONSENSUS_COOLING_OFF_MS,
  CRITICAL_CONSENSUS_VERIFY_WINDOW_MS: env.CRITICAL_CONSENSUS_VERIFY_WINDOW_MS,
  // Cloudinary screenshot storage
  CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME || 'xlhumi67',
  CLOUDINARY_API_KEY: env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET || '',
  CLOUDINARY_FOLDER: env.CLOUDINARY_FOLDER || 'mathu-bot/screenshots',
  SCREENSHOT_STORAGE_ENABLED: env.SCREENSHOT_STORAGE_ENABLED,
  // Pixel self-training
  PIXEL_TRAINING_ENABLED: env.PIXEL_TRAINING_ENABLED,
  PIXEL_TRAINING_MAX_CACHE: env.PIXEL_TRAINING_MAX_CACHE,
  PIXEL_TRAINING_SIMILARITY_THRESHOLD: env.PIXEL_TRAINING_SIMILARITY_THRESHOLD,
  PIXEL_TRAINING_MAX_RESULTS: env.PIXEL_TRAINING_MAX_RESULTS,
};

// ─── Config validation ──────────────────────────────────────────────────────

function validateConfig(): void {
  const errors: string[] = [];

  // v5-fix: SANDBOX_MODE bypasses credential/key requirements (for testing, CI, etc.)
  const isSandbox: boolean = !!_configStore.SANDBOX_MODE;

  // ENCRYPTION_PASSPHRASE is now optional - credentials can be plain text
  if (process.env.ENCRYPTION_PASSPHRASE && process.env.ENCRYPTION_PASSPHRASE.length < 16) {
    console.warn('\u26A0\uFE0F ENCRYPTION_PASSPHRASE is set but shorter than 16 chars. Encryption will be weakened.');
  }

  // v5-fix B2: Graceful degradation when credentials are missing.
  // Instead of throwing (which crashes the bot before DB/browser init),
  // set DEGRADED_MODE=true and log clear warnings. The bot can still start
  // for monitoring, dashboard, and self-heal analysis purposes.
  // Only structural config errors (bad numeric ranges, path issues) are fatal.
  if (!isSandbox) {
    let credsOk = true;
    try {
      const email: string = getMicrosoftEmail();
      console.log(`\u2705 Credentials validated for: ${email.split('@')[0]}@*****`);
    } catch (e: unknown) {
      console.warn(`\u26A0\uFE0F DEGRADED: Missing Microsoft credentials — ${(e as Error).message}`);
      console.warn('\u26A0\uFE0F   Set MICROSOFT_EMAIL and MICROSOFT_PASSWORD in .env to enable full operation.');
      credsOk = false;
    }
    const visionKeys: string[] = ['GITHUB_API_KEY', 'GROQ_API_KEY', 'ZAI_API_KEY', 'AGNES_API_KEY', 'NVIDIA_API_KEY', 'CF_API_KEY', 'GEMINI_API_KEY'];
    const hasVisionKey: boolean = visionKeys.some(k => process.env[k] && process.env[k].length > 10);
    if (!hasVisionKey) {
      console.warn('\u26A0\uFE0F DEGRADED: No vision API keys found. Vision-dependent features disabled.');
      credsOk = false;
    }
    const codeKeys: string[] = ['MISTRAL_CODE_API_KEY', 'QWEN_CODE_API_KEY', 'DEEPSEEK_CODE_API_KEY', 'BAZAARLINK_API_KEY', 'OPENROUTER_API_KEY'];
    const hasCodeKey: boolean = codeKeys.some(k => process.env[k] && process.env[k].length > 10);
    if (!hasCodeKey) {
      console.warn('\u26A0\uFE0F No code-generation API keys found. Self-heal will be limited.');
    }
    if (!credsOk) {
      _configStore.DEGRADED_MODE = true;
      console.warn('\u26A0\uFE0F DEGRADED_MODE=true — bot starting in limited mode. Monitoring and self-heal analysis still available.');
    }
  } else {
    console.log('\u26A0\uFE0F SANDBOX_MODE=true — skipping credential and API key validation.');
  }

  if (_configStore.SLEEP_MIN_HOURS >= _configStore.SLEEP_MAX_HOURS) { errors.push('SLEEP_MIN_HOURS must be less than SLEEP_MAX_HOURS'); }
  if (_configStore.ALLOWED_ACTIVITY_START_HOUR === _configStore.ALLOWED_ACTIVITY_END_HOUR) { errors.push('ALLOWED_ACTIVITY_START_HOUR must differ from ALLOWED_ACTIVITY_END_HOUR'); }
  if (_configStore.MEMORY_WARNING_THRESHOLD_MB >= _configStore.MEMORY_RESTART_THRESHOLD_MB) { errors.push('MEMORY_WARNING_THRESHOLD_MB must be less than MEMORY_RESTART_THRESHOLD_MB'); }
  if (_configStore.MEMORY_RESTART_THRESHOLD_MB > _configStore.MAX_MEMORY_MB) { errors.push('MEMORY_RESTART_THRESHOLD_MB cannot exceed MAX_MEMORY_MB'); }
  const numericValidations: Array<{ key: string; min: number; max: number }> = [
    { key: 'MAX_AUTH_ATTEMPTS', min: 1, max: 100 },
    { key: 'CAPTCHA_MAX_ATTEMPTS', min: 1, max: 10 },
    { key: 'CIRCUIT_BREAKER_FAILURE_THRESHOLD', min: 1, max: 50 },
    { key: 'MAX_BACKOFF_MULTIPLIER', min: 2, max: 64 },
    { key: 'TEMPLATE_MATCH_THRESHOLD', min: 0.5, max: 1.0 },
    { key: 'STATE_TIMEOUT_MS', min: 60000, max: 1800000 },
  ];
  for (const { key, min, max } of numericValidations) {
    if (typeof _configStore[key] !== 'number' || _configStore[key] < min || _configStore[key] > max) {
      errors.push(`${key} must be between ${min} and ${max}`);
    }
  }
  const pathValidations: string[] = ['LOG_DIR', 'SCREENSHOT_DIR', 'SELF_HEAL_BACKUP_DIR', 'USER_DATA_DIR'];
  for (const pathKey of pathValidations) {
    try { fs.accessSync(_configStore[pathKey], fs.constants.W_OK); } catch { console.warn(`\u26A0\uFE0F Path not writable: ${pathKey}=${_configStore[pathKey]} - attempting to create it...`); try { fs.mkdirSync(_configStore[pathKey], { recursive: true }); } catch (mkdirErr: unknown) { console.warn(`\u26A0\uFE0F Could not create ${pathKey}: ${(mkdirErr as Error).message}`); } }
  }
  // v5-fix: Changed from process.exit(1) to throw. This allows the caller
  // (agent.ts) to catch the error, perform cleanup (close DB, close browser),
  // and then exit gracefully. Previously, process.exit(1) here would skip
  // all shutdown hooks, potentially leaving SQLite WAL lock files and
  // zombie Chromium processes.
  if (errors.length > 0) {
    const message = errors.map(e => ` - ${e}`).join('\n');
    throw new Error(`Configuration validation failed:\n${message}`);
  }
  console.log('\u2705 Configuration validation passed');
}

// ─── Proxy-based CONFIG (v5-fix: replaces deepFreeze + updateConfig hack) ───
// Internal _configStore is mutable. Public CONFIG is a Proxy that:
//   - Allows reads transparently (get trap)
//   - Routes sets through updateConfig validation + audit (set trap)
//   - Prevents deletions and new keys
//   - Makes data properties appear non-writable via getOwnPropertyDescriptor
// This eliminates the freeze/unfreeze/defineProperty dance entirely.

const _configMutationLog: ConfigMutationEntry[] = [];
const MAX_MUTATION_LOG: number = 200;

function updateConfig(key: string, value: unknown): void {
  if (!key || typeof key !== 'string') {
    throw new Error('[CONFIG] updateConfig requires a non-empty string key');
  }
  if (!(key in _configStore)) {
    console.warn(`[CONFIG] Rejected unknown key: ${key}`);
    return;
  }
  // Validate against the remote-override schema if one exists.
  // For runtime programmatic updates, fall back to type-match validation
  // so callers like the degradation ladder and strategy variants can update
  // keys that are not in the remote-override allowlist.
  if (typeof isValidRemoteOverride === 'function' && !isValidRemoteOverride(key, value)) {
    // Strict schema rejected — check if the key already exists with a compatible type
    if (key in _configStore && _configStore[key] !== null && value !== null) {
      if (typeof _configStore[key] !== typeof value) {
        console.warn(`[CONFIG] Rejected type-mismatch override: ${key} expected ${typeof _configStore[key]}, got ${typeof value}`);
        return;
      }
    } else {
      console.warn(`[CONFIG] Rejected invalid override: ${key}=${JSON.stringify(value)}`);
      return;
    }
  }
  const oldValue = _configStore[key];
  // v5-fix: Direct assignment to _configStore — no freeze/unfreeze hack needed.
  // The Proxy makes CONFIG appear immutable to external code.
  _configStore[key] = value;
  // Audit log
  const entry: ConfigMutationEntry = { key, oldValue, newValue: value, timestamp: Date.now(), source: 'runtime' };
  _configMutationLog.push(entry);
  if (_configMutationLog.length > MAX_MUTATION_LOG) _configMutationLog.shift();
  console.log(`[CONFIG] Updated: ${key} = ${JSON.stringify(value)}`);
}

function getConfigMutationLog(): ConfigMutationEntry[] {
  return [..._configMutationLog];
}

function getConfigSnapshot(): Record<string, any> {
  const snapshot: Record<string, any> = {};
  for (const [k, v] of Object.entries(_configStore)) {
    if (typeof v !== 'function') snapshot[k] = v;
  }
  return snapshot;
}

// ─── Build Proxy ────────────────────────────────────────────────────────────
// Add methods to _configStore BEFORE creating the Proxy so they are visible.

Object.assign(_configStore, {
  validateConfig,
  encrypt,
  decrypt,
  getMicrosoftEmail,
  getMicrosoftPassword,
  waitForRemoteConfig: () => _remoteOverridePromise || Promise.resolve(),
  isConfigFrozen: () => true, // Proxy makes CONFIG effectively frozen
  sanitizePathString,
  sanitizeUrl,
  lockCredentials: () => { _decryptedEmail = null; _decryptedPassword = null; _credentialValidationFailed = true; },
  getRemoteConfigStatus: () => ({ applied: _remoteOverridesApplied, error: null }),
  updateConfig,
  getConfigMutationLog,
  getConfigSnapshot,
});

const CONFIG: Record<string, any> = new Proxy(_configStore, {
  get(target: Record<string, any>, key: string | symbol): any {
    // Intercept hasOwnProperty so "key in CONFIG" and CONFIG.hasOwnProperty() work
    if (key === 'hasOwnProperty') {
      return (prop: string | symbol) => Object.prototype.hasOwnProperty.call(target, prop);
    }
    const value = target[key as string];
    // Bind methods so `this` refers to the store, not the proxy
    if (typeof value === 'function' && key !== 'constructor') {
      return value.bind(target);
    }
    return value;
  },

  set(target: Record<string, any>, key: string | symbol, value: any): boolean {
    if (typeof key !== 'string') return false;
    // Prevent adding new keys
    if (!(key in target)) {
      console.warn(`[CONFIG] Rejected unknown key: ${key}`);
      return false;
    }
    // v5-fix M7: Route through updateConfig for validation + audit logging.
    // Return false if updateConfig rejects the change (value unchanged after call).
    if (typeof target.updateConfig === 'function') {
      const before = target[key as string];
      target.updateConfig(key, value);
      if (target[key as string] === before && value !== before) {
        return false; // updateConfig silently rejected the change
      }
    }
    return true;
  },

  deleteProperty(): boolean {
    return false; // prevent all deletions
  },

  has(target: Record<string, any>, key: string | symbol): boolean {
    return key in target;
  },

  ownKeys(target: Record<string, any>): ArrayLike<string | symbol> {
    return Reflect.ownKeys(target);
  },

  getOwnPropertyDescriptor(target: Record<string, any>, key: string | symbol): PropertyDescriptor | undefined {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && typeof desc.value !== 'function') {
      // Make data properties appear non-writable through the proxy
      return { ...desc, writable: false, configurable: true };
    }
    return desc;
  },

  defineProperty(target: Record<string, any>, key: string | symbol, descriptor: PropertyDescriptor): boolean {
    // FIX: Route through validation to prevent bypassing security checks
    if (typeof key !== 'string') return false;
    if (!(key in target)) {
      console.warn(`[CONFIG] defineProperty rejected: unknown key ${key}`);
      return false;
    }
    if (descriptor.value !== undefined) {
      // FIX: Check BLOCKED_KEYS before allowing defineProperty to set value
      if (typeof isValidRemoteOverride === 'function' && !isValidRemoteOverride(key as string, descriptor.value)) {
        console.warn(`[CONFIG] defineProperty blocked for protected key: ${key}`);
        return false;
      }
      const oldValue = target[key];
      target[key] = descriptor.value;
      const entry: ConfigMutationEntry = { key, oldValue, newValue: descriptor.value, timestamp: Date.now(), source: 'defineProperty' };
      _configMutationLog.push(entry);
      if (_configMutationLog.length > MAX_MUTATION_LOG) _configMutationLog.shift();
      console.log(`[CONFIG] Updated via defineProperty: ${key} = ${JSON.stringify(descriptor.value)}`);
    }
    return true;
  },

  preventExtensions(): boolean {
    return true; // no-op — proxy handles extensibility enforcement
  },

  setPrototypeOf(): boolean {
    return false;
  },

  getPrototypeOf(target: Record<string, any>): object | null {
    return Object.getPrototypeOf(target);
  },
});

// Apply remote overrides (writes directly to _configStore, reads via CONFIG proxy work fine)
_remoteOverridePromise = applyRemoteOverridesAsync()
  .catch((e: unknown) => {
    console.warn('[CONFIG] Remote overrides failed (using defaults):', (e as Error).message);
  });

// Export CONFIG — the Proxy. All reads are transparent, all writes go through
// updateConfig validation. Use waitForRemoteConfig() to ensure overrides are
// applied before reading override-dependent keys.
module.exports = CONFIG;
