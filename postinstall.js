'use strict';

// ─── MathU Bot v6 — Postinstall Script (Render Free Plan Optimized) ─────
// Steps:
//   1. Verify better-sqlite3 loads (native module)
//   2. Try prebuild-install for better-sqlite3 (avoids compilation on low-memory)
//   3. If native compilation is needed, ensure build tools are present
//   4. Install Playwright Chromium (SKIPPED if PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)
//
// Render free plan notes:
//   - 512 MB RAM, no persistent disk
//   - Playwright Chromium installed to node_modules (part of deploy, not runtime)
//   - better-sqlite3 prefers prebuilt binaries to avoid OOM during compilation

const { execSync } = require('child_process');
const path = require('path');

function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, {
      stdio: 'pipe',
      timeout: 120_000,
      encoding: 'utf8',
      ...opts,
    });
    return { ok: true, stdout: (result || '').trim() };
  } catch (err) {
    return { ok: false, code: err.status, stderr: (err.stderr || '').trim() };
  }
}

// ─── Step 1: Verify better-sqlite3 loads ─────────────────────────────────────
console.log('[postinstall] Step 1/4: Checking better-sqlite3...');
let sqlite3Loaded = false;
try {
  require('better-sqlite3');
  sqlite3Loaded = true;
  console.log('[postinstall]   better-sqlite3 loaded successfully.');
} catch (e) {
  console.error('[postinstall]   better-sqlite3 failed to load:', e.message);
}

// ─── Step 2: Try prebuild-install (avoids native compilation on low-memory) ─
if (!sqlite3Loaded) {
  console.log('[postinstall] Step 2/4: Trying prebuilt binaries for better-sqlite3...');
  const prebuilt = run('npx --yes prebuild-install --runtime napi -d 2>&1', { cwd: path.join(__dirname, 'node_modules', 'better-sqlite3') });
  if (prebuilt.ok) {
    console.log('[postinstall]   Prebuilt binary installed successfully.');
    try {
      delete require.cache[require.resolve('better-sqlite3')];
      require('better-sqlite3');
      sqlite3Loaded = true;
      console.log('[postinstall]   better-sqlite3 now loads with prebuilt binary.');
    } catch (_) {
      console.warn('[postinstall]   Prebuilt binary installed but module still fails to load.');
    }
  } else {
    console.warn('[postinstall]   No prebuilt binary available for this platform.');
  }
}

// ─── Step 3: Ensure build tools if native compilation is needed ──────────────
if (!sqlite3Loaded) {
  console.log('[postinstall] Step 3/4: Ensuring native build tools are available...');
  console.error('FATAL: better-sqlite3 requires native compilation.');
  console.error('On Debian/Ubuntu: sudo apt-get install python3 make g++');
  console.error('On Alpine:      sudo apk add python3 make g++');

  const aptResult = run('apt-get install -y python3 make g++ 2>/dev/null');
  if (aptResult.ok) {
    console.log('[postinstall]   Installed build tools via apt-get.');
  } else {
    const apkResult = run('apk add --no-cache python3 make g++ 2>/dev/null');
    if (apkResult.ok) {
      console.log('[postinstall]   Installed build tools via apk.');
    } else {
      console.warn('[postinstall]   Native build tools not found automatically.');
    }
  }

  console.log('[postinstall]   Rebuilding better-sqlite3...');
  const rebuild = run('npm rebuild better-sqlite3 2>&1', { timeout: 180_000 });
  if (rebuild.ok) {
    try {
      delete require.cache[require.resolve('better-sqlite3')];
      require('better-sqlite3');
      sqlite3Loaded = true;
      console.log('[postinstall]   better-sqlite3 rebuilt and loads successfully.');
    } catch (_) {
      console.error('[postinstall]   Rebuild completed but better-sqlite3 still fails to load.');
    }
  } else {
    console.error('[postinstall]   Rebuild failed:', rebuild.stderr);
  }
}

if (!sqlite3Loaded) {
  console.error('[postinstall]   better-sqlite3 is NOT available. The bot will not start correctly.');
  process.exit(1);
}

// ─── Step 4: Install Playwright Chromium ─────────────────────────────────────
// On Render, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is set during buildCommand,
// so we install Chromium here (after npm install is done and memory is freed).
// Render's build environment has more memory available after the main install.
const skipBrowser = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1';
if (skipBrowser) {
  console.log('[postinstall] Step 4/4: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 detected.');
  console.log('[postinstall]   Installing Playwright Chromium now (post-npm-install)...');
  
  // Clear the flag so the install proceeds
  delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  
  const pwResult = run('npx playwright install chromium 2>&1', { timeout: 300_000 });
  if (!pwResult.ok) {
    console.warn('[postinstall]   Chromium install failed, trying with --with-deps...');
    const pwFallback = run('npx playwright install chromium --with-deps 2>&1', { timeout: 300_000 });
    if (!pwFallback.ok) {
      console.warn('[postinstall]   Chromium install with deps also failed.');
      console.warn('[postinstall]   Attempting system deps install then retry...');
      const depsResult = run('npx playwright install-deps chromium 2>&1', { timeout: 300_000 });
      if (!depsResult.ok) {
        console.warn('[postinstall]   System deps install failed too.');
      }
      const pwRetry = run('npx playwright install chromium 2>&1', { timeout: 300_000 });
      if (!pwRetry.ok) {
        console.warn('[postinstall]   All Chromium install attempts failed.');
        console.warn('[postinstall]   The bot may still work if Chromium is pre-installed.');
      }
    }
  }
} else {
  console.log('[postinstall] Step 4/4: Installing Playwright Chromium...');
  const pwResult = run('npx playwright install chromium --with-deps 2>&1', { timeout: 300_000 });
  if (!pwResult.ok) {
    console.warn('[postinstall]   Chromium install with deps failed, trying without --with-deps...');
    const pwFallback = run('npx playwright install chromium 2>&1', { timeout: 300_000 });
    if (!pwFallback.ok) {
      console.warn('[postinstall]   Chromium install failed. The bot may still work if Chromium is already installed.');
    }
  }
}

console.log('[postinstall] All steps completed.');
