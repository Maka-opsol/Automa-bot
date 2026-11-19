import { createRequire } from 'node:module';
import { registerCase } from './test-pdf-vitest-adapter.js';

const require = createRequire(import.meta.url);
require('./test-pdf-error-diagnostics-cases.cjs')(registerCase);
