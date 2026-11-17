import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

require('tsx/cjs/api').register();
const { CleanRoomTest, _injectDependencies } = require('./self-heal-clean-room-test');

async function runGenerated(failNavigation = false, configUrl: string | undefined = 'http://local.test') {
  const calls: string[] = [];
  let navigatedUrl = '';
  const fakePage = {
    goto: async (url: string) => { navigatedUrl = url; calls.push('goto'); if (failNavigation) throw new Error('secret-test-pass ' + url); },
    screenshot: async () => Buffer.alloc(200),
    $$eval: async () => 1,
  };
  let done!: () => void;
  const closed = new Promise<void>(resolve => { done = resolve; });
  const childProcess = { pid: 12345, env: { APP_URL: 'http://env.test' }, exitCode: 0 };
  class FakeDb {
    prepare(sql: string) { return { run: () => ({}), get: () => ({ val: 'clean-room' }) }; }
    close() {}
  }
  const projectRequire: any = (name: string) => {
    if (name === 'tsx/cjs/api') return { register() {} };
    if (name === './config') return { APP_URL: configUrl };
    if (name === 'better-sqlite3') return FakeDb;
    if (name === './logger') return { log() {} };
    if (name === './browser') return { _injectDependencies() {}, launchBrowser: async () => fakePage, closeBrowser: async () => { calls.push('closeBrowser'); } };
    if (name === './browser-proxy') return { safeBrowserError: () => 'details withheld' };
    throw Error('unexpected project import ' + name);
  };
  const output: string[] = [];
  const localRequire = (name: string) => {
    if (name === 'path') return path;
    if (name === 'os') return os;
    if (name === 'module') return { createRequire: () => projectRequire };
    if (name === 'fs') return { mkdtempSync: () => '/tmp/clean-room-test-random', rmSync() { calls.push('rm'); done(); } };
    throw Error('unexpected import ' + name);
  };
  const script = new CleanRoomTest().generateTestScript();
  new vm.Script(script).runInNewContext({ require: localRequire, process: childProcess, console: { log: (...x: any[]) => output.push(x.join(' ')), error: (...x: any[]) => output.push(x.join(' ')) }, Buffer, Date });
  await closed;
  await Promise.resolve();
  return { calls, output, childProcess, navigatedUrl };
}

describe('clean-room safety', () => {
  it('creates a private runner without embedding the configured URL and removes it', async () => {
    const logs: string[] = [];
    _injectDependencies({ logger: { log: (s: string) => logs.push(s), logError: (s: string) => logs.push(s) } });
    const test = new CleanRoomTest();
    const config = require('./get-config');
    const original = config.APP_URL;
    const secret = 'https://user:secret-pass@example.test/path?token=secret-query';
    const realConfig = require('./config');
    realConfig.APP_URL = secret;
    let runner = '';
    try {
      test._forkTest = async (scriptPath: string) => {
        runner = scriptPath;
        const dir = path.dirname(scriptPath);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(scriptPath, 'utf8')).not.toContain(secret);
        expect(fs.readFileSync(scriptPath, 'utf8')).not.toContain('secret-query');
        throw new Error(secret);
      };
      const result = await test.runCleanRoomTest();
      expect(result.error).toBe('Fork error');
      expect(JSON.stringify(result) + logs.join('\n')).not.toContain(secret);
      expect(fs.existsSync(path.dirname(runner))).toBe(false);
    } finally {
      realConfig.APP_URL = original;
    }
  });
  it('passes the configured URL in the environment and discards child output', async () => {
    const config = require('./config');
    const original = config.APP_URL;
    const secret = 'https://user:secret-pass@example.test/path?token=secret-query';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-room-local-test-'));
    const logs: string[] = [];
    _injectDependencies({ logger: { log: (s: string) => logs.push(s), logError: (s: string, e: Error) => logs.push(s + e.message) } });
    try {
      config.APP_URL = secret;
      const scriptPath = path.join(temp, 'child.js');
      // No network: child checks its environment and emits a secret to both streams.
      fs.writeFileSync(scriptPath, `console.log(process.env.APP_URL); console.error(process.env.APP_URL); process.exit(process.env.APP_URL === ${JSON.stringify(secret)} ? 0 : 1);`);
      expect(await new CleanRoomTest()._forkTest(scriptPath)).toBe(true);
      expect(logs.join('\n')).not.toContain(secret);
    } finally {
      config.APP_URL = original;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  it('uses the environment URL as fallback and withholds navigation errors without a proxy', async () => {
    const result = await runGenerated(true, '');
    expect(result.navigatedUrl).toBe('http://env.test');
    expect(result.output.join('\n')).not.toContain('http://env.test');
    expect(result.output.join('\n')).not.toContain('secret-test-pass');
  });
  it('uses the returned Page directly and closes via the browser manager', async () => {
    const result = await runGenerated();
    expect(result.calls).toEqual(['goto', 'closeBrowser', 'rm']);
    expect(result.childProcess.exitCode).toBe(0);
    expect(result.output.join('\n')).toContain('SUCCESS');
  });
  it('closes after navigation failure and redacts the child error', async () => {
    const result = await runGenerated(true);
    expect(result.calls).toEqual(['goto', 'closeBrowser', 'rm']);
    expect(result.childProcess.exitCode).toBe(1);
    expect(result.output.join('\n')).not.toContain('secret-test-pass');
  });
  it.each(['infrastructure failure', 'timeout', 'fork exception'])('preserves state on %s even if main bot works', async (kind) => {
    const logs: string[] = [];
    _injectDependencies({ logger: { log: (s: string) => { logs.push(s); }, logError: () => {} }, alerting: { sendAlert() {} } });
    const test = new CleanRoomTest();
    test._forkTest = kind === 'fork exception' ? async () => { throw new Error('fork unavailable'); } : async () => false;
    test._checkMainBotWorking = vi.fn(async () => true);
    test._clearCacheAndSessions = vi.fn(async () => {});
    const result = await test.runCleanRoomTest();
    expect(result.passed).toBe(false);
    expect(result.addictionDetected).toBe(false);
    expect(test._clearCacheAndSessions).not.toHaveBeenCalled();
    expect(test._checkMainBotWorking).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('cache and sessions preserved');
  });
});
