// Opt-in, read-only diagnostics. Never emit inputs from the page or raw errors.
// Budgets are per Page lifetime; there are no timers and no navigation or clicks.
export function attachRenderSignals(page: any, workerId: number, log: any, appUrl: string): { sample: (reason: string) => void } {
  let errors = 0;
  let samples = 0;
  const seen = new Set<string>();
  const safeId = Number.isSafeInteger(workerId) && workerId >= 0 && workerId <= 999 ? workerId : 0;
  function emit(body: string) {
    try { log(`[WORKER-${safeId}] [render-signal] ${body}`, 'DEBUG', 'parallel'); } catch {}
  }
  function source(error: any): string {
    try {
      const app = new URL(appUrl);
      if (!['http:', 'https:'].includes(app.protocol)) return 'unknown';
      const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 16384) : '';
      // Only the first parseable HTTP(S) stack frame is attributed. Nothing is emitted verbatim.
      for (const line of stack.split('\n').slice(1, 41)) {
        const match = line.match(/https?:\/\/[^\s)\]]+?:\d{1,9}:\d{1,9}(?=\)|\s|$)/i);
        if (!match) continue;
        const parsed = new URL(match[0].replace(/:\d{1,9}:\d{1,9}$/, ''));
        return parsed.origin === app.origin ? 'app' : 'foreign';
      }
    } catch {}
    return 'unknown';
  }
  try {
    page.on('pageerror', (error: any) => {
      try {
        if (errors >= 4) return;
        errors++;
        const kind = error?.message === 'pdfjsLib is not defined' ? 'pdf-reference' : 'other';
        emit(`page-error kind=${kind} source=${source(error)}`);
      } catch {}
    });
  } catch {}
  function sample(reason: string): void {
    // One per checkpoint, three total, per page; no retries and no periodic polling.
    if (!['render', 'cards-empty', 'card-inspection-failed'].includes(reason) || seen.has(reason) || samples >= 3) return;
    seen.add(reason); samples++;
    try {
      Promise.resolve(page.evaluate(() => {
        // Only fixed selectors and counts; no text, attributes, source URLs or pixels.
        const cap = (n: number) => Math.min(n, 100);
        const r = { ready: 'unknown', frame: 0, frameReadable: 0, frameUnreadable: 0,
          frameComplete: 0, canvas: 0, canvasNonzero: 0, shadowOpen: 0,
          cardsTop: 0, cardsShadow: 0, cardsFrame: 0, nodesCapped: 0 };
        if (['loading', 'interactive', 'complete'].includes(document.readyState)) r.ready = document.readyState;
        const roots: Array<{root: any; area: string}> = [{root: document, area: 'top'}];
        let visited = 0;
        while (roots.length && visited < 1500) {
          const entry = roots.shift()!;
          const walker = document.createTreeWalker(entry.root, NodeFilter.SHOW_ELEMENT);
          let el: any;
          while (visited < 1500 && (el = walker.nextNode())) {
            visited++;
            if (el.matches('[class*="card"], [role="listitem"], .module-card')) {
              if (entry.area === 'top') r.cardsTop = cap(r.cardsTop + 1);
              else if (entry.area === 'shadow') r.cardsShadow = cap(r.cardsShadow + 1);
              else r.cardsFrame = cap(r.cardsFrame + 1);
            }
            if (el.localName === 'canvas') {
              r.canvas = cap(r.canvas + 1);
              if (el.width > 0 && el.height > 0) r.canvasNonzero = cap(r.canvasNonzero + 1);
            }
            if (el.shadowRoot) {
              r.shadowOpen = cap(r.shadowOpen + 1);
              if (roots.length < 1500) roots.push({root: el.shadowRoot, area: entry.area === 'frame' ? 'frame' : 'shadow'});
            }
            if (el.localName === 'iframe') {
              r.frame = cap(r.frame + 1);
              try {
                const doc = el.contentDocument;
                if (!doc) r.frameUnreadable = cap(r.frameUnreadable + 1);
                else {
                  r.frameReadable = cap(r.frameReadable + 1);
                  if (doc.readyState === 'complete') r.frameComplete = cap(r.frameComplete + 1);
                  if (roots.length < 1500) roots.push({root: doc, area: 'frame'});
                }
              } catch { r.frameUnreadable = cap(r.frameUnreadable + 1); }
            }
          }
        }
        if (visited >= 1500 || roots.length) r.nodesCapped = 1;
        return r;
      })).then((r: any) => {
        try {
          const ready = ['loading', 'interactive', 'complete'].includes(r?.ready) ? r.ready : 'unknown';
          const keys = ['frame', 'frameReadable', 'frameUnreadable', 'frameComplete', 'canvas', 'canvasNonzero', 'shadowOpen', 'cardsTop', 'cardsShadow', 'cardsFrame', 'nodesCapped'];
          if (!keys.every(k => Number.isInteger(r?.[k]) && r[k] >= 0 && r[k] <= (k === 'nodesCapped' ? 1 : 100))) throw new Error();
          emit(`snapshot checkpoint=${reason} result=ok ready=${ready} ` + keys.map(k => `${k}=${r[k]}`).join(' '));
        } catch { emit(`snapshot checkpoint=${reason} result=error`); }
      }).catch(() => emit(`snapshot checkpoint=${reason} result=error`));
    } catch { emit(`snapshot checkpoint=${reason} result=error`); }
  }
  return { sample };
}
