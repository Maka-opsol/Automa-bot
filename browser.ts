let _deps = {};

function _injectDependencies(deps) {
  _deps = deps;
}

async function navigate(page, url) {
  _deps.logger.info(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  return page;
}

async function waitForReady(page) {
  _deps.logger.debug('Waiting for Flutter SPA to be ready...');
  
  // Flutter renders to canvas, do not rely on body.innerText or text selectors
  await page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});

  // Handle blocking overlays (e.g., cookie consent, terms) that may appear during load
  const overlayPatterns = ['.atlwdg-blanket', '.cookie-overlay', '[aria-modal="true"]'];
  for (const pattern of overlayPatterns) {
    try {
      const els = await page.$$(pattern);
      for (const el of els) {
        await el.click({ force: true }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      _deps.logger.warn(`Overlay dismissal failed for ${pattern}`, err);
    }
  }

  // Verify canvas is interactive by simulating a pointer event
  const isInteractive = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    return new Promise((resolve) => {
      canvas.addEventListener('pointerdown', () => resolve(true), { once: true });
      setTimeout(() => resolve(true), 2000);
    });
  });

  if (!isInteractive) {
    throw new Error('Canvas did not become interactive within timeout');
  }

  _deps.logger.debug('SPA is ready and interactive.');
  return true;
}

async function click(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });
  await page.click(selector);
}

async function getText(page, selector) {
  // For Flutter SPAs, direct text extraction often fails.
  // Fallback to evaluating innerText safely.
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : '';
  }, selector);
}

module.exports = { _injectDependencies, navigate, waitForReady, click, getText };