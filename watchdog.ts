'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { spawn } = require('child_process');

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(PROJECT_ROOT, '.heartbeat');
const HEARTBEAT_TIMEOUT = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '') || 120000;
const CHECK_INTERVAL = 30000;

const IS_TSX = process.argv[0] === 'node' && process.execArgv.some(a => a.includes('tsx'));
const BOT_CMD = IS_TSX ? ['--import', 'tsx', 'agent.ts'] : ['--expose-gc', '--max-old-space-size=768', 'dist/agent.js'];

let botProcess: any;
let pendingRestartTimer: any = null;
let restartBackoffMs = 5000;
let consecutiveRestarts = 0;
const MAX_CONSECUTIVE_RESTARTS = 20;

function startBot() {
  botProcess = spawn('node', BOT_CMD, { stdio: 'inherit' });
  botProcess.on('error', (err: any) => {
    console.error('Bot spawn error:', err.message);
    console.log('Spawn failed -- restarting...');
    pendingRestartTimer = setTimeout(startBot, restartBackoffMs);
    restartBackoffMs = Math.min(restartBackoffMs * 2, 300000);
  });
  botProcess.on('exit', (code: any, signal: any) => {
    // v6-fix: Always restart the bot, even on exit(0).
    // The old code stopped the watchdog on exit(0), but the bot uses
    // exit(1) for scheduled restarts. If the bot exits 0 for any reason,
    // the watchdog should still restart it for a 5-year unattended run.
    if (consecutiveRestarts >= MAX_CONSECUTIVE_RESTARTS) {
      console.error(`Max restarts (${MAX_CONSECUTIVE_RESTARTS}) exceeded. Giving up.`);
      process.exit(1);
    }
    console.log('Bot exited -- restarting...');
    pendingRestartTimer = setTimeout(startBot, restartBackoffMs);
    restartBackoffMs = Math.min(restartBackoffMs * 2, 300000);
    consecutiveRestarts++;
  });
  botProcess.on('spawn', () => {
    if (consecutiveRestarts > 0) {
      console.log(`Bot started after ${consecutiveRestarts} restarts`);
      restartBackoffMs = 5000;
      consecutiveRestarts = 0;
    }
  });
}

setInterval(() => {
  try {
    const stat = fs.statSync(HEARTBEAT_FILE);
    if (Date.now() - stat.mtimeMs > HEARTBEAT_TIMEOUT) { console.log('Heartbeat stale -- killing bot'); if (botProcess) botProcess.kill('SIGKILL'); }
  } catch (_e: any) { /* non-critical, suppressed */ }
}, CHECK_INTERVAL).unref();

startBot();
console.log('Watchdog started');

process.on('SIGTERM', () => {
  console.log('Watchdog received SIGTERM, shutting down...');
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  if (botProcess) botProcess.kill('SIGTERM');
  process.exit(0);
});
