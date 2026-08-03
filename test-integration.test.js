/**
 * Integration tests for MathU Bot v4
 *
 * These tests verify that the DI container, config, database, and core
 * subsystems can initialize and work together. They intentionally DO NOT
 * require Microsoft credentials or API keys — they test the wiring, not
 * the external integrations.
 *
 * Run: npm run test:integration
 */

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const path = require('path');
const fs = require('fs');

// Set minimal env vars needed for config validation to pass
process.env.DB_PATH = path.join(__dirname, 'test-integration.db');
process.env.LOG_DIR = path.join(__dirname, 'test-logs');
process.env.SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');
process.env.USER_DATA_DIR = path.join(__dirname, 'test-browser-data');
process.env.SELF_HEAL_BACKUP_DIR = path.join(__dirname, 'test-backups');
process.env.ADMIN_SECRET = 'test-secret-for-integration';
process.env.HEADLESS = 'true';
process.env.SAVE_SCREENSHOTS = 'false';
process.env.SELF_DEPLOY_ENABLED = 'false';
process.env.ENABLE_IP_CHECK = 'false';
process.env.WEB_SEARCH_ENABLED = 'false';

describe('Integration: DI Container Bootstrap', () => {
  let container;
  let createContainer;

  beforeAll(() => {
    // Ensure test directories exist
    for (const dir of [process.env.LOG_DIR, process.env.SCREENSHOT_DIR,
         process.env.USER_DATA_DIR, process.env.SELF_HEAL_BACKUP_DIR]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test artifacts
    const files = [
      process.env.DB_PATH,
      path.join(__dirname, 'state.json'),
      path.join(__dirname, 'last-state.json'),
      path.join(__dirname, 'checkpoint.json'),
    ];
    for (const f of files) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
    const dirs = [
      process.env.LOG_DIR, process.env.SCREENSHOT_DIR,
      process.env.USER_DATA_DIR, process.env.SELF_HEAL_BACKUP_DIR,
    ];
    for (const d of dirs) {
      try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true }); } catch {}
    }
  });

  it('should create the DI container without error', () => {
    const mod = require('./container-modules');
    createContainer = mod.createContainer;
    expect(typeof createContainer).toBe('function');
    container = createContainer();
    expect(container).toBeDefined();
  });

  it('should resolve the config module (critical)', () => {
    const config = container.get('config');
    expect(config).toBeDefined();
    expect(config.APP_URL).toBeDefined();
    expect(config.HEADLESS).toBe(true);
    expect(typeof config.validateConfig).toBe('function');
    expect(typeof config.updateConfig).toBe('function');
  });

  it('should resolve the logger module (critical)', () => {
    const logger = container.get('logger');
    expect(logger).toBeDefined();
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.logError).toBe('function');
  });

  it('should resolve the database module (critical)', () => {
    const db = container.get('database');
    expect(db).toBeDefined();
    expect(db.db).toBeDefined();
    // Verify the DB file was created
    expect(fs.existsSync(process.env.DB_PATH)).toBe(true);
  });

  it('should resolve the alerting module (critical, moved from non-critical)', () => {
    const alerting = container.get('alerting');
    expect(alerting).toBeDefined();
    expect(typeof alerting.sendAlert).toBe('function');
    expect(typeof alerting.canSendAlert).toBe('function');
  });

  it('should resolve the stateMachine module (critical)', () => {
    const sm = container.get('stateMachine');
    expect(sm).toBeDefined();
    expect(typeof sm.isValidState).toBe('function');
    expect(typeof sm.isValidAction).toBe('function');
  });

  it('should resolve providersBase with DI config proxy', () => {
    const base = container.get('providersBase');
    expect(base).toBeDefined();
    expect(typeof base.callChatCompletion).toBe('function');
    expect(typeof base.retryWithBackoff).toBe('function');
    expect(typeof base.safeCall).toBe('function');
  });

  it('should resolve providersConfigLoader with lazy DB access', () => {
    const loader = container.get('providersConfigLoader');
    expect(loader).toBeDefined();
    expect(typeof loader.getProviderConfig).toBe('function');
    expect(typeof loader.updateProviderConfig).toBe('function');
    expect(typeof loader.rollbackProvider).toBe('function');
    // Should not throw even though DB was just initialized
    const config = loader.getProviderConfig('Groq');
    expect(config).toBeDefined();
    expect(config.model).toBe('llama-3.2-11b-vision-preview');
  });

  it('should NOT have validationSuite in the container (removed from DI)', () => {
    // This module was incorrectly registered as a production DI module
    expect(() => container.get('validationSuite')).toThrow();
  });

  it('should provide a container health summary', () => {
    const summary = container.getSummary();
    expect(summary).toBeDefined();
    expect(typeof summary).toBe('object');
  });
});

describe('Integration: Config Module', () => {
  it('should export the same object reference across multiple requires', () => {
    const a = require('./config');
    const b = require('./config');
    // Both should point to the same frozen CONFIG object
    expect(a.MAX_TOKENS).toBe(b.MAX_TOKENS);
    expect(a).toBe(b);
  });

  it('should have validateConfig that does not throw with test env', () => {
    const config = require('./config');
    // validateConfig warns about missing creds but should not throw
    // (it only throws on invalid numeric ranges, which our test env doesn't trigger)
    expect(() => config.validateConfig()).not.toThrow();
  });

  it('should have updateConfig that validates key existence', () => {
    const config = require('./config');
    // Should warn and return for unknown keys (not throw)
    expect(() => config.updateConfig('NONEXISTENT_KEY', 42)).not.toThrow();
  });
});
