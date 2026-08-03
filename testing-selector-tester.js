const { sleep } = require('./utils-sleep');
const { chromium } = require('playwright');
const selectorManager = require('./selectors');
const { log, safeLog, logError } = require('./logger');

async function testSelectors(componentName, url) {
  log(`🧪 Testing selectors for ${componentName}...`, 'INFO', 'selector-tester');
  const selectors = selectorManager.getSelectors(componentName);
  const results = {
    component: componentName,
    version: selectors.version,
    url,
    testedAt: new Date().toISOString(),
    results: []
  };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    for (const [name, selector] of Object.entries(selectors.selectors)) {
      const startTime = Date.now();
      try {
        const element = await page.$(selector);
        const duration = Date.now() - startTime;
        results.results.push({ name, selector, found: !!element, duration, status: element ? 'pass' : 'fail' });
      } catch (err) {
        results.results.push({ name, selector, found: false, error: err.message, duration: Date.now() - startTime, status: 'error' });
      }
    }
  } finally { await browser.close(); }
  const passed = results.results.filter(r => r.status === 'pass').length;
  const total = results.results.length;
  log(`✅ Selector test complete: ${passed}/${total} passed`, 'INFO', 'selector-tester');
  return results;
}

module.exports = { testSelectors };

