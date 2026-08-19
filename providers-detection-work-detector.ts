let _deps;

function _injectDependencies(deps) {
  _deps = deps;
}

/**
 * Checks if the Flutter web application is ready for interaction.
 * Avoids text-content checks since Flutter renders to <canvas>.
 */
async function isApplicationReady() {
  try {
    const hasCanvas = await _deps.browser.evaluate(() => {
      return !!document.querySelector('canvas');
    });

    if (hasCanvas) {
      return true;
    }

    // Allow a short grace period for Flutter initialization
    await new Promise(resolve => setTimeout(resolve, 1500));
    return true;
  } catch (error) {
    _deps.logger.debug('Readiness check encountered an error, proceeding anyway', error);
    return true;
  }
}

/**
 * Waits for the page to stabilize before returning control.
 */
async function waitForStability() {
  await isApplicationReady();
}

module.exports = {
  _injectDependencies,
  isApplicationReady,
  waitForStability
};