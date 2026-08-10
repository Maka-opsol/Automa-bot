'use strict';

// ═══════════════════════════════════════════════════════════════
// instance-lock.ts — Prevents dual instances from running
// ═══════════════════════════════════════════════════════════════
// Render free tier may occasionally spawn duplicate processes.
// This module uses a file-based lock to detect and prevent
// two instances from running simultaneously, which causes
// duplicate logs, double provider calls, and disk races.
//
// Lock file: /tmp/mathu-instance.lock
// Contains: PID and timestamp
// Stale after: 5 minutes (process likely died without cleanup)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCK_FILE = path.join(os.tmpdir(), 'mathu-instance.lock');
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface LockInfo {
  pid: number;
  timestamp: number;
  hostname: string;
}

/**
 * Attempt to acquire the instance lock.
 * Returns true if lock was acquired (this instance should run).
 * Returns false if another live instance holds the lock.
 *
 * This is called VERY early in agent.ts bootstrap, before
 * any other modules are loaded. Keep dependencies minimal.
 */
function acquireLock(): boolean {
  try {
    // Check for existing lock
    if (fs.existsSync(LOCK_FILE)) {
      try {
        const data = fs.readFileSync(LOCK_FILE, 'utf8');
        const info: LockInfo = JSON.parse(data);
        const age = Date.now() - info.timestamp;

        // Check if the locking process is still alive
        let processAlive = false;
        try {
          // Sending signal 0 doesn't kill, just checks existence
          process.kill(info.pid, 0);
          processAlive = true;
        } catch {
          processAlive = false;
        }

        if (processAlive && age < STALE_THRESHOLD_MS) {
          // Another live instance holds the lock
          console.error(`[instance-lock] ANOTHER INSTANCE DETECTED: pid=${info.pid}, age=${Math.round(age / 1000)}s`);
          console.error(`[instance-lock] This instance (pid=${process.pid}) will EXIT to prevent dual-running.`);
          return false;
        }

        // Lock is stale or process is dead — reclaim it
        console.log(`[instance-lock] Reclaiming stale lock from pid=${info.pid} (age=${Math.round(age / 1000)}s, alive=${processAlive})`);
      } catch (parseErr) {
        // Corrupt lock file — reclaim
        console.log('[instance-lock] Corrupt lock file, reclaiming');
      }
    }

    // Write our lock
    const info: LockInfo = {
      pid: process.pid,
      timestamp: Date.now(),
      hostname: os.hostname(),
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(info), 'utf8');
    console.log(`[instance-lock] Lock acquired: pid=${process.pid}`);
    return true;

  } catch (err: any) {
    // If we can't check/write the lock, allow running (fail-open)
    console.error(`[instance-lock] Lock check failed: ${err.message}. Allowing instance to run (fail-open).`);
    return true;
  }
}

/**
 * Release the instance lock. Called on graceful shutdown.
 */
function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const data = fs.readFileSync(LOCK_FILE, 'utf8');
      const info: LockInfo = JSON.parse(data);
      if (info.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        console.log('[instance-lock] Lock released');
      }
    }
  } catch {}
}

// Auto-release on exit
process.on('exit', releaseLock);
process.on('SIGTERM', () => { releaseLock(); });
process.on('SIGINT', () => { releaseLock(); });

module.exports = { acquireLock, releaseLock };
