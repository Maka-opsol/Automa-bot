'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log, safeLog, logError } = require('./logger');
const { stateMachine, STATES, VALID_TRANSITIONS, isValidState } = require('./state-machine');
const { db, upsertDiscoveredState } = require('./database');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const MAX_NEW_STATES_PER_CYCLE = 5;
const STATE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,48}$/;
const RETRAINED_STATES_FILE = path.join(PROJECT_ROOT, 'retrained-states.json');

function loadRetrainedStates() {
  try {
    if (fs.existsSync(RETRAINED_STATES_FILE)) {
      return JSON.parse(fs.readFileSync(RETRAINED_STATES_FILE, 'utf-8'));
    }
  } catch (e: any) { /* ignore */ }
  return { states: {}, transitions: {} };
}

function saveRetrainedStates(data: any) {
  try {
    const dir = path.dirname(RETRAINED_STATES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RETRAINED_STATES_FILE, JSON.stringify(data, null, 2));
  } catch (e: any) {
    log(`Failed to persist retrained states: ${e.message}`, 'WARN', 'process-retrainer');
  }
}

function validateStateName(name: any) {
  if (typeof name !== 'string') return false;
  if (!STATE_NAME_PATTERN.test(name)) return false;
  if (name.length > 50) return false;
  return true;
}

function validateTransitions(transitions: any, knownStates: any) {
  if (!transitions || typeof transitions !== 'object') return {};
  const valid = {};
  for (const [from, toList] of Object.entries(transitions)) {
    if (!validateStateName(from)) continue;
    if (!Array.isArray(toList)) continue;
    const validToList = toList.filter(t => {
      if (!validateStateName(t)) return false;
      // Only allow transitions to known states or other new states in this batch
      return knownStates.has(t) || (transitions[t] !== undefined);
    });
    if (validToList.length > 0) (valid as any)[from] = validToList;
  }
  return valid;
}

async function generateNewStatesAndTransitions(failureScreenshots: any) {
  log('Generating new states and transitions from failure data', 'DEBUG', 'process-retrainer');
  if (!failureScreenshots || failureScreenshots.length === 0) {
    return { newStates: [], newTransitions: {} };
  }

  const knownStates = new Set(Object.values(STATES));

  const prompt = `Analyze these ${failureScreenshots.length} failure screenshots and suggest new state definitions and transitions for the state machine.\n` +
    `The bot got stuck in unknown states. Generate valid JSON with: {"states": [{"name": "STATE_NAME", "description": "what this state looks like"}, ...], "transitions": {"STATE_NAME": ["TARGET_STATE_1", "TARGET_STATE_2"], ...}}\n` +
    `Rules: State names must be UPPER_SNAKE_CASE, max 50 chars. Only suggest transitions to these known states: ${Array.from(knownStates).join(', ')}\n` +
    `Previous states: ${JSON.stringify(STATES || {})}\n`;

  try {
    const { consultTribunalRaw } = require('./providers-codegen-tribunal');
    const signal = AbortSignal.timeout(120_000);
    const rawResult = await consultTribunalRaw(prompt, signal, { responseFormatJson: true });
    if (rawResult) {
      try {
        const parsed = JSON.parse(rawResult);
        const newStates = (parsed.states || []).filter((s: any) => s && validateStateName(s.name));
        const newTransitions = validateTransitions(parsed.transitions, knownStates);

        if (newStates.length > 0 || Object.keys(newTransitions).length > 0) {
          log(`Generated ${newStates.length} candidate states and ${Object.keys(newTransitions).length} candidate transitions`, 'INFO', 'process-retrainer');
          return { newStates, newTransitions };
        }
      } catch (e: any) {
        log('Failed to parse retraining result, returning empty', 'WARN', 'process-retrainer');
      }
    }
  } catch (err: any) {
    log(`Retraining generation failed: ${err.message}`, 'WARN', 'process-retrainer');
  }
  return { newStates: [], newTransitions: {} };
}

async function retrainProcesses(failureScreenshots = []) {
  if (!getCONFIG().SELF_HEAL_ENABLED) return;
  log('Starting process retraining...', 'INFO', 'retrainer');

  try {
    const suggestions = await generateNewStatesAndTransitions(failureScreenshots);
    if (suggestions.newStates.length === 0 && Object.keys(suggestions.newTransitions).length === 0) {
      log('No new states or transitions generated, skipping', 'DEBUG', 'retrainer');
      return;
    }

    const previous = loadRetrainedStates();
    let appliedCount = 0;

    // Apply new states to the running state machine
    for (const stateDef of suggestions.newStates.slice(0, MAX_NEW_STATES_PER_CYCLE)) {
      const name = stateDef.name;
      if (!validateStateName(name)) continue;
      if (isValidState(name)) {
        log(`State ${name} already exists, skipping`, 'DEBUG', 'retrainer');
        continue;
      }

      const transitions = ((suggestions.newTransitions as any)[name] || []).filter((t: any) => isValidState(t));
      try {
        stateMachine.addState(name, transitions);
        appliedCount++;

        // Persist to database for recovery across restarts
        try {
          upsertDiscoveredState.run(name, Date.now(), 0, Date.now(), 30, 0, failureScreenshots[0] || '', stateDef.description || '');
        } catch (e: any) {
          log(`DB persist failed for ${name}: ${e.message}`, 'WARN', 'retrainer');
        }

        // Track in retrained-states file
        previous.states[name] = { description: stateDef.description, addedAt: Date.now() };
        log(`Applied new state: ${name} with ${transitions.length} transitions`, 'INFO', 'retrainer');
      } catch (e: any) {
        log(`Failed to add state ${name}: ${e.message}`, 'WARN', 'retrainer');
      }
    }

    // Apply additional transitions to existing states
    for (const [from, toList] of Object.entries(suggestions.newTransitions)) {
      if (!isValidState(from)) continue; // Skip transitions from states that weren't added
      for (const to of toList as any[]) {
        if (!isValidState(to)) continue;
        try {
          stateMachine.addTransition(from, to);
          if (!previous.transitions[from]) previous.transitions[from] = [];
          if (!previous.transitions[from].includes(to)) previous.transitions[from].push(to);
        } catch (e: any) {
          log(`Failed to add transition ${from} -> ${to}: ${e.message}`, 'WARN', 'retrainer');
        }
      }
    }

    saveRetrainedStates(previous);
    log(`Retraining complete: ${appliedCount} new states applied`, 'INFO', 'retrainer');
  } catch (err: any) {
    logError('Retraining failed', err);
  }
}

/**
 * Re-apply previously learned states on startup (before first cycle).
 * Safe to call multiple times — skips states that already exist.
 */
function reapplyLearnedStates() {
  const previous = loadRetrainedStates();
  let restored = 0;
  for (const [name, meta] of Object.entries(previous.states || {})) {
    if (!validateStateName(name) || isValidState(name)) continue;
    try {
      const transitions = (previous.transitions[name] || []).filter((t: any) => isValidState(t));
      stateMachine.addState(name, transitions);
      restored++;
    } catch (e: any) { /* skip */ }
  }
  if (restored > 0) log(`Restored ${restored} learned states from previous retraining`, 'INFO', 'retrainer');
}

module.exports = { retrainProcesses, reapplyLearnedStates, _injectDependencies };
