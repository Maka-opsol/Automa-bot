// bootstrap-calibration.test.ts
// Vitest suite for the bootstrap calibration gate.
//
// Run via: npm test  (vitest discovers *.test.ts files)
// Or: npx vitest run bootstrap-calibration
//
// Mocks Ollama (not running in CI) + the browser (Playwright too heavy for
// unit tests) and exercises: tolerant JSON parsing, each action type, the
// full success loop (scroll → click → done), disabled mode, Ollama-unreachable
// (strict + non-strict), stuck detection, and prompt content.
//
// NOTE: vitest 2.x is ESM-only, so we use `import` for the vitest package
// itself. The local modules (bootstrap-calibration etc.) are CommonJS and
// are required normally — vitest's transform handles the mix.

import { describe, it, expect, afterEach } from 'vitest';
import bootstrapMod from './bootstrap-calibration';
const { runBootstrap, _executeBootstrapAction, _extractJSON, BOOTSTRAP_PROMPT } = bootstrapMod as any;

// ─── Mock Ollama provider ───
function makeMockOllamaProvider(sequence, opts = {}) {
  const seq = [...sequence];
  let callCount = 0;
  return {
    OllamaProvider: () => {
      if (opts.unreachable) return null;
      return async () => {
        callCount++;
        const action = seq.shift();
        if (!action) return '{"actionType":"done","reasoning":"sequence exhausted"}';
        return action;
      };
    },
    _probeReachability: () => !opts.unreachable,
    _callCount: () => callCount,
  };
}

// ─── Mock browser + page ───
function makeMockBrowser() {
  const calls = {
    launchBrowser: 0, getPage: 0, compressScreenshot: 0,
    performClickWithRetry: 0, scrollPage: 0, getViewportDimensions: 0,
    goto: [], screenshot: 0, keyboardType: [], mouseClick: [], mouseWheel: [],
  };
  const mockPage = {
    goto: async (url, opts) => { calls.goto.push({ url, opts }); },
    screenshot: async () => { calls.screenshot++; return Buffer.from('/9j/4AAQSkZJRg=', 'base64'); },
    keyboard: { type: async (text, opts) => { calls.keyboardType.push({ text, opts }); } },
    mouse: {
      click: async (x, y) => { calls.mouseClick.push({ x, y }); },
      wheel: async (dx, dy) => { calls.mouseWheel.push({ dx, dy }); },
    },
    waitForTimeout: async () => {},
  };
  const mockBrowser = {
    launchBrowser: async () => { calls.launchBrowser++; },
    getPage: () => { calls.getPage++; return mockPage; },
    compressScreenshot: (b64) => { calls.compressScreenshot++; return b64; },
    performClickWithRetry: async (page, x, y) => {
      calls.performClickWithRetry++;
      await page.mouse.click(x, y);
      return true;
    },
    humanMoveAndClick: async (page, x, y) => { await page.mouse.click(x, y); },
    scrollPage: async (page, dx, dy) => { calls.scrollPage++; await page.mouse.wheel(dx, dy); },
    getViewportDimensions: () => { calls.getViewportDimensions++; return { width: 1280, height: 720 }; },
  };
  return { browser: mockBrowser, page: mockPage, calls };
}

function makeMockContainer(browser) {
  return { get: (name) => {
    if (name === 'browser') return browser;
    throw new Error(`mock container: unknown module '${name}'`);
  }};
}
function makeMockLogger() {
  return { log: () => {}, logError: () => {} };
}

// Save env vars so we can restore them after each test
const SAVED_ENV = {
  BOOTSTRAP_ENABLED: process.env.BOOTSTRAP_ENABLED,
  BOOTSTRAP_STRICT: process.env.BOOTSTRAP_STRICT,
};

describe('Bootstrap Calibration — extractJSON (tolerant parsing)', () => {
  it('parses clean JSON', () => {
    expect(_extractJSON('{"actionType":"click","targetX":0.5}')?.actionType).toBe('click');
  });
  it('extracts JSON embedded in prose', () => {
    expect(_extractJSON('Here is the action: {"actionType":"done"} done!')?.actionType).toBe('done');
  });
  it('parses markdown-fenced JSON', () => {
    expect(_extractJSON('```json\n{"actionType":"scroll","scrollAmount":0.3}\n```')?.actionType).toBe('scroll');
  });
  it('returns null for non-JSON', () => {
    expect(_extractJSON('not json at all')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(_extractJSON('')).toBeNull();
  });
  it('returns null for null input', () => {
    expect(_extractJSON(null)).toBeNull();
  });
});

describe('Bootstrap Calibration — executeBootstrapAction (each action type)', () => {
  const viewport = { width: 1280, height: 720 };

  it('click at (0.5, 0.5) → absolute (640, 360)', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.mouseClick.length = 0;
    await _executeBootstrapAction(page, { actionType: 'click', targetX: 0.5, targetY: 0.5 }, browser, viewport);
    expect(calls.mouseClick.length).toBe(1);
    expect(calls.mouseClick[0].x).toBe(640);
    expect(calls.mouseClick[0].y).toBe(360);
  });

  it('type clicks the field first, then types the text', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.keyboardType.length = 0;
    calls.mouseClick.length = 0;
    await _executeBootstrapAction(page, { actionType: 'type', targetX: 0.25, targetY: 0.5, text: 'hello' }, browser, viewport);
    expect(calls.mouseClick.length).toBe(1);
    expect(calls.mouseClick[0].x).toBe(320);
    expect(calls.keyboardType.length).toBe(1);
    expect(calls.keyboardType[0].text).toBe('hello');
  });

  it('scroll down → positive wheel delta', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.mouseWheel.length = 0;
    await _executeBootstrapAction(page, { actionType: 'scroll', scrollAmount: 1.0 }, browser, viewport);
    expect(calls.mouseWheel.length).toBe(1);
    expect(calls.mouseWheel[0].dy).toBeGreaterThan(0);
  });

  it('scroll up → negative wheel delta', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.mouseWheel.length = 0;
    await _executeBootstrapAction(page, { actionType: 'scroll', scrollAmount: -1.0 }, browser, viewport);
    expect(calls.mouseWheel.length).toBe(1);
    expect(calls.mouseWheel[0].dy).toBeLessThan(0);
  });

  it('wait sleeps for waitMs', async () => {
    const { browser, page } = makeMockBrowser();
    const start = Date.now();
    await _executeBootstrapAction(page, { actionType: 'wait', waitMs: 100 }, browser, viewport);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('done is a no-op', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.mouseClick.length = 0;
    await _executeBootstrapAction(page, { actionType: 'done' }, browser, viewport);
    expect(calls.mouseClick.length).toBe(0);
  });

  it('unknown actionType does not crash', async () => {
    const { browser, page, calls } = makeMockBrowser();
    calls.mouseClick.length = 0;
    await _executeBootstrapAction(page, { actionType: 'teleport' }, browser, viewport);
    expect(calls.mouseClick.length).toBe(0);
  });
});

describe('Bootstrap Calibration — full loop (success path)', () => {
  afterEach(() => {
    process.env.BOOTSTRAP_ENABLED = SAVED_ENV.BOOTSTRAP_ENABLED;
    process.env.BOOTSTRAP_STRICT = SAVED_ENV.BOOTSTRAP_STRICT;
  });

  it('scroll → click → done in 3 iterations', async () => {
    process.env.BOOTSTRAP_ENABLED = '1';
    process.env.BOOTSTRAP_POST_ACTION_DELAY_MS = '0';
    process.env.BOOTSTRAP_SETTLE_MS = '0';
    delete process.env.BOOTSTRAP_STRICT;

    const sequence = [
      '{"actionType":"scroll","scrollAmount":0.5,"reasoning":"scrolling down"}',
      '{"actionType":"click","targetX":0.5,"targetY":0.7,"reasoning":"clicking assignments"}',
      '{"actionType":"done","reasoning":"assignment page reached"}',
    ];
    const ollamaProvider = makeMockOllamaProvider(sequence);
    const { browser, calls } = makeMockBrowser();
    const container = makeMockContainer(browser);
    const logger = makeMockLogger();

    const result = await runBootstrap({ container, log: logger.log, logError: logger.logError, ollamaProvider });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.skipped).toBeFalsy();
    expect(calls.launchBrowser).toBe(1);
    expect(calls.getPage).toBe(1);
    expect(calls.screenshot).toBeGreaterThanOrEqual(3);
    expect(calls.goto.length).toBe(1);
    expect(calls.performClickWithRetry).toBe(1);
    expect(calls.scrollPage).toBe(1);
  });

  it('BOOTSTRAP_ENABLED=0 → skipped', async () => {
    process.env.BOOTSTRAP_ENABLED = '0';

    const { browser } = makeMockBrowser();
    const result = await runBootstrap({
      container: makeMockContainer(browser),
      log: makeMockLogger().log, logError: makeMockLogger().logError,
      ollamaProvider: makeMockOllamaProvider([]),
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
  });

  it('Ollama unreachable + non-strict → graceful skip', async () => {
    process.env.BOOTSTRAP_ENABLED = '1';
    delete process.env.BOOTSTRAP_STRICT;

    const ollamaProvider = makeMockOllamaProvider([], { unreachable: true });
    const { browser } = makeMockBrowser();
    const result = await runBootstrap({
      container: makeMockContainer(browser),
      log: makeMockLogger().log, logError: makeMockLogger().logError,
      ollamaProvider,
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('ollama_unreachable');
  });

  it('Ollama unreachable + STRICT → halt', async () => {
    process.env.BOOTSTRAP_ENABLED = '1';
    process.env.BOOTSTRAP_STRICT = '1';

    const ollamaProvider = makeMockOllamaProvider([], { unreachable: true });
    const { browser } = makeMockBrowser();
    const result = await runBootstrap({
      container: makeMockContainer(browser),
      log: makeMockLogger().log, logError: makeMockLogger().logError,
      ollamaProvider,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('ollama_unreachable');
    expect(result.skipped).toBeFalsy();
  });

  it('stuck detection: same action 3x → non-strict skip', async () => {
    process.env.BOOTSTRAP_ENABLED = '1';
    process.env.BOOTSTRAP_POST_ACTION_DELAY_MS = '0';
    process.env.BOOTSTRAP_SETTLE_MS = '0';
    delete process.env.BOOTSTRAP_STRICT;

    const sequence = Array(20).fill('{"actionType":"click","targetX":0.5,"targetY":0.5,"reasoning":"same spot"}');
    const ollamaProvider = makeMockOllamaProvider(sequence);
    const { browser } = makeMockBrowser();
    const result = await runBootstrap({
      container: makeMockContainer(browser),
      log: makeMockLogger().log, logError: makeMockLogger().logError,
      ollamaProvider,
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('stuck');
    expect(result.iterations).toBe(3);
  });
});

describe('Bootstrap Calibration — BOOTSTRAP_PROMPT content', () => {
  it('is a substantial string', () => {
    expect(typeof BOOTSTRAP_PROMPT).toBe('string');
    expect(BOOTSTRAP_PROMPT.length).toBeGreaterThan(200);
  });
  it('asks for actionType', () => {
    expect(BOOTSTRAP_PROMPT).toContain('actionType');
  });
  it('defines the done sentinel', () => {
    expect(BOOTSTRAP_PROMPT).toContain('done');
  });
  it('asks for coordinates', () => {
    expect(BOOTSTRAP_PROMPT).toContain('targetX');
    expect(BOOTSTRAP_PROMPT).toContain('targetY');
  });
  it('mentions the assignment page goal', () => {
    expect(BOOTSTRAP_PROMPT).toContain('assignment');
  });
  it('lists all action types', () => {
    expect(BOOTSTRAP_PROMPT).toContain('click');
    expect(BOOTSTRAP_PROMPT).toContain('type');
    expect(BOOTSTRAP_PROMPT).toContain('scroll');
    expect(BOOTSTRAP_PROMPT).toContain('wait');
  });
});
