'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// GitHub Log Shipper — pushes bot logs to a GitHub repo branch
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose:
//   "Make it so that I can see all of the logs on GitHub." This module
//   periodically takes the bot's log file(s) and commits them to a
//   designated branch of the bot's GitHub repo, where they can be
//   browsed at github.com/<owner>/<repo>/tree/<branch>/<path>.
//
//   This is the complement to the GitHub Actions workflow that uploads
//   workflow-run logs as artifacts (90-day retention, viewable in the
//   Actions tab). The in-process shipper here covers the case where
//   the bot is running OUTSIDE GitHub Actions — on HuggingFace Spaces,
//   Render, an external VPS, etc. — and the operator wants to see the
//   live logs without SSH-ing into the host.
//
// How it works:
//   1. Every PUSH_INTERVAL_MS (default 5 min), the shipper reads the
//      configured log file(s).
//   2. It splits the log content into chunks of MAX_FILE_BYTES each
//      (default 800 KB — safely under GitHub's 100 MB per-file limit
//      and below the 1 MB recommended-text-file threshold that
//      triggers a "too large to display" warning).
//   3. For each chunk, it does a GitHub REST API two-step:
//        a) PUT /repos/:owner/:repo/contents/:path
//           with the new content (base64-encoded). GitHub's contents
//           API will commit it directly to the specified branch.
//        b) If the file already exists, the PUT must include the
//           current file's SHA (otherwise 409 Conflict). So we first
//           GET the existing file's metadata to learn its SHA.
//   4. All operations are best-effort: if the API call fails (network
//      error, rate limit, bad token), the shipper logs a warning and
//      retries on the next tick. It NEVER throws into the bot.
//
// Required environment variables:
//   GITHUB_LOGS_TOKEN        — a GitHub PAT with `repo` (or fine-grained
//                              `Contents: read+write` on the target repo).
//                              DO NOT use the workflow's auto-injected
//                              GITHUB_TOKEN — it can't write to other
//                              branches easily and may not have permission
//                              depending on repo settings.
//   GITHUB_LOGS_OWNER        — repo owner (e.g. "toqisteen")
//   GITHUB_LOGS_REPO         — repo name (e.g. "mathu-bot")
//   GITHUB_LOGS_BRANCH       — branch to push to (default: "bot-logs")
//   GITHUB_LOGS_PATH         — directory path in the repo (default: "logs")
//
//   If any of OWNER/REPO/TOKEN are missing, the shipper self-disables
//   and becomes a no-op (logs to DEBUG once on first start, then silent).
//
// Optional environment variables:
//   GITHUB_LOGS_SOURCE_FILE  — log file to ship (default: $LOG_DIR/daemon.log,
//                              falling back to /tmp/mathu-logs/bot-stdout.log).
//                              May be a comma-separated list for multiple files.
//   GITHUB_LOGS_INTERVAL_MS  — push interval (default: 5 min, min: 60s)
//   GITHUB_LOGS_MAX_FILE_BYTES — chunk size (default: 800 KB)
//   GITHUB_LOGS_AUTHOR_NAME  — commit author name (default: "MathU Bot")
//   GITHUB_LOGS_AUTHOR_EMAIL— commit author email (default: "bot@mathu.local")
//
// Integration:
//   render-free-plan.ts / hf-spaces.ts → require('./github-log-shipper').start()
//   at boot. The shipper is idempotent — calling start() multiple times
//   is safe. It also exposes getStatus() for the dashboard.
//
// Why a branch and not a Gist?
//   - Branches support directories and multiple files cleanly.
//   - Gists are flat, rate-limited more aggressively, and look messier
//     in the GitHub UI.
//   - Branches can be protected / deleted easily without affecting main.
//
//   Recommended: create the branch as an orphan branch so log commits
//   don't pollute the main branch's history:
//
//     git checkout --orphan bot-logs
//     git rm -rf .
//     echo "# Bot Logs" > README.md
//     git add README.md && git commit -m "init bot-logs branch"
//     git push origin bot-logs
//
//   Then point GITHUB_LOGS_BRANCH=bot-logs. The shipper will only ever
//   push to that branch.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps || {};
}

function getCONFIG(): Record<string, any> {
  if (_deps.config) return _deps.config;
  try { return require('./get-config'); } catch { return {}; }
}

function log(msg: string, level: string = 'INFO', mod: string = 'github-log-shipper') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  try { console.log(`[${level}] [${mod}] ${msg}`); } catch { /* nothing */ }
}

function logError(msg: string, err: any) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  try { console.error(`[ERROR] [github-log-shipper] ${msg}`, err?.message || err); } catch { /* nothing */ }
}

// ─── Types ────────────────────────────────────────────────────────────────

interface ShipperConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  sourceFiles: string[];
  intervalMs: number;
  maxFileBytes: number;
  authorName: string;
  authorEmail: string;
}

interface ShipperStatus {
  enabled: boolean;
  started: boolean;
  config: { owner: string; repo: string; branch: string; pathPrefix: string } | null;
  sourceFiles: string[];
  intervalMs: number;
  lastPushAt: number | null;
  lastPushOk: boolean | null;
  lastPushError: string | null;
  totalPushes: number;
  totalPushFailures: number;
  totalBytesPushed: number;
  lastPushBytes: number;
  skippedNoConfig: boolean;
}

interface FilePushResult {
  file: string;
  ok: boolean;
  bytes: number;
  error?: string;
  sha?: string;
}

// ─── State ─────────────────────────────────────────────────────────────────

let _started = false;
let _timer: any = null;
let _config: ShipperConfig | null = null;
let _lastPushAt: number | null = null;
let _lastPushOk: boolean | null = null;
let _lastPushError: string | null = null;
let _lastPushBytes = 0;
let _totalPushes = 0;
let _totalPushFailures = 0;
let _totalBytesPushed = 0;
let _skippedNoConfig = false;
let _firstStartLogged = false;

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;        // 5 min
const MIN_INTERVAL_MS = 60 * 1000;                  // 60s floor
const DEFAULT_MAX_FILE_BYTES = 800 * 1024;          // 800 KB per file chunk
const DEFAULT_BRANCH = 'bot-logs';
const DEFAULT_PATH_PREFIX = 'logs';
const DEFAULT_AUTHOR_NAME = 'MathU Bot';
const DEFAULT_AUTHOR_EMAIL = 'bot@mathu.local';
const GITHUB_API_BASE = 'https://api.github.com';
const HTTP_TIMEOUT_MS = 30 * 1000;

// Per-file SHA cache so we don't have to GET each file before every PUT.
// Keyed by repo-path (owner/repo/branch/path). Reset on branch change.
const _shaCache = new Map<string, string>();

// ─── Config resolution ────────────────────────────────────────────────────

function _resolveConfig(): ShipperConfig | null {
  const env = process.env;

  const token = env.GITHUB_LOGS_TOKEN || '';
  const owner = env.GITHUB_LOGS_OWNER || '';
  const repo = env.GITHUB_LOGS_REPO || '';

  if (!token || !owner || !repo) {
    // No-op mode — return null. The shipper will log this once and stay silent.
    return null;
  }

  // Resolve source files: explicit env, then LOG_DIR/daemon.log, then /tmp/mathu-logs/bot-stdout.log
  let sourceFiles: string[] = [];
  const explicitFiles = env.GITHUB_LOGS_SOURCE_FILE || '';
  if (explicitFiles) {
    sourceFiles = explicitFiles.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    const cfg = getCONFIG();
    const logDir = cfg.LOG_DIR || path.join(os.tmpdir(), 'mathu-bot-logs');
    const daemonLog = path.join(logDir, 'daemon.log');
    const runnerLog = '/tmp/mathu-logs/bot-stdout.log';
    // Always include daemon.log (the bot's structured log)
    sourceFiles.push(daemonLog);
    // Also include the runner's stdout capture if it exists (different process)
    sourceFiles.push(runnerLog);
  }

  const intervalRaw = parseInt(env.GITHUB_LOGS_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  const intervalMs = Math.max(MIN_INTERVAL_MS, isNaN(intervalRaw) ? DEFAULT_INTERVAL_MS : intervalRaw);

  const maxFileBytesRaw = parseInt(env.GITHUB_LOGS_MAX_FILE_BYTES || String(DEFAULT_MAX_FILE_BYTES), 10);
  const maxFileBytes = isNaN(maxFileBytesRaw) ? DEFAULT_MAX_FILE_BYTES : maxFileBytesRaw;

  return {
    token,
    owner,
    repo,
    branch: env.GITHUB_LOGS_BRANCH || DEFAULT_BRANCH,
    pathPrefix: (env.GITHUB_LOGS_PATH || DEFAULT_PATH_PREFIX).replace(/^\/+|\/+$/g, ''),
    sourceFiles,
    intervalMs,
    maxFileBytes,
    authorName: env.GITHUB_LOGS_AUTHOR_NAME || DEFAULT_AUTHOR_NAME,
    authorEmail: env.GITHUB_LOGS_AUTHOR_EMAIL || DEFAULT_AUTHOR_EMAIL,
  };
}

// ─── GitHub API helpers ──────────────────────────────────────────────────

/**
 * GitHub contents API: get the current SHA of a file (needed for updates).
 * Returns null if the file doesn't exist yet (404) — caller should PUT
 * without a SHA to create it.
 */
async function _getFileSha(cfg: ShipperConfig, repoPath: string): Promise<string | null> {
  // Check cache first
  const cacheKey = `${cfg.owner}/${cfg.repo}/${cfg.branch}/${repoPath}`;
  const cached = _shaCache.get(cacheKey);
  if (cached) return cached;

  const url = `${GITHUB_API_BASE}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(cfg.branch)}`;
  try {
    const res = await _githubFetch(cfg, url, { method: 'GET' });
    if (res.status === 404) {
      // File doesn't exist yet — will be created on PUT.
      return null;
    }
    if (!res.ok) {
      // Other error — log and assume file doesn't exist.
      log(`getFileSha(${repoPath}): HTTP ${res.status}`, 'DEBUG');
      return null;
    }
    const data: any = await res.json();
    const sha: string | null = data?.sha || null;
    if (sha) _shaCache.set(cacheKey, sha);
    return sha;
  } catch (err: any) {
    log(`getFileSha(${repoPath}) failed: ${err.message}`, 'DEBUG');
    return null;
  }
}

/**
 * GitHub contents API: create or update a file with a commit.
 */
async function _putFile(
  cfg: ShipperConfig,
  repoPath: string,
  content: string,
  commitMessage: string,
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const sha = await _getFileSha(cfg, repoPath);

  const url = `${GITHUB_API_BASE}/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(repoPath)}`;
  const body = {
    message: commitMessage,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: cfg.branch,
    committer: { name: cfg.authorName, email: cfg.authorEmail },
    author: { name: cfg.authorName, email: cfg.authorEmail },
    ...(sha ? { sha } : {}),
  };

  try {
    const res = await _githubFetch(cfg, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errText = '';
      try { errText = await res.text(); } catch { errText = '(unreadable)'; }
      // 409 = SHA mismatch (file changed since we last fetched). Invalidate
      // the cache and let the next push retry.
      if (res.status === 409) {
        const cacheKey = `${cfg.owner}/${cfg.repo}/${cfg.branch}/${repoPath}`;
        _shaCache.delete(cacheKey);
      }
      return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data: any = await res.json();
    const newSha: string | undefined = data?.content?.sha;
    if (newSha) {
      const cacheKey = `${cfg.owner}/${cfg.repo}/${cfg.branch}/${repoPath}`;
      _shaCache.set(cacheKey, newSha);
    }
    return { ok: true, sha: newSha };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Wrapper around fetch that injects auth + timeout + common headers.
 */
async function _githubFetch(cfg: ShipperConfig, url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${cfg.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mathu-bot-github-log-shipper/1.0',
  };
  if (init.headers) {
    // Merge caller-provided headers (e.g. Content-Type for PUT with body).
    const callerHeaders = init.headers as Record<string, string>;
    for (const k of Object.keys(callerHeaders)) {
      headers[k] = callerHeaders[k];
    }
  }

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Log file reading + chunking ─────────────────────────────────────────

/**
 * Read the tail of a log file, capped at maxBytes. Reads the LAST N bytes
 * (most recent logs) rather than the first — operators usually want to see
 * what's happening now, not what happened 6 hours ago.
 *
 * Returns null if the file doesn't exist or can't be read.
 */
function _readTail(filePath: string, maxBytes: number): { content: string; totalBytes: number; truncated: boolean } | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const totalBytes = stat.size;

    let content: string;
    let truncated = false;

    if (totalBytes > maxBytes) {
      // Read only the last maxBytes
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, totalBytes - maxBytes);
        content = buf.toString('utf8');
        // Drop partial first line (we likely started mid-line)
        const firstNewline = content.indexOf('\n');
        if (firstNewline > 0) content = content.slice(firstNewline + 1);
        truncated = true;
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }

    return { content, totalBytes, truncated };
  } catch (err: any) {
    log(`_readTail(${filePath}) failed: ${err.message}`, 'DEBUG');
    return null;
  }
}

// ─── Push orchestration ──────────────────────────────────────────────────

async function _pushOnce(): Promise<{ ok: boolean; bytesPushed: number; results: FilePushResult[] }> {
  if (!_config) return { ok: false, bytesPushed: 0, results: [] };

  const cfg = _config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-11-05T02-49-03
  const dateStr = timestamp.slice(0, 10); // 2026-11-05
  const results: FilePushResult[] = [];
  let totalBytes = 0;
  let allOk = true;

  for (const sourceFile of cfg.sourceFiles) {
    const read = _readTail(sourceFile, cfg.maxFileBytes);
    if (!read) {
      results.push({ file: sourceFile, ok: false, bytes: 0, error: 'file not readable' });
      allOk = false;
      continue;
    }

    // Build the repo path: <pathPrefix>/<date>/<basename>-<timestamp>.log
    const baseName = path.basename(sourceFile).replace(/[^a-zA-Z0-9._-]/g, '_');
    const repoPath = `${cfg.pathPrefix}/${dateStr}/${baseName.replace(/\.log$/, '')}-${timestamp}.log`;

    const commitMessage = `bot logs: ${baseName} @ ${timestamp} (${read.totalBytes} bytes${read.truncated ? ', tail only' : ''})`;

    const pushResult = await _putFile(cfg, repoPath, read.content, commitMessage);
    results.push({
      file: sourceFile,
      ok: pushResult.ok,
      bytes: read.content.length,
      error: pushResult.error,
      sha: pushResult.sha,
    });

    if (pushResult.ok) {
      totalBytes += read.content.length;
    } else {
      allOk = false;
    }
  }

  return { ok: allOk, bytesPushed: totalBytes, results };
}

async function _tick(): Promise<void> {
  if (!_config) return;
  try {
    _totalPushes++;
    const result = await _pushOnce();
    _lastPushAt = Date.now();
    _lastPushOk = result.ok;
    _lastPushBytes = result.bytesPushed;
    _totalBytesPushed += result.bytesPushed;

    if (result.ok) {
      _lastPushError = null;
      const summary = result.results.map(r => `${path.basename(r.file)}=${r.bytes}b`).join(' ');
      log(`Pushed ${result.bytesPushed} bytes (${summary})`, 'DEBUG');
    } else {
      _totalPushFailures++;
      const errs = result.results.filter(r => !r.ok).map(r => `${path.basename(r.file)}: ${r.error}`).join('; ');
      _lastPushError = errs;
      log(`Push partial/failed: ${errs}`, 'WARN');
    }
  } catch (err: any) {
    _totalPushFailures++;
    _lastPushOk = false;
    _lastPushError = err.message;
    logError('Push tick threw (best-effort)', err);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

function start(): void {
  if (_started) return;

  _config = _resolveConfig();
  if (!_config) {
  const cfg = _resolveConfig();
  if (!cfg) {
    _skippedNoConfig = true;
    if (!_firstStartLogged) {
      _firstStartLogged = true;
      log('Disabled — set GITHUB_LOGS_TOKEN, GITHUB_LOGS_OWNER, GITHUB_LOGS_REPO to enable', 'INFO');
    }
    // Even in disabled mode, mark as "started" so callers don't keep retrying.
    // The timer is just never set.
    _started = true;
    return;
  }

  _config = cfg;
  _started = true;
  _skippedNoConfig = false;
  log(
    `Started — pushing to github.com/${_config.owner}/${_config.repo}/tree/${_config.branch}/${_config.pathPrefix} every ${Math.round(_config.intervalMs / 1000)}s`,
    `Started — pushing to github.com/${cfg.owner}/${cfg.repo}/tree/${cfg.branch}/${cfg.pathPrefix} every ${Math.round(cfg.intervalMs / 1000)}s`,
    'INFO'
  );

  // First push after 30s (don't block startup)
  setTimeout(() => {
    _tick().catch(() => {});
    // Then on the regular interval
    _timer = setInterval(() => { _tick().catch(() => {}); }, _config.intervalMs);
    _timer = setInterval(() => { _tick().catch(() => {}); }, cfg.intervalMs);
    if (_timer.unref) _timer.unref();
  }, 30 * 1000);
}

function stop(): void {
  if (!_started) return;
  _started = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
  log('Stopped', 'INFO');
}

/**
 * Force an immediate push (e.g. before process exit). Returns the result.
 */
async function flushNow(): Promise<{ ok: boolean; bytesPushed: number; results: FilePushResult[] }> {
  if (!_config) return { ok: false, bytesPushed: 0, results: [] };
  return _pushOnce();
}

function getStatus(): ShipperStatus {
  const config = _config;
  return {
    enabled: !!config,
    started: _started,
    config: config ? {
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      pathPrefix: config.pathPrefix,
    } : null,
    sourceFiles: config?.sourceFiles || [],
    intervalMs: config?.intervalMs || 0,
    lastPushAt: _lastPushAt,
    lastPushOk: _lastPushOk,
    lastPushError: _lastPushError,
    totalPushes: _totalPushes,
    totalPushFailures: _totalPushFailures,
    totalBytesPushed: _totalBytesPushed,
    lastPushBytes: _lastPushBytes,
    skippedNoConfig: _skippedNoConfig,
  };
}

/**
 * Self-test — verifies the module's invariants hold. Does NOT make any
 * HTTP calls (the actual GitHub API is only exercised in production).
 */
function selfTest(): { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  checks.push({
    name: 'module_loads',
    ok: true,
  });

  // Config resolution doesn't throw
  try {
    _resolveConfig();
    checks.push({ name: 'resolveConfig_no_throw', ok: true });
  } catch (err: any) {
    checks.push({ name: 'resolveConfig_no_throw', ok: false, detail: err.message });
  }

  // If config IS set, validate the bits
  const cfg = _resolveConfig();
  if (cfg) {
    checks.push({
      name: 'interval_at_least_min',
      ok: cfg.intervalMs >= MIN_INTERVAL_MS,
      detail: `${cfg.intervalMs}ms`,
    });
    checks.push({
      name: 'max_file_bytes_under_100mb',
      ok: cfg.maxFileBytes <= 100 * 1024 * 1024,
      detail: `${cfg.maxFileBytes}b`,
    });
    checks.push({
      name: 'source_files_nonempty',
      ok: cfg.sourceFiles.length > 0,
    });
    checks.push({
      name: 'branch_name_valid',
      ok: /^[a-zA-Z0-9._/-]+$/.test(cfg.branch) && !cfg.branch.startsWith('.'),
      detail: cfg.branch,
    });
  } else {
    checks.push({
      name: 'disabled_when_no_config',
      ok: true,
      detail: 'no GITHUB_LOGS_* env vars set',
    });
  }

  // _readTail on a non-existent file returns null
  const read = _readTail('/nonexistent/path/file.log', 1024);
  checks.push({
    name: 'readTail_returns_null_on_missing',
    ok: read === null,
  });

  return { ok: checks.every(c => c.ok), checks };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  _injectDependencies,
  start,
  stop,
  flushNow,
  getStatus,
  selfTest,
};
