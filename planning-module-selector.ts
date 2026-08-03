'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const Q_TABLE = 'q_values';
const EXPLORATION_RATE = 0.1;
const LEARNING_RATE = 0.3;
const DISCOUNT_FACTOR = 0.9;

class ModuleSelector {
  qValues: any;
  state: any;
  lastModule: any;

  constructor() {
    this.qValues = {};
    this.state = null;
    this.lastModule = null;
    this.loadQValues();
  }

  loadQValues() { 
    try {
      const rows = getDb()?.prepare(`SELECT state, action, value FROM q_values`).all() || [];
      for (const row of rows) {
        if (!this.qValues[row.state]) this.qValues[row.state] = {};
        this.qValues[row.state][row.action] = row.value;
      }
      log(`Loaded ${rows.length} Q-values`, 'DEBUG', 'module-selector');
    } catch (err: any) {
      logError('Failed to load Q-values', err);
      this.qValues = {};
    }
  }

  saveQValue(state: any, action: any, value: any) { 
    try {
      getDb()?.prepare(`
        INSERT OR REPLACE INTO q_values (state, action, value, updated_at)
        VALUES(?, ?, ?, ?)
      `).run(state, action, value, Date.now());
    } catch (err: any) {
      logError('Failed to save Q-value', err);
    }
  }

  getAvailableModules() { 
    try {
      const modules = getDb()?.prepare(`
        SELECT name, completed_at, attempts, completion_time_ms
        FROM completed_modules
        ORDER BY completed_at DESC
      `).all();
      return modules;
    } catch (err: any) {
      logError('Failed to get available modules', err);
      return [];
    }
  }

  getModuleStats(moduleName: any) { 
    try {
      return getDb()?.prepare(`
        SELECT name, attempts, completion_time_ms, last_attempt
        FROM completed_modules
        WHERE name = ?
      `).get(moduleName);
    } catch (err: any) {
      return null;
    }
  }

  updateModuleStats(moduleName: any, timeTaken: any, success: any) { 
    try {
      const current = this.getModuleStats(moduleName);
      if (!current) {
        getDb()?.prepare(`
          INSERT INTO completed_modules (name, completed_at, attempts, completion_time_ms, last_attempt)
          VALUES(?, ?, 1, ?, ?)
        `).run(moduleName, Date.now(), timeTaken, Date.now());
        return;
      }
      const newAttempts = current.attempts + 1;
      const newTime = success ? timeTaken : current.completion_time_ms || timeTaken;
      getDb()?.prepare(`
        UPDATE completed_modules
        SET attempts = ?, completion_time_ms = ?, last_attempt = ?, completed_at = ?
        WHERE name = ?
      `).run(newAttempts, newTime, Date.now(), success ? Date.now() : current.completed_at, moduleName);
    } catch (err: any) {
      logError('Failed to update module stats', err);
    }
  }

  getQValue(state: any, action: any) { 
    if (this.qValues[state] && this.qValues[state][action] !== undefined) {
      return this.qValues[state][action];
    }
    return 0;
  }

  updateQValue(state: any, action: any, reward: any, nextState: any) { 
    const currentQ = this.getQValue(state, action);
    const maxNext = this.getMaxQValue(nextState || state);
    const newQ = currentQ + LEARNING_RATE * (reward + DISCOUNT_FACTOR * maxNext - currentQ);
    this.qValues[state] = this.qValues[state] || {};
    this.qValues[state][action] = newQ;
    this.saveQValue(state, action, newQ);
  }

  getMaxQValue(state: any) { 
    if (!this.qValues[state]) return 0;
    const values = Object.values(this.qValues[state]);
    return values.length > 0 ? Math.max(...(values as any[])) : 0;
  }

  selectNextModule() { 
    const modules = this.getAvailableModules();
    if (modules.length === 0) return null;
    const unexplored = modules.filter((m: any) => !this.qValues[m.name]);
    if (unexplored.length > 0 && Math.random() < EXPLORATION_RATE) {
      const chosen = unexplored[Math.floor(Math.random() * unexplored.length)];
      log(`Exploring new module: ${chosen.name}`, 'INFO', 'module-selector');
      this.state = chosen.name;
      this.lastModule = chosen.name;
      return chosen.name;
    }
    const scored = modules.map((m: any) => ({
      name: m.name,
      score: this.getQValue(m.name, 'complete'),
      attempts: m.attempts || 0,
    }));
    scored.sort((a: any, b: any) => b.score - a.score);
    const top = scored[0];
    if (top && top.score === 0 && Math.random() < 0.3) {
      const random = modules[Math.floor(Math.random() * modules.length)];
      log(`Random fallback: ${random.name}`, 'DEBUG', 'module-selector');
      this.state = random.name;
      this.lastModule = random.name;
      return random.name;
    }
    if (top) {
      log(`Selected module: ${top.name} (score: ${top.score.toFixed(2)})`, 'INFO', 'module-selector');
      this.state = top.name;
      this.lastModule = top.name;
      return top.name;
    }
    return modules[0]?.name || null;
  }

  markBlocked(moduleName: any) { 
    try {
      getDb()?.prepare(`
        INSERT OR REPLACE INTO blocked_modules (name, blocked_at, unblock_at)
        VALUES(?, ?, ?)
      `).run(moduleName, Date.now(), Date.now() + 30 * 60 * 1000);
      log(`Marked module as blocked: ${moduleName}`, 'INFO', 'module-selector');
    } catch (err: any) {
      logError('Failed to mark module as blocked', err);
    }
  }

  isBlocked(moduleName: any) { 
    try {
      const row = getDb()?.prepare(`SELECT unblock_at FROM blocked_modules WHERE name = ?`).get(moduleName);
      if (!row) return false;
      return Date.now() < row.unblock_at;
    } catch (err: any) {
      return false;
    }
  }

  getNextModule() { 
    let moduleName = this.selectNextModule();
    let attempts = 0;
    while (this.isBlocked(moduleName) && attempts < 10) {
      log(`Module ${moduleName} is blocked, skipping`, 'DEBUG', 'module-selector');
      moduleName = this.selectNextModule();
      attempts++;
    }
    return moduleName;
  }

  recordCompletion(moduleName: any, timeTaken: any) { 
    this.updateModuleStats(moduleName, timeTaken, true);
    const reward = 1 / (timeTaken + 5);
    this.updateQValue(moduleName, 'complete', reward, null as any);
  }

  recordFailure(moduleName: any, timeTaken: any) { 
    this.updateModuleStats(moduleName, timeTaken, false);
    this.updateQValue(moduleName, 'complete', -0.1, null as any);
    const stats = this.getModuleStats(moduleName);
    if (stats && stats.attempts > 3) {
      this.markBlocked(moduleName);
    }
  }
}

const moduleSelector = new ModuleSelector();

function getNextModule() { 
  return moduleSelector.getNextModule();
}

function recordModuleCompletion(moduleName: any, timeTaken: any) { 
  moduleSelector.recordCompletion(moduleName, timeTaken);
}

function recordModuleFailure(moduleName: any, timeTaken: any) { 
  moduleSelector.recordFailure(moduleName, timeTaken);
}

function getSelectorStats() { 
  return {
    currentState: moduleSelector.state,
    lastModule: moduleSelector.lastModule,
    qValuesCount: Object.keys(moduleSelector.qValues).length,
  };
}

module.exports = {
  getNextModule,
  recordModuleCompletion,
  recordModuleFailure,
  getSelectorStats,
  _injectDependencies,
};
