#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// build.js — Compile all .ts files to dist/ using esbuild
// ═══════════════════════════════════════════════════════════════════════════
// Uses esbuild's transformSync() per-file instead of build().
// The build() API treats files with "export" keywords as ESM, which conflicts
// with "module.exports" at the bottom. transformSync() just strips TypeScript
// syntax without ESM/CJS detection — exactly what tsx does at runtime.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    console.error('ERROR: esbuild not found. Make sure tsx is installed (npm install).');
    process.exit(1);
  }

  // Find all .ts files in the project root (flat structure).
  const allFiles = fs.readdirSync('.')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .filter(f => f !== 'build.js');

  console.log(`Building ${allFiles.length} .ts files to dist/ using esbuild transformSync...`);

  const distDir = path.join('.', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  let success = 0;
  let failed = 0;
  const errors = [];

  for (const file of allFiles) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      // transformSync just strips TypeScript types — no ESM/CJS detection.
      // This is exactly what tsx does at runtime.
      const result = esbuild.transformSync(source, {
        loader: 'ts',           // TypeScript loader
        target: 'node20',       // Node.js 20.x
        format: 'cjs',           // Force CommonJS output
        sourcemap: false,        // No source maps (saves memory at runtime)
      });

      const outFile = path.join(distDir, file.replace(/\.ts$/, '.js'));
      fs.writeFileSync(outFile, result.code);
      success++;
    } catch (e) {
      failed++;
      errors.push({ file, error: e.message || String(e) });
    }
  }

  console.log(`Build complete. ${success} files compiled, ${failed} failed.`);

  if (errors.length > 0) {
    console.error('\nBuild errors:');
    for (const e of errors.slice(0, 20)) {
      console.error(`  ${e.file}: ${e.error.substring(0, 200)}`);
    }
    if (errors.length > 20) {
      console.error(`  ... and ${errors.length - 20} more errors`);
    }
    process.exit(1);
  }

  if (success === 0) {
    console.error('ERROR: No files compiled successfully.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Build failed:', err.message || err);
  process.exit(1);
});
