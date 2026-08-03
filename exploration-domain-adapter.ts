'use strict';
const { sleep } = require('./utils-sleep');
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSm() { return _deps.stateMachine; }
function getSTATES() { return _deps.stateMachine?.STATES; }
function getFlutterTap() { return _deps.browser?.flutterTap; }
function getInsertExplorationMap() { return _deps.database?.insertExplorationMap; }
function getGetExplorationMaps() { return _deps.database?.getExplorationMaps; }


const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const MAX_EXPLORATION_DEPTH = 10;
const MAX_ELEMENTS_PER_PAGE = 30;

class DomainAdapter {
  maps: any;
  url: any;
  state: any;
  depth: any;
  completedAt: any;
  path: any;

  constructor() {
    this.maps = new Map();
    this.loadMaps();
  }

  loadMaps() { 
    try {
      const maps = getGetExplorationMaps()?.all(10);
      for (const map of maps) {
        try {
          const data = JSON.parse(map.map);
          this.maps.set(map.state, data);
        } catch (_e: any) { /* non-critical, suppressed */ }
      }
      log(`Loaded ${this.maps.size} exploration maps`, 'DEBUG', 'domain-adapter');
    } catch (err: any) {
      logError('Failed to load exploration maps', err);
    }
  }

  async explore(page: any, maxDepth = MAX_EXPLORATION_DEPTH) { 
    log('🗺️ Starting domain exploration...', 'INFO', 'domain-adapter');
    const startUrl = page.url();
    const startState = this.detectState(startUrl);
    const map = {
      states: [startState],
      transitions: [],
      elements: {},
      startUrl,
      timestamp: Date.now(),
    };
    const visited = new Set();
    const queue = [{ url: startUrl, state: startState, depth: 0 }];
    while (queue.length > 0 && queue[0].depth < maxDepth) {
      const { url, state, depth } = queue.shift() as any;
      if (visited.has(url)) continue;
      visited.add(url);
      if (page.url() !== url) {
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (e: any) { continue; }
        await sleep(2000);
      }
      const elements = await this.getInteractiveElements(page);
      (map.elements as any)[state] = elements;
      for (const el of elements.slice(0, MAX_ELEMENTS_PER_PAGE)) {
        if (this.isDangerousAction(el.text)) continue;
        const beforeUrl = page.url();
        try {
          await getFlutterTap()?.(page, el.x, el.y);
          await sleep(2000);
          const afterUrl = page.url();
          if (afterUrl !== beforeUrl) {
            const newState = this.detectState(afterUrl);
            if (!map.states.includes(newState)) {
              map.states.push(newState);
            }
            (map.transitions as any[]).push({ from: state, to: newState, trigger: el.text, selector: el.selector });
            if (!visited.has(afterUrl) && depth + 1 < maxDepth) {
              queue.push({ url: afterUrl, state: newState, depth: depth + 1 });
            }
            await page.goBack();
            await sleep(2000);
          }
        } catch (err: any) {
          logError(`Exploration action failed: ${el.text}`, err);
        }
      }
    }
    (map as any).completedAt = Date.now();
    getInsertExplorationMap()?.run(startState, JSON.stringify(map), Date.now());
    this.maps.set(startState, map);
    this.updateStateMachine(map);
    log(`Exploration complete: ${map.states.length} states, ${map.transitions.length} transitions`, 'INFO', 'domain-adapter');
    return map;
  }

  async getInteractiveElements(page: any) { 
    try {
      const elements = await page.evaluate(() => {
        const all = document.querySelectorAll('button, a, input, [role="button"], [role="link"], .clickable, [tabindex]');
        const results: any[] = [];
        const seen = new Set();
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          const text = el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName;
          const key = `${text}_${rect.x}_${rect.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text: text.trim().substring(0, 50),
            tag: el.tagName,
            selector: el.id ? `#${el.id}` : typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0].replace(/^[0-9]+/, (m: any) => m.split('').map((c: any) => '\\3' + c.charCodeAt(0).toString(16) + ' ').join(''))}` : el.tagName,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
        }
        return results;
      });
      return elements;
    } catch (err: any) {
      logError('Failed to get interactive elements', err);
      return [];
    }
  }

  detectState(url: any) { 
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      if (path.includes('/assignments')) return 'assignments_page';
      if (path.includes('/video')) return 'video_player';
      if (path.includes('/exercise')) return 'exercise_info';
      if (path.includes('/assessment')) return 'assessment';
      if (path.includes('/score')) return 'score_screen';
      if (path.includes('/pathway')) return 'pathway';
      if (path.includes('/login')) return 'mathu_login';
      if (urlObj.hostname.includes('microsoftonline.com')) return 'microsoft_email_input';
      return `explored_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    } catch (err: any) {
      return 'unknown';
    }
  }

  isDangerousAction(text: any) { 
    const dangerous = ['logout', 'sign out', 'delete', 'remove', 'cancel account', 'deactivate'];
    const lower = text.toLowerCase();
    return dangerous.some(d => lower.includes(d));
  }

  updateStateMachine(map: any) { 
    for (const state of map.states) {
// @ts-expect-error
      if (!Object.values(STATES).includes(state)) {
        getSm()?.addState(state, []);
        log(`Added new state: ${state}`, 'INFO', 'domain-adapter');
      }
    }
    for (const trans of map.transitions) {
      if (!getSm()?.isValidTransition(trans.from, trans.to)) {
        const current = getSm()?.getValidNextStates(trans.from);
        if (!current.includes(trans.to)) {
          current.push(trans.to);
          getSm()?.updateTransitions({ [trans.from]: current });
          log(`Added transition: ${trans.from} -> ${trans.to}`, 'INFO', 'domain-adapter');
        }
      }
    }
  }

  getMap(state: any) { 
    return this.maps.get(state) || null;
  }

  getMapForUrl(url: any) { 
    const state = this.detectState(url);
    return this.getMap(state);
  }

  findPath(fromState: any, toState: any) { 
    // Collect ALL transitions from ALL maps for cross-map path finding
    const allTransitions: any[] = [];
    for (const [, map] of this.maps) {
      if (map.transitions) allTransitions.push(...map.transitions);
    }
    const MAX_BFS_NODES = 500;
    const visited = new Set();
    const queue = [{ state: fromState, path: [] }];
    while (queue.length > 0) {
      if (visited.size >= MAX_BFS_NODES) break;
      const { state: current, path } = queue.shift() as any;
      if (current === toState) return path;
      if (visited.has(current)) continue;
      visited.add(current);
      const transitions = allTransitions.filter(t => t.from === current);
      for (const trans of transitions) {
        if (!visited.has(trans.to)) {
// @ts-expect-error
          queue.push({ state: trans.to, path: [...path, trans] });
        }
      }
    }
    return null;
  }
}

const domainAdapter = new DomainAdapter();

module.exports = { DomainAdapter, domainAdapter ,
  _injectDependencies,
};