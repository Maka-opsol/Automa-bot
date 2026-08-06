// Resilience R16: No-Browser Fallback — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// browser-ghost-mode.ts — P3 No-Browser Fallback
// ═══════════════════════════════════════════════════════════════
// When the browser crashes 5+ times and can't recover (browser-phoenix
// declares unrecoverable), this module provides a minimal HTTP-based
// fallback. It can navigate, parse HTML, and submit forms — all
// without Playwright or a real browser.
//
// Features:
//   1. Navigate via HTTP GET requests
//   2. Parse HTML response for form elements (minimal parser)
//   3. Submit forms via HTTP POST
//   4. Very limited: no JavaScript, no screenshots, no rendering
//   5. Only activated when browser is truly unrecoverable
//
// Integration:
//   - cycle-cycle-manager.ts falls back to ghost mode when
//     browser-phoenix.ts declares unrecoverable
//   - render-free-plan.ts can use ghostNavigate for health checks
//
// WARNING: This is a LAST RESORT module. The bot's primary
// functionality requires JavaScript rendering. Ghost mode can
// only navigate to known endpoints and submit simple forms.
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'ghost-mode') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface GhostPage {
  url: string;
  html: string;
  statusCode: number;
  forms: GhostForm[];
  links: string[];
  title: string;
  timestamp: number;
}

interface GhostForm {
  action: string;
  method: string;
  inputs: { name: string; type: string; value: string }[];
}

// ─── State ───
let _isActive = false;
let _lastGhostPage: GhostPage | null = null;
let _totalGhostNavigations = 0;
let _totalGhostSubmissions = 0;
let _started = false;

// ─── Helpers ───

/**
 * Minimal HTML parser: extract forms and links.
 * No dependency on cheerio or any HTML parser library.
 */
function _parseHtml(html: string, baseUrl: string): {
  forms: GhostForm[];
  links: string[];
  title: string;
} {
  const forms: GhostForm[] = [];
  const links: string[] = [];
  let title = '';

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Extract forms
  const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
  let formMatch;
  while ((formMatch = formRegex.exec(html)) !== null) {
    const formHtml = formMatch[1];

    // Extract form action and method
    const actionMatch = formMatch[0].match(/action=["']([^"']*)["']/i);
    const methodMatch = formMatch[0].match(/method=["']([^"']*)["']/i);

    const action = actionMatch ? _resolveUrl(baseUrl, actionMatch[1]) : baseUrl;
    const method = (methodMatch ? methodMatch[1] : 'GET').toUpperCase();

    // Extract inputs
    const inputs: GhostForm['inputs'] = [];
    const inputRegex = /<input[^>]*>/gi;
    let inputMatch;
    while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
      const nameMatch = inputMatch[0].match(/name=["']([^"']*)["']/i);
      const typeMatch = inputMatch[0].match(/type=["']([^"']*)["']/i);
      const valueMatch = inputMatch[0].match(/value=["']([^"']*)["']/i);

      if (nameMatch) {
        inputs.push({
          name: nameMatch[1],
          type: typeMatch ? typeMatch[1] : 'text',
          value: valueMatch ? valueMatch[1] : '',
        });
      }
    }

    // Also extract textarea and select
    const textareaRegex = /<textarea[^>]*name=["']([^"']*)["'][^>]*>([\s\S]*?)<\/textarea>/gi;
    let textareaMatch;
    while ((textareaMatch = textareaRegex.exec(formHtml)) !== null) {
      inputs.push({
        name: textareaMatch[1],
        type: 'textarea',
        value: textareaMatch[2].trim(),
      });
    }

    if (inputs.length > 0) {
      forms.push({ action, method, inputs });
    }
  }

  // Extract links
  const linkRegex = /<a[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const href = linkMatch[1];
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push(_resolveUrl(baseUrl, href));
    }
  }

  return { forms, links, title };
}

/**
 * Resolve a relative URL against a base URL.
 */
function _resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ─── Core API ───

/**
 * Navigate to a URL using HTTP GET (no browser).
 *
 * @param url — The URL to navigate to
 * @param headers — Optional request headers
 * @returns GhostPage with parsed HTML, forms, and links
 */
async function ghostNavigate(url: string, headers?: Record<string, string>): Promise<GhostPage | null> {
  _isActive = true;
  _totalGhostNavigations++;

  log(`[GHOST] Navigating to: ${url}`, 'INFO');

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    };

    const response = await fetch(url, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });

    const html = await response.text();
    const parsed = _parseHtml(html, url);

    const page: GhostPage = {
      url: response.url || url,  // Follow redirects
      html,
      statusCode: response.status,
      forms: parsed.forms,
      links: parsed.links,
      title: parsed.title,
      timestamp: Date.now(),
    };

    _lastGhostPage = page;

    log(
      `[GHOST] Page loaded: ${page.title || '(no title)'} (${html.length} bytes, ${parsed.forms.length} forms, ${parsed.links.length} links)`,
      'INFO'
    );

    return page;
  } catch (err) {
    log(`[GHOST] Navigation failed: ${(err as Error).message}`, 'ERROR');
    return null;
  }
}

/**
 * Submit a form via HTTP POST (no browser).
 *
 * @param actionUrl — The form action URL
 * @param data — Form data as key-value pairs
 * @param method — HTTP method (default POST)
 * @returns GhostPage with response
 */
async function ghostSubmitForm(
  actionUrl: string,
  data: Record<string, string>,
  method: string = 'POST'
): Promise<GhostPage | null> {
  _isActive = true;
  _totalGhostSubmissions++;

  log(`[GHOST] Submitting form to: ${actionUrl} (${method})`, 'INFO');

  try {
    const isGet = method.toUpperCase() === 'GET';

    let url = actionUrl;
    const options: Record<string, any> = {
      method: method.toUpperCase(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    };

    if (isGet) {
      // Append data as query params
      const params = new URLSearchParams(data);
      url += (url.includes('?') ? '&' : '?') + params.toString();
    } else {
      // POST with form data
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(data).toString();
    }

    const response = await fetch(url, options);
    const html = await response.text();
    const parsed = _parseHtml(html, url);

    const page: GhostPage = {
      url: response.url || url,
      html,
      statusCode: response.status,
      forms: parsed.forms,
      links: parsed.links,
      title: parsed.title,
      timestamp: Date.now(),
    };

    _lastGhostPage = page;

    log(
      `[GHOST] Form submitted: ${page.title || '(no title)'} (status ${response.status})`,
      'INFO'
    );

    return page;
  } catch (err) {
    log(`[GHOST] Form submission failed: ${(err as Error).message}`, 'ERROR');
    return null;
  }
}

/**
 * Check if ghost mode is active.
 */
function isGhostModeActive(): boolean {
  return _isActive;
}

/**
 * Deactivate ghost mode (browser recovered).
 */
function deactivate(): void {
  _isActive = false;
  log('[GHOST] Ghost mode deactivated — browser recovered.', 'INFO');
}

/**
 * Get the last ghost page.
 */
function getLastPage(): GhostPage | null {
  return _lastGhostPage;
}

/**
 * Get diagnostic status.
 */
function getStatus(): {
  isActive: boolean;
  totalGhostNavigations: number;
  totalGhostSubmissions: number;
  lastPageUrl: string | null;
  lastPageTitle: string | null;
} {
  return {
    isActive: _isActive,
    totalGhostNavigations: _totalGhostNavigations,
    totalGhostSubmissions: _totalGhostSubmissions,
    lastPageUrl: _lastGhostPage?.url || null,
    lastPageTitle: _lastGhostPage?.title || null,
  };
}

/**
 * Start ghost mode monitoring.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log('[GHOST] Ghost mode ready (will activate on browser failure)', 'INFO');
}

module.exports = {
  _injectDependencies,
  ghostNavigate,
  ghostSubmitForm,
  isGhostModeActive,
  deactivate,
  getLastPage,
  getStatus,
  start,
};
