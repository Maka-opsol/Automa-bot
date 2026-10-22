'use strict';

import type { Deps } from './types/di-types';
const EventEmitter = require('events');
let _deps: Deps = {};

function _injectDependencies(deps: Deps) {
  _deps = deps;
}

function getCONFIG(): any { return _deps.config || {}; }
function getDb(): any { return _deps.database?.db; }

// Wrapper functions that delegate to injected logger with console fallbacks
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function safeLog(obj: any, level?: string, mod?: string) { _deps.logger?.safeLog?.(obj, level, mod) ?? console.log(JSON.stringify(obj)); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

// Read CONFIG values at call-time (not module load) to reflect config changes at runtime
function getStateHistoryMax(): number { return getCONFIG().STATE_HISTORY_MAX ?? 1000; }
function getStateTimeoutMs(): number { return getCONFIG().STATE_TIMEOUT_MS ?? 5 * 60 * 1000; }

// --- Types & Interfaces ---

interface HistoryEntry {
  state: string;
  timestamp: number;
}

type Hook = {
  type: 'enter' | 'exit';
  fn: (state: string) => void | Promise<void>;
};

type GuardFn = () => boolean | Promise<boolean>;

// --- State Constants ---

const STATES: Readonly<Record<string, string>> = {
  MATHU_LOGIN: 'mathu_login',
  MICROSOFT_EMAIL_INPUT: 'microsoft_email_input',
  MICROSOFT_PASSWORD_INPUT: 'microsoft_password_input',
  MICROSOFT_KMSI: 'microsoft_kmsi',
  ADVLEARN_LOGIN: 'advlearn_login',
  ASSIGNMENTS_PAGE: 'assignments_page',
  VIDEO_PLAYER: 'video_player',
  EXERCISE_INFO: 'exercise_info',
  EXERCISE_MEMO: 'exercise_memo',
  ASSESSMENT: 'assessment',
  SCORE_SCREEN: 'score_screen',
  PATHWAY: 'pathway',
  PATHWAY_FEEDBACK: 'pathway_feedback',
  ASSESSMENT_CORRECTION: 'assessment_correction',
  ANYWHERE_CLICK_RECOVERY: 'anywhere_click_recovery',
  ERROR: 'error',
  UI_DISCOVERED: 'ui_discovered',
  FLUTTER_MODAL: 'flutter_modal',
  FLUTTER_BOTTOM_SHEET: 'flutter_bottom_sheet',
  EXPLORATION: 'exploration',
};

const VALID_STATES_SET: Set<string> = new Set(Object.values(STATES));

// --- Action Constants ---

const ACTIONS: Readonly<Record<string, string>> = {
  CLICK: 'click',
  INPUT_EMAIL: 'input_email',
  INPUT_PASSWORD: 'input_password',
  KEYPAD_INPUT: 'keypad_input',
  SCROLL_VERTICAL: 'scroll_vertical',
  SCROLL_HORIZONTAL: 'scroll_horizontal',
  WAIT: 'wait',
  FLUTTER_SWIPE: 'flutter_swipe',
  FLUTTER_TAP: 'flutter_tap',
};

const VALID_ACTIONS_SET: ReadonlySet<string> = new Set(Object.values(ACTIONS));
const ACTIONS_REQUIRING_COORDS: ReadonlySet<string> = new Set([
  ACTIONS.CLICK,
  ACTIONS.INPUT_EMAIL,
  ACTIONS.INPUT_PASSWORD,
  ACTIONS.FLUTTER_TAP,
]);

// --- Transitions ---

// VALID_TRANSITIONS is intentionally mutable — `updateTransitions` and `addState` extend it at runtime
const VALID_TRANSITIONS: Record<string, string[]> = {
  [STATES.MATHU_LOGIN]: [STATES.MICROSOFT_EMAIL_INPUT, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.MICROSOFT_EMAIL_INPUT]: [STATES.MICROSOFT_PASSWORD_INPUT, STATES.ADVLEARN_LOGIN, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.MICROSOFT_PASSWORD_INPUT]: [STATES.MICROSOFT_KMSI, STATES.MICROSOFT_EMAIL_INPUT, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.MICROSOFT_KMSI]: [STATES.ASSIGNMENTS_PAGE, STATES.MATHU_LOGIN, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.ADVLEARN_LOGIN]: [STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.ASSIGNMENTS_PAGE]: [STATES.VIDEO_PLAYER, STATES.EXERCISE_INFO, STATES.ASSESSMENT, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR, STATES.UI_DISCOVERED, STATES.EXPLORATION],
  [STATES.VIDEO_PLAYER]: [STATES.EXERCISE_INFO, STATES.ASSESSMENT, STATES.SCORE_SCREEN, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.EXERCISE_INFO]: [STATES.EXERCISE_MEMO, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.EXERCISE_MEMO]: [STATES.ASSESSMENT, STATES.ASSIGNMENTS_PAGE, STATES.SCORE_SCREEN, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.ASSESSMENT]: [STATES.SCORE_SCREEN, STATES.PATHWAY, STATES.ASSESSMENT_CORRECTION, STATES.ASSESSMENT, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.SCORE_SCREEN]: [STATES.PATHWAY, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.PATHWAY]: [STATES.PATHWAY_FEEDBACK, STATES.ASSIGNMENTS_PAGE, STATES.SCORE_SCREEN, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.PATHWAY_FEEDBACK]: [STATES.PATHWAY, STATES.ASSIGNMENTS_PAGE, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.ASSESSMENT_CORRECTION]: [STATES.SCORE_SCREEN, STATES.PATHWAY, STATES.ASSESSMENT_CORRECTION, STATES.ANYWHERE_CLICK_RECOVERY, STATES.ERROR],
  [STATES.ANYWHERE_CLICK_RECOVERY]: [STATES.MATHU_LOGIN, STATES.ASSIGNMENTS_PAGE, STATES.VIDEO_PLAYER, STATES.EXERCISE_INFO, STATES.ASSESSMENT, STATES.SCORE_SCREEN, STATES.PATHWAY, STATES.ERROR],
  [STATES.ERROR]: [STATES.MATHU_LOGIN, STATES.ASSIGNMENTS_PAGE, STATES.ERROR, STATES.ANYWHERE_CLICK_RECOVERY],
  [STATES.UI_DISCOVERED]: [STATES.ASSIGNMENTS_PAGE, STATES.VIDEO_PLAYER, STATES.ERROR],
  [STATES.FLUTTER_MODAL]: [STATES.ASSIGNMENTS_PAGE, STATES.VIDEO_PLAYER, STATES.ERROR],
  [STATES.FLUTTER_BOTTOM_SHEET]: [STATES.ASSIGNMENTS_PAGE, STATES.ERROR],
  [STATES.EXPLORATION]: [STATES.ASSIGNMENTS_PAGE, STATES.ERROR],
};

const TRANSITION_SETS: Record<string, Set<string>> = {};
for (const [from, toList] of Object.entries(VALID_TRANSITIONS)) {
  TRANSITION_SETS[from] = new Set(toList);
}

// --- StateMachine Class ---

class StateMachine extends EventEmitter {
  public currentState: string | null;
  public history: HistoryEntry[];
  public deadlockDetected: boolean;
  private stateStartTime: number | null;
  private guards: Map<string, GuardFn>;
  private hooks: Map<string, Hook[]>;
  private _initialized: boolean;
  private _transitionLock: boolean;
  private _maxListeners: number;

  constructor() {
    super();
    this.currentState = null;
    this.stateStartTime = null;
    this.guards = new Map<string, GuardFn>();
    this.hooks = new Map<string, Hook[]>();
    this.history = [];
    this.deadlockDetected = false;
    this._initialized = false;
    this._transitionLock = false;
    this._maxListeners = 50;
    this.setMaxListeners(this._maxListeners);
    this.on('error', (err: Error): void => {
      logError('StateMachine event error', err, { state: this.currentState });
    });
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;
    try {
      const db = getDb();
      if (!db) {
        log('Database not initialized — starting fresh at MATHU_LOGIN', 'WARN', 'state-machine');
        this.currentState = STATES.MATHU_LOGIN;
        this.stateStartTime = Date.now();
        this._initialized = true;
        this.emit('initialized', this.currentState);
        return;
      }
      const last: { state: string; timestamp: number } | undefined =
        db.prepare(`SELECT state, timestamp FROM state_history ORDER BY timestamp DESC LIMIT 1`).get() as
          | { state: string; timestamp: number }
          | undefined;
      if (last && last.state && VALID_STATES_SET.has(last.state)) {
        const timeSinceLastState: number = Date.now() - last.timestamp;
        if (timeSinceLastState < 3600000) {
          this.currentState = last.state;
          log(
            `Recovered state: ${this.currentState} (age: ${Math.round(timeSinceLastState / 1000)}s)`,
            'INFO',
            'state-machine',
          );
        } else {
          log(
            `Last state too old (${Math.round(timeSinceLastState / 1000 / 60)}min), starting fresh`,
            'INFO',
            'state-machine',
          );
          this.currentState = STATES.MATHU_LOGIN;
        }
      } else {
        this.currentState = STATES.MATHU_LOGIN;
      }
      this.stateStartTime = Date.now();
      this._initialized = true;
      this.emit('initialized', this.currentState);
    } catch (err: unknown) {
      logError('State machine initialization failed', err as Error);
      this.currentState = STATES.MATHU_LOGIN;
      this.stateStartTime = Date.now();
      this._initialized = true;
    }
  }

  onEnter(state: string, hook: (state: string) => void | Promise<void>): void {
    if (!VALID_STATES_SET.has(state)) throw new Error(`Invalid state for onEnter hook: ${state}`);
    if (typeof hook !== 'function') throw new Error('Hook must be a function');
    if (!this.hooks.has(state)) this.hooks.set(state, []);
    this.hooks.get(state)!.push({ type: 'enter', fn: hook });
  }

  onExit(state: string, hook: (state: string) => void | Promise<void>): void {
    if (!VALID_STATES_SET.has(state)) throw new Error(`Invalid state for onExit hook: ${state}`);
    if (typeof hook !== 'function') throw new Error('Hook must be a function');
    if (!this.hooks.has(state)) this.hooks.set(state, []);
    this.hooks.get(state)!.push({ type: 'exit', fn: hook });
  }

  addGuard(fromState: string, toState: string, guardFn: GuardFn): void {
    if (!VALID_STATES_SET.has(fromState) || !VALID_STATES_SET.has(toState)) {
      throw new Error(`Invalid states for guard: ${fromState} -> ${toState}`);
    }
    if (typeof guardFn !== 'function') throw new Error('Guard must be a function');
    const key: string = `${fromState}->${toState}`;
    this.guards.set(key, guardFn);
  }

  async transition(newState: string): Promise<boolean> {
    if (!this._initialized) await this.initialize();
    if (!VALID_STATES_SET.has(newState)) throw new Error(`Invalid target state: ${newState}`);
    if (this.currentState === null) {
      log('Transition attempted with null currentState, initializing to MATHU_LOGIN', 'WARN', 'state-machine');
      this.currentState = STATES.MATHU_LOGIN;
      this.stateStartTime = Date.now();
    }
    if (this._transitionLock) {
      log(`Transition blocked - lock held: ${this.currentState} → ${newState}`, 'WARN', 'state-machine');
      return false;
    }
    if (!this.isValidTransition(this.currentState, newState)) {
      const validTargets: Set<string> = TRANSITION_SETS[this.currentState] || new Set<string>();
      throw new Error(
        `Invalid transition: ${this.currentState} → ${newState}. Valid: [${[...validTargets].join(', ')}]`,
      );
    }
    this._transitionLock = true;
    try {
      const guardKey: string = `${this.currentState}->${newState}`;
      const guard: GuardFn | undefined = this.guards.get(guardKey);
      if (guard) {
        // FIX: Save timer handle and clear after race resolves
        let guardTimer: any = null;
        try {
          const guardResult: boolean = await Promise.race<boolean>([
            guard(),
            new Promise<boolean>((_, reject) => {
              guardTimer = setTimeout(() => reject(new Error('Guard timeout')), 5000);
            }),
          ]);
          if (!guardResult) {
            this.emit('guardRejected', { from: this.currentState, to: newState });
            log(`Guard rejected: ${this.currentState} → ${newState}`, 'DEBUG', 'state-machine');
            return false;
          }
        } catch (err: unknown) {
          const message: string = err instanceof Error ? err.message : String(err);
          log(`Guard error (${guardKey}): ${message}`, 'ERROR', 'state-machine');
          this.emit('guardError', { from: this.currentState, to: newState, error: message });
          return false;
        } finally {
          if (guardTimer) clearTimeout(guardTimer);
        }
      }
      await this._runHooks(this.currentState, 'exit');
      const oldState: string = this.currentState;
      this.currentState = newState;
      this.stateStartTime = Date.now();
      this._persistState(oldState, newState);
      this.history.push({ state: newState, timestamp: Date.now() });
      if (this.history.length > getStateHistoryMax()) {
        this.history = this.history.slice(-getStateHistoryMax());
      }
      await this._runHooks(newState, 'enter');
      this.emit('transition', { from: oldState, to: newState, timestamp: Date.now() });
      return true;
    } finally {
      this._transitionLock = false;
    }
  }

  private _persistState(oldState: string | null, newState: string): void {
    try {
      const db = getDb();
      if (!db) return;
      db.prepare(`INSERT INTO state_history (state, timestamp, previous_state) VALUES (?, ?, ?)`).run(
        newState,
        Date.now(),
        oldState,
      );
    } catch (err: unknown) {
      logError('Failed to persist state', err as Error, { from: oldState, to: newState });
    }
  }

  private async _runHooks(state: string, type: 'enter' | 'exit'): Promise<void> {
    const hooks: Hook[] = this.hooks.get(state)?.filter((h: Hook) => h.type === type) || [];
    for (const hook of hooks) {
      // FIX: Save timer handle and clear after race resolves
      let hookTimer: any = null;
      try {
        await Promise.race<void>([
          hook.fn(state) as Promise<void>,
          new Promise<never>((_, reject) => {
            hookTimer = setTimeout(() => reject(new Error('Hook timeout')), 30000);
          }),
        ]);
      } catch (err: unknown) {
        logError(`Hook error (${type} ${state})`, err as Error);
      } finally {
        if (hookTimer) clearTimeout(hookTimer);
      }
    }
  }

  isValidTransition(from: string | null, to: string): boolean {
    if (from === null || !VALID_STATES_SET.has(from) || !VALID_STATES_SET.has(to)) return false;
    if (to === STATES.ANYWHERE_CLICK_RECOVERY || to === STATES.ERROR) return true;
    const validSet: Set<string> | undefined = TRANSITION_SETS[from];
    return validSet !== undefined ? validSet.has(to) : false;
  }

  detectDeadlock(): boolean {
    // v5-fix M5: Increased from 20 to 50 entries. The previous window was too
    // small — a slow oscillation (e.g. cycle of 5 states with delays between
    // each) could have >20 history entries between repetitions and evade detection.
    const recent: HistoryEntry[] = this.history.slice(-50);
    if (recent.length < 10) return false;
    const uniqueStates: Set<string> = new Set(recent.map((r: HistoryEntry) => r.state));
    if (uniqueStates.size <= 3) {
      const stateSequence: string[] = recent.map((r: HistoryEntry) => r.state);
      const hasOscillation: boolean = this._detectOscillation(stateSequence);
      if (hasOscillation) {
        this.deadlockDetected = true;
        log(
          `Deadlock detected: oscillation between ${[...uniqueStates].join(', ')}`,
          'WARN',
          'state-machine',
        );
        return true;
      }
    }
    if (this.stateStartTime !== null && Date.now() - this.stateStartTime > getStateTimeoutMs()) {
      this.deadlockDetected = true;
      log(`Deadlock detected: state timeout (${this.currentState})`, 'WARN', 'state-machine');
      return true;
    }
    this.deadlockDetected = false;
    return false;
  }

  private _detectOscillation(sequence: string[]): boolean {
    if (sequence.length < 6) return false;
    const last4: string[] = sequence.slice(-4);
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) return true;
    const last6: string[] = sequence.slice(-6);
    if (
      last6.length === 6 &&
      last6[0] === last6[3] &&
      last6[1] === last6[4] &&
      last6[2] === last6[5]
    )
      return true;
    return false;
  }

  resetDeadlock(): void {
    const oldHistoryLength: number = this.history.length;
    this.history = [];
    this.deadlockDetected = false;
    this.stateStartTime = Date.now();
    log(
      `Deadlock reset (cleared ${oldHistoryLength} history entries)`,
      'INFO',
      'state-machine',
    );
  }

  getCurrentState(): string | null {
    return this.currentState;
  }

  getStateAge(): number {
    return this.stateStartTime !== null ? Date.now() - this.stateStartTime : 0;
  }

  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  getValidNextStates(state: string): string[] {
    if (!VALID_STATES_SET.has(state)) return [];
    return [...(VALID_TRANSITIONS[state] || [])];
  }

  updateTransitions(newTransitions: Record<string, string[]>): void {
    if (!newTransitions || typeof newTransitions !== 'object')
      throw new Error('newTransitions must be an object');
    for (const [from, toList] of Object.entries(newTransitions)) {
      if (!VALID_STATES_SET.has(from)) {
        log(`Invalid source state in updateTransitions: ${from}`, 'WARN', 'state-machine');
        continue;
      }
      if (!Array.isArray(toList)) {
        log(`Invalid transitions list for ${from}`, 'WARN', 'state-machine');
        continue;
      }
      const validToList: string[] = (toList as string[]).filter((to: string) =>
        VALID_STATES_SET.has(to),
      );
      const existing: string[] = VALID_TRANSITIONS[from] || [];
      const mergedSet = new Set([...existing, ...validToList]);
      VALID_TRANSITIONS[from] = [...mergedSet];
      TRANSITION_SETS[from] = mergedSet;
    }
  }

  addState(newState: string, transitions: string[] = []): void {
    if (typeof newState !== 'string' || newState.length === 0)
      throw new Error('State name must be a non-empty string');
    if (VALID_STATES_SET.has(newState)) throw new Error(`State already exists: ${newState}`);
    if (!Array.isArray(transitions)) throw new Error('Transitions must be an array');
    VALID_STATES_SET.add(newState);
    const validTransitions: string[] = transitions.filter((t: string) => VALID_STATES_SET.has(t));
    VALID_TRANSITIONS[newState] = validTransitions;
    TRANSITION_SETS[newState] = new Set(validTransitions);
    log(
      `Added new state: ${newState} with ${validTransitions.length} transitions`,
      'INFO',
      'state-machine',
    );
  }

  forceState(newState: string, reason: string = 'unspecified'): void {
    if (!VALID_STATES_SET.has(newState))
      throw new Error(`Cannot force invalid state: ${newState}`);
    const oldState: string | null = this.currentState;
    this.currentState = newState;
    this.stateStartTime = Date.now();
    this.deadlockDetected = false;
    safeLog({ action: 'force_state', from: oldState, to: newState, reason }, 'WARN', 'state-machine');
    this._persistState(oldState, newState);
    // FIX: Run hooks on forceState to prevent data loss.
    // Hooks are fire-and-forget (sync) since forceState is sync.
    try {
      // Run exit hook for old state
      const exitHooks = this.hooks.get(oldState || '')?.filter((h: Hook) => h.type === 'exit') || [];
      for (const hook of exitHooks) {
        try { hook.fn(newState); } catch (e: unknown) { logError(`forceState exit hook error`, e as Error); }
      }
      // Run enter hook for new state
      const enterHooks = this.hooks.get(newState)?.filter((h: Hook) => h.type === 'enter') || [];
      for (const hook of enterHooks) {
        try { hook.fn(newState); } catch (e: unknown) { logError(`forceState enter hook error`, e as Error); }
      }
    } catch (e: unknown) {
      logError(`forceState hook error`, e as Error);
    }
    this.emit('forceState', { from: oldState, to: newState, reason });
  }
}

// --- Singleton ---

const stateMachine: StateMachine = new StateMachine();

module.exports = {
  STATES,
  ACTIONS,
  ACTIONS_REQUIRING_COORDS,
  VALID_TRANSITIONS,
  stateMachine,
  _injectDependencies,
  isValidTransition: (from: string, to: string): boolean =>
    stateMachine.isValidTransition(from, to),
  getValidNextStates: (state: string): string[] => stateMachine.getValidNextStates(state),
  isValidState: (state: string): boolean => VALID_STATES_SET.has(state),
  isValidAction: (action: string): boolean => VALID_ACTIONS_SET.has(action),
  pushState: (state: string): Promise<boolean> => stateMachine.transition(state),
  detectDeadlock: (): boolean => stateMachine.detectDeadlock(),
  resetDeadlockDetection: (): void => stateMachine.resetDeadlock(),
  forceState: (state: string, reason?: string): void =>
    stateMachine.forceState(state, reason),
  getStateDiagnostics: (): {
    currentState: string | null;
    stateAge: number;
    historyLength: number;
    deadlockDetected: boolean;
  } => ({
    currentState: stateMachine.currentState,
    stateAge: stateMachine.getStateAge(),
    historyLength: stateMachine.history.length,
    deadlockDetected: stateMachine.deadlockDetected,
  }),
};
