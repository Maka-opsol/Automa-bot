'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
const shutdownHooks: any[] = [];

function registerShutdownHook(hook: any, priority = 10) { 
  shutdownHooks.push({ hook, priority });
  shutdownHooks.sort((a, b) => a.priority - b.priority);
}

// v6-fix: Per-hook timeout prevents any single hook from hanging forever.
// On Render free plan, a hung process = permanent death.
const HOOK_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: any) { 
  log(`Received ${signal}, starting graceful shutdown...`, 'WARN', 'shutdown');
  for (const { hook, priority } of shutdownHooks) {
    try {
      await Promise.race([
        Promise.resolve(hook()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Shutdown hook (priority ${priority}) timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS)
        ),
      ]);
    } catch (err: any) { const msg = err instanceof Error ? err.message : String(err); log(`Shutdown hook failed: ${msg}`, 'ERROR', 'shutdown'); }
  }
}

// SIGTERM/SIGINT handlers are registered in agent.js to avoid duplicate races.
// This module only provides hook registration and the gracefulShutdown utility.

module.exports = { registerShutdownHook, gracefulShutdown, _injectDependencies };
