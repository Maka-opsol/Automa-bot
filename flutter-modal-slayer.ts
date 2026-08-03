'use strict';
const { sleep } = require('./utils-sleep');
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getFlutterTap() { return _deps.browser?.flutterTap; }

const { log, logError } = require('./logger');
class FlutterModalSlayer {
  async dismissAnyModal(page: any) { 
    try {
      const dialogLoc = page.locator('[role="dialog"], [role="alertdialog"]');
      if (await dialogLoc.count() === 0) return false;
      log(`🔍 Found modal(s) to dismiss.`, 'DEBUG', 'modal');

      // Try close/dismiss/cancel button via locator
      const closeBtn = dialogLoc.locator('button:has-text("close"), button:has-text("Close"), button:has-text("dismiss"), button:has-text("Dismiss"), button:has-text("cancel"), button:has-text("Cancel"), [aria-label*="close" i], [aria-label*="dismiss" i]').first();
      if (await closeBtn.count() > 0) {
        const box = await closeBtn.boundingBox();
        if (box) { await getFlutterTap()?.(page, box.x + box.width / 2, box.y + box.height / 2); log('✅ Dismissed modal via close button.', 'INFO', 'modal'); await sleep(500); return true; }
      }

      // Try backdrop click
      const backdrop = await page.$('[role="presentation"], .modal-backdrop, .dialog-backdrop');
      if (backdrop) {
        const box = await backdrop.boundingBox();
        if (box) { await getFlutterTap()?.(page, box.x + 10, box.y + 10); log('✅ Dismissed modal via backdrop click.', 'INFO', 'modal'); await sleep(500); return true; }
      }

      // Fallback: Escape key
      await page.keyboard.press('Escape');
      log('✅ Sent Escape key to dismiss modal.', 'INFO', 'modal');
      await sleep(500);
      return true;
    } catch (e: any) { logError('Modal slayer failed', e); return false; }
  }
}

module.exports = Object.assign(new FlutterModalSlayer(), { _injectDependencies });
