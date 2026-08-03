'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const MAX_BACKUPS = 7;

function ensureBackupDir() { 
  if (!fs.existsSync(BACKUP_DIR)) { fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o750 }); }
}

function createBackup() { 
  ensureBackupDir();
  const dbPath = CONFIG.DB_PATH;
  if (!dbPath) { log('No DB_PATH configured, skipping backup', 'WARN', 'db-backup'); return; }
  if (!fs.existsSync(dbPath)) { log('Database file not found, skipping backup', 'WARN', 'db-backup'); return; }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `mathu-bot-${timestamp}.db`);
  try {
    fs.copyFileSync(dbPath, backupFile);
  } catch (err: any) {
    logError('Database backup copy failed', err);
    return;
  }
  log(`Database backed up to ${backupFile}`, 'INFO', 'db-backup');
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f: any) => f.startsWith('mathu-bot-') && f.endsWith('.db'))
    .map((f: any) => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a: any, b: any) => b.time - a.time);
  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(MAX_BACKUPS);
    for (const file of toDelete) { try { fs.unlinkSync(path.join(BACKUP_DIR, file.name)); log(`Deleted old backup ${file.name}`, 'DEBUG', 'db-backup'); } catch (delErr: any) { logError(`Failed to delete old backup ${file.name}`, delErr); } }
  }
}

function startScheduledBackup() {
  // v6-fix: On Render free plan, disk is ephemeral (wiped on every restart).
  // Backups are worthless — they waste I/O and disk the running process needs.
  const isEphemeralDisk = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.REPLIT_VM === 'true');
  if (isEphemeralDisk) {
    log('Ephemeral disk detected — database backups disabled (disk wipes on restart)', 'INFO', 'db-backup');
    return;
  }
  try { createBackup(); } catch (e: any) { logError('Initial backup failed', e); }
  const backupTimer = setInterval(createBackup, 24 * 60 * 60 * 1000);
  if (backupTimer.unref) backupTimer.unref();
  log('Database backup scheduler started', 'INFO', 'db-backup');
}

module.exports = { createBackup, startScheduledBackup, _injectDependencies };
