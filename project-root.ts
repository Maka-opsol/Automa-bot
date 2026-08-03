'use strict';

/**
 * Project root directory — works identically in both tsx and tsc-compiled modes.
 *
 * - In tsx mode: __dirname is the project root (all .ts files are there).
 * - In compiled mode: __dirname is dist/, so we go up one level.
 *
 * process.cwd() is the most reliable cross-mode solution because:
 *   1. npm start / start:tsx always runs from the project root.
 *   2. It doesn't depend on file layout.
 *   3. It works for workers, subprocesses, and the main process.
 *
 * This module has ZERO project dependencies — it only uses Node.js built-ins.
 */
const path = require('path');
const PROJECT_ROOT: string = process.cwd();

module.exports = { PROJECT_ROOT };
