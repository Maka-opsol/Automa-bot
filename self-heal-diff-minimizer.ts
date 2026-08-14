'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const CONFIG = require('./get-config');

class DiffMinimizer {
  tempDir: any;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'mathu-diff-minimizer');
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (err: any) {
      logError('Failed to create diff-minimizer temp directory', err);
    }
  }

  async minimizePatch(originalCode: any, proposedPatch: any, targetFile: any) { 
    const startTime = Date.now();
    const originalLines = proposedPatch.split('\n').length;

    try {
      if (!originalCode || typeof originalCode !== 'string') {
        log('Invalid original code provided to minimizer', 'WARN', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines: originalLines, savedPercent: 0, reason: 'Invalid original code' };
      }

      if (!proposedPatch || typeof proposedPatch !== 'string') {
        log('Invalid proposed patch provided to minimizer', 'WARN', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines: originalLines, savedPercent: 0, reason: 'Invalid proposed patch' };
      }

      const targetFileName = targetFile || 'unknown.js';

      const prompt = [
        'You are a code diff minimizer. Given the original file and a complete rewrite/patch,',
        'produce the SMALLEST possible unified diff that achieves the same fix intent.',
        '',
        'Return ONLY the minimal unified diff, nothing else. No explanations, no markdown.',
        'Format:',
        '--- a/' + targetFileName,
        '+++ b/' + targetFileName,
        '@@ -line,count +line,count @@',
        ' context line',
        '-removed line',
        '+added line',
        '',
        '--- BEGIN ORIGINAL FILE ---',
        originalCode.substring(0, 8000),
        '--- END ORIGINAL FILE ---',
        '',
        '--- BEGIN PROPOSED PATCH ---',
        proposedPatch.substring(0, 8000),
        '--- END PROPOSED PATCH ---'
      ].join('\n');

      log(`Requesting diff minimization for ${targetFileName} (original: ${originalLines} lines)...`, 'INFO', 'diff-minimizer');

      let minimizedDiff = null;
      try {
        const { consultTribunalRaw } = require('./providers-codegen-tribunal');
        const signal = AbortSignal.timeout(120_000);
        const result = await consultTribunalRaw(prompt, signal, { responseFormatJson: false });
        if (result && result.trim().length > 0) {
          minimizedDiff = result.trim();
        }
      } catch (tribunalErr: any) {
        logError('Tribunal call failed for diff minimization, keeping original', tribunalErr);
        return { minimized: false, originalLines, minimizedLines: originalLines, savedPercent: 0, reason: 'Tribunal unavailable' };
      }

      if (!minimizedDiff || minimizedDiff.trim().length === 0) {
        log('No minimized diff returned, keeping original', 'WARN', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines: originalLines, savedPercent: 0, reason: 'Empty diff from tribunal' };
      }

      const minimizedLines = minimizedDiff.split('\n').length;

      if (minimizedLines >= originalLines) {
        log(`Minimized diff (${minimizedLines} lines) is not smaller than original (${originalLines} lines), keeping original`, 'INFO', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines, savedPercent: 0, reason: 'Minimized not smaller' };
      }

      const patchedContent = this.applyUnifiedDiff(originalCode, minimizedDiff);
      if (!patchedContent) {
        log('Failed to apply minimized diff, keeping original', 'WARN', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines, savedPercent: 0, reason: 'Diff application failed' };
      }

      const syntaxResult = await this.syntaxCheck(patchedContent, targetFileName);
      if (!syntaxResult.valid) {
        log(`Minimized patch failed syntax check: ${syntaxResult.error}, keeping original`, 'WARN', 'diff-minimizer');
        return { minimized: false, originalLines, minimizedLines, savedPercent: 0, reason: `Syntax check failed: ${syntaxResult.error}` };
      }

      const savedPercent = ((originalLines - minimizedLines) / originalLines * 100).toFixed(1);
      const elapsed = Date.now() - startTime;

      log(`Diff minimized for ${targetFileName}: ${originalLines} -> ${minimizedLines} lines (${savedPercent}% saved, ${elapsed}ms)`, 'INFO', 'diff-minimizer');

      return { minimized: true, originalLines, minimizedLines, savedPercent: parseFloat(savedPercent), minimizedPatch: minimizedDiff, patchedContent };
    } catch (err: any) {
      logError('Failed to minimize patch', err);
      return { minimized: false, originalLines, minimizedLines: originalLines, savedPercent: 0, reason: err.message };
    }
  }

  applyUnifiedDiff(originalContent: any, diffText: any) { 
    try {
      const originalLines = originalContent.split('\n');
      const result = [...originalLines];

      const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
      const diffLines = diffText.split('\n');

      let pos = 0;
      let i = 0;

      while (i < diffLines.length) {
        const line = diffLines[i];

        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
          i++;
          continue;
        }

        const hunkMatch = line.match(hunkRegex);
        if (hunkMatch) {
          pos = parseInt(hunkMatch[1], 10) - 1; // 0-indexed start position
          i++;
          continue;
        }

        if (line.startsWith('-')) {
          if (pos >= 0 && pos < result.length) {
            result.splice(pos, 1);
          }
          // Don't increment pos — splice shifted everything down
          i++;
          continue;
        }

        if (line.startsWith('+')) {
          result.splice(pos, 0, line.substring(1));
          pos++; // Advance past inserted line
          i++;
          continue;
        }

        if (line.startsWith(' ') || line === '') {
          // Context line — already in result, just advance
          pos++;
          i++;
          continue;
        }

        i++;
      }

      return result.join('\n');
    } catch (err: any) {
      logError('Failed to apply unified diff', err);
      return null;
    }
  }

  async syntaxCheck(code: any, _filePath: any) {
    try {
      if (!code || typeof code !== 'string') {
        return { valid: false, error: 'No code provided' };
      }

      const isTypeScript = _filePath && _filePath.endsWith('.ts');
      const ext = isTypeScript ? '.ts' : '.js';
      const tempFile = path.join(this.tempDir, `syntax-check-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`);

      try {
        fs.writeFileSync(tempFile, code, 'utf8');
        const { execFile } = require('child_process');
        await new Promise((resolve, reject) => {
          if (isTypeScript) {
            // For TypeScript: use npx tsc --noEmit for proper syntax checking.
            // Falls back to node --check if tsc is unavailable (catches JS-level syntax only).
            execFile('npx', ['tsc', '--noEmit', '--strict', '--allowJs', '--skipLibCheck', tempFile], { timeout: 15000 }, (err: any, stdout: any, stderr: any) => {
              if (err) {
                // tsc not available — fall back to node --check (will miss TS-specific syntax)
                execFile('node', ['--check', tempFile], { timeout: 10000 }, (nodeErr: any) => {
                  if (nodeErr) reject(nodeErr); else resolve(void 0);
                });
              } else {
                resolve(void 0);
              }
            });
          } else {
            execFile('node', ['--check', tempFile], { timeout: 10000 }, (err: any) => {
              if (err) reject(err); else resolve(void 0);
            });
          }
        });
        return { valid: true, error: null };
      } catch (execErr: any) {
        const error = (execErr.stderr || execErr.stdout || execErr.message || '').trim().substring(0, 300);
        return { valid: false, error };
      } finally {
        try { fs.unlinkSync(tempFile); } catch (cleanupErr: any) { /* ignore */ }
      }
    } catch (err: any) {
      logError('Syntax check error', err);
      return { valid: false, error: err.message };
    }
  }

  computeDiffStats(patchContent: any) { 
    try {
      if (!patchContent || typeof patchContent !== 'string') {
        return { added: 0, removed: 0, unchanged: 0 };
      }
      const lines = patchContent.split('\n');
      let added = 0;
      let removed = 0;
      let unchanged = 0;

      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          added++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          removed++;
        } else if (line.startsWith(' ')) {
          unchanged++;
        }
      }

      return { added, removed, unchanged, total: added + removed + unchanged };
    } catch (err: any) {
      return { added: 0, removed: 0, unchanged: 0 };
    }
  }
}

const diffMinimizer = new DiffMinimizer();

module.exports = {
  diffMinimizer,
  DiffMinimizer,
  minimizePatch: (original: any, patch: any, target: any) => diffMinimizer.minimizePatch(original, patch, target),
  applyUnifiedDiff: (original: any, diff: any) => diffMinimizer.applyUnifiedDiff(original, diff),
  syntaxCheck: (code: any, filePath: any) => diffMinimizer.syntaxCheck(code, filePath),
  computeDiffStats: (patch: any) => diffMinimizer.computeDiffStats(patch),
  _injectDependencies,
};
