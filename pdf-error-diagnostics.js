'use strict';

// Only emit a coarse origin category, never source identifiers, locations,
// page URLs, paths, query parameters, fragments, credentials, or raw stacks.

function pdfErrorSource(error, pageUrl) {
  try {
    if (!error || error.message !== 'pdfjsLib is not defined') return '';
    const stack = typeof error.stack === 'string' ? error.stack.slice(0, 16384) : '';
    const frames = stack.split('\n').slice(1, 41);
    for (const frame of frames) {
      const match = frame.match(/https?:\/\/[^\s)\]]+?:(\d{1,9}):(\d{1,9})(?:\)|\s|$)/i);
      if (!match) continue;
      let url;
      try {
        const raw = match[0].replace(/:\d{1,9}:\d{1,9}(?:\)|\s)?$/, '');
        url = new URL(raw);
      } catch {
        // A malformed frame must not hide a later usable frame.
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      let origin = 'unknown-origin';
      try {
        const page = new URL(pageUrl);
        if (page.protocol === 'http:' || page.protocol === 'https:') {
          origin = url.origin === page.origin ? 'same-origin' : 'external-origin';
        }
      } catch {}
      return ` [pdf-source ${origin}]`;
    }
    return ' [pdf-source unavailable]';
  } catch {
    // Diagnostics must never interfere with the page-error listener.
    return ' [pdf-source unavailable]';
  }
}

module.exports = { pdfErrorSource };
