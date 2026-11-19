import { test } from 'vitest';

// Run the same assertions under Vitest and node:test. The cases use only the
// node:test `skip` option and per-test `t.after` cleanup.
export function registerCase(name, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const runner = options.skip ? test.skip : test;
  runner(name, async () => {
    const cleanups = [];
    try {
      await callback({ after: cleanup => cleanups.push(cleanup) });
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
}
