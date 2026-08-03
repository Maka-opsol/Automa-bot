'use strict';
const { sleep } = require('./utils-sleep');
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSm() { return _deps.stateMachine; }
function getSTATES() { return _deps.stateMachine?.STATES; }
function getFlutterTap() { return _deps.browser?.flutterTap; }
function getInsertExplorationMap() { return _deps.database?.insertExplorationMap; }


const { log, logError } = require('./logger');

class ExplorationCartographer {
  from: any;
  to: any;

  async explore(page: any) { 
    log('🗺️ Starting topological exploration...', 'INFO', 'exploration');
    const map = { states: [], transitions: [] };
    const startingState = getSm()?.getCurrentState();
    const elements = await page.evaluate(() => {
      const all = document.querySelectorAll('button, a, [role="button"], input, .clickable');
      return Array.from(all).map((el: any) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, text: el.innerText || el.getAttribute('aria-label') || '', tag: el.tagName };
      });
    });
    for (const el of elements.slice(0, 20)) {
      if (el.text.toLowerCase().includes('logout') || el.text.toLowerCase().includes('delete')) continue;
      const beforeUrl = page.url();
      try {
        await getFlutterTap()?.(page, el.x, el.y);
        await sleep(2000);
        const afterUrl = page.url();
        if (afterUrl !== beforeUrl) {
          const newState = this.detectState(afterUrl);
// @ts-expect-error
          if (!map.states.includes(newState)) (map.states as any[]).push(newState);
          (map.transitions as any[]).push({ from: startingState, to: newState, trigger: el.text });
          log(`Explored transition: ${startingState} -> ${newState} via "${el.text}"`, 'INFO', 'exploration');
          try {
            await page.goBack();
            await sleep(2000);
          } catch (navErr: any) {
            logError('Failed to go back after exploration', navErr);
            break;
          }
        }
      } catch (tapErr: any) {
        logError(`Exploration tap failed on "${el.text}"`, tapErr);
      }
    }
    getInsertExplorationMap()?.run(startingState, JSON.stringify(map), Date.now());
    for (const state of map.states) {
// @ts-expect-error
      if (!Object.values(STATES).includes(state)) { getSm()?.addState(state, ['assignments_page']); log(`Added new state: ${state}`, 'INFO', 'exploration'); }
    }
    for (const trans of map.transitions) {
// @ts-expect-error
      if (!getSm()?.isValidTransition(trans.from, trans.to)) {
// @ts-expect-error
        const currentTransitions = getSm()?.getValidNextStates(trans.from) || [];
// @ts-expect-error
        currentTransitions.push(trans.to);
// @ts-expect-error
        getSm()?.updateTransitions({ [trans.from]: currentTransitions });
// @ts-expect-error
        log(`Added transition: ${trans.from} -> ${trans.to}`, 'INFO', 'exploration');
      }
    }
    return map;
  }

  detectState(url: any) { 
    if (url.includes('/assignments')) return 'assignments_page';
    if (url.includes('/video')) return 'video_player';
    if (url.includes('/exercise')) return 'exercise_info';
    if (url.includes('/assessment')) return 'assessment';
    if (url.includes('/score')) return 'score_screen';
    if (url.includes('/pathway')) return 'pathway';
    return 'explored_state';
  }
}

module.exports = Object.assign(new ExplorationCartographer(), { _injectDependencies });
