'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

async function trackModuleProgress(page: any, screenshotBase64: any) {
  let completed = false;
  try {
    const progress = await page.evaluate(() => {
      const progressBar = document.querySelector('[role="progressbar"], .progress-bar, .module-progress');
      if (progressBar) {
        const style = window.getComputedStyle(progressBar);
        const width = parseFloat(style.width) || 0;
        const parentWidth = progressBar.parentElement ? parseFloat(window.getComputedStyle(progressBar.parentElement).width) : 100;
        if (parentWidth > 0 && width / parentWidth >= 0.99) return true;
      }
      const text = document.body.innerText;
      if (text.includes('100%') || text.includes('Completed') || text.includes('Done')) return true;
      return false;
    });
    if (progress) completed = true;
  } catch (_e: any) { /* non-critical, suppressed */ }
  if (!completed) {
    const visionResult = _deps.providers?.checkModuleCompletionViaVision?.(screenshotBase64);
    if (visionResult === true) completed = true;
  }
  if (completed) {
    const moduleName = await page.evaluate(() => {
      const header = document.querySelector('.module-header, .card-header, h2');
      return header ? header.textContent.trim() : 'Unknown Module';
    });
    if (moduleName && moduleName !== 'Unknown Module' && !_deps.cache?.isModuleCompleted?.(moduleName)) {
      _deps.cache?.addCompletedModule?.(moduleName);
      log(`🎉 Module "${moduleName}" completed.`, 'INFO', 'module-tracking');
    }
  }
}

module.exports = { trackModuleProgress, _injectDependencies };
