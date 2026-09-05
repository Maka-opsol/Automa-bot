#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// build.js — Compile all .ts files to dist/ using esbuild
// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX (2026-09-04): tsc fails with hundreds of "Cannot redeclare block-
// scoped variable" errors because the codebase was written for tsx (which
// transpiles each file independently). tsc compiles all 236 .ts files as ONE
// program — when multiple files declare `const fs = require('fs')` at the top
// level, tsc treats them as being in the same scope.
//
// esbuild transpiles each file independently (like tsx does) — no cross-file
// type checking, no redeclaration errors. It's also ~100x faster than tsc.
//
// esbuild is available as a transitive dependency of tsx (which is in
// package.json dependencies). We use the JS API (require('esbuild')) so we
// don't depend on the CLI binary being in PATH.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    console.error('ERROR: esbuild not found. Make sure tsx is installed (npm install).');
    console.error('esbuild comes as a transitive dependency of tsx.');
    process.exit(1);
  }

  // Find all .ts files in the project root (flat structure — no subdirectories).
  // Exclude test files, declaration files, and this build script itself.
  const allFiles = fs.readdirSync('.')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter(f => !f.endsWith('.test.ts'))
    .filter(f => f !== 'build.js');

  console.log(`Building ${allFiles.length} .ts files to dist/ using esbuild...`);

  // Create dist/ directory
  const distDir = path.join('.', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Use esbuild's build API to transpile all files.
  // Each file is transpiled independently — no cross-file type checking.
  // This is equivalent to what tsx does at runtime, but at build time.
  const result = await esbuild.build({
    entryPoints: allFiles,
    outdir: distDir,
    format: 'cjs',           // CommonJS (require/module.exports)
    platform: 'node',        // Target Node.js
    target: 'node20',        // Node.js 20.x
    sourcemap: false,        // No source maps (saves memory at runtime)
    logLevel: 'warning',     // Only show warnings and errors
    write: true,             // Write output files directly
    // Don't bundle — each file stays separate. require('./...') calls
    // work at runtime just like they do with tsx.
    bundle: false,
  });

  if (result.warnings && result.warnings.length > 0) {
    console.log(`${result.warnings.length} warnings (non-fatal)`);
  }

  // Verify output
  const outputFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
  console.log(`Build complete. ${outputFiles.length} files compiled to dist/`);

  if (outputFiles.length === 0) {
    console.error('ERROR: No output files generated. Check for esbuild errors above.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Build failed:', err.message || err);
  if (err.errors) {
    for (const e of err.errors) {
      console.error(`  ${e.text} (${e.location?.file}:${e.location?.line}:${e.location?.column})`);
    }
  }
  process.exit(1);
});
