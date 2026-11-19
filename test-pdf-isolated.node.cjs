'use strict';
// Standalone offline runner: node --test test-pdf-isolated.node.cjs
const test = require('node:test');
require('./test-pdf-error-diagnostics-cases.cjs')(test);
require('./test-pdf-listener-cases.cjs')(test);
require('./test-pdf-build-compatibility-cases.cjs')(test);
