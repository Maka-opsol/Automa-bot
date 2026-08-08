'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }

const fs = require('fs');
const path = require('path');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const DIARY_DIR = path.join(CONFIG.LOG_DIR || '.', 'diary');
const DIARY_SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

class Diary {
  entries: any;
  lastSummary: any;
  _started: any;
  _dailyTimer: any;

  constructor() {
    this.entries = [];
    this.lastSummary = 0;
    this._started = false;
    this._dailyTimer = null;
    if (!fs.existsSync(DIARY_DIR)) {
      fs.mkdirSync(DIARY_DIR, { recursive: true });
    }
  }

  logEntry(type: any, message: any, data = {}) { 
    // Response 3: skip diary at degradation level 1+ (REDUCED)
    try {
      const { degradationLadder } = require('./self-heal-degradation-ladder');
      if (degradationLadder.shouldSkip('self-documenting-diary')) {
        return;
      }
    } catch {}
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > 1000) {
      this.entries.shift();
    }
    try {
      const file = path.join(DIARY_DIR, `${new Date().toISOString().split('T')[0]}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err: any) {
      logError('Failed to write diary entry', err);
    }
  }

  logAction(action: any, state: any, success: any, reasoning: any) { 
    this.logEntry('action', `Action: ${action} on ${state}`, {
      action,
      state,
      success,
      reasoning,
    });
  }

  logDecision(decision: any, context: any) { 
    this.logEntry('decision', `Decision: ${decision}`, context);
  }

  logError(err: any, context: any) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.logEntry('error', `Error: ${message}`, {
      stack,
      ...context,
    });
  }

  logStateTransition(from: any, to: any, reason: any) { 
    this.logEntry('transition', `State: ${from} -> ${to}`, { from, to, reason });
  }

  logMetric(name: any, value: any, unit = '') { 
    this.logEntry('metric', `${name}: ${value} ${unit}`, { name, value, unit });
  }

  getTodayEntries() { 
    const today = new Date().toISOString().split('T')[0];
    const file = path.join(DIARY_DIR, `${today}.jsonl`);
    if (!fs.existsSync(file)) return [];
    try {
      const content = fs.readFileSync(file, 'utf8');
      return content.split('\n').filter(Boolean).map((line: any) => {
        try { return JSON.parse(line); } catch (e: any) { return null; }
      }).filter(Boolean);
    } catch (err: any) {
      return [];
    }
  }

  async generateSummary() { 
    const entries = this.getTodayEntries();
    if (entries.length === 0) {
      log('No diary entries for today, skipping summary', 'DEBUG', 'diary');
      return null;
    }
    const activeModel = getGetActiveModel()?.get();
    const modelId = activeModel ? activeModel.model_id : 'openrouter/free';
    const provider = activeModel ? activeModel.provider : 'openrouter';
    let endpoint, apiKey;
    if (provider === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = CONFIG.OPENROUTER_API_KEY;
    } else if (provider === 'mistral') {
      endpoint = 'https://api.mistral.ai/v1/chat/completions';
      apiKey = CONFIG.MISTRAL_CODE_API_KEY;
    } else {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = CONFIG.OPENROUTER_API_KEY;
    }
    if (!apiKey) {
      log('No API key for diary summary', 'WARN', 'diary');
      return null;
    }
    const actions = entries.filter((e: any) => e.type === 'action');
    const errors = entries.filter((e: any) => e.type === 'error');
    const transitions = entries.filter((e: any) => e.type === 'transition');
    const prompt = `
You are a journalist summarising the daily activity of an autonomous bot.

Today's activity:
- Total entries: ${entries.length}
- Actions: ${actions.length}
- Errors: ${errors.length}
- State transitions: ${transitions.length}
- Success rate: ${actions.length > 0 ? (actions.filter((a: any) => a.data && a.data.success).length / actions.length * 100).toFixed(1) : 0}%

Sample entries:
${entries.slice(0, 20).map((e: any) => `- ${e.timestamp}: ${e.type} - ${e.message}`).join('\n')}

Write a concise, human-readable summary of today's operations. Include:
1. What was accomplished
2. Any issues encountered
3. Overall health assessment
4. Recommendations for tomorrow

Keep it under 300 words.
`;
    try {
      const response = await getCallChatCompletion()(endpoint, apiKey, modelId, null, prompt, {
        maxTokens: 800,
        temperature: 0.5,
      });
      const summary = response.choices?.[0]?.message?.content;
      if (summary) {
        const summaryFile = path.join(DIARY_DIR, `summary-${new Date().toISOString().split('T')[0]}.txt`);
        fs.writeFileSync(summaryFile, summary);
        log('Diary summary generated', 'INFO', 'diary');
        return summary;
      }
    } catch (err: any) {
      logError('Failed to generate diary summary', err);
    }
    return null;
  }

  async runDailySummary() { 
    const now = Date.now();
    if (now - this.lastSummary < DIARY_SUMMARY_INTERVAL_MS && this.lastSummary > 0) {
      return;
    }
    const summary = await this.generateSummary();
    if (summary) {
      this.lastSummary = now;
    }
    return summary;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._dailyTimer = setInterval(() => this.runDailySummary(), DIARY_SUMMARY_INTERVAL_MS);
    if (this._dailyTimer.unref) this._dailyTimer.unref();
    setTimeout(() => this.runDailySummary(), 60000).unref();
    log('Diary started', 'INFO', 'diary');
  }

  stop() {
    if (this._dailyTimer) { clearInterval(this._dailyTimer); this._dailyTimer = null; }
    this._started = false;
  }
}

const diary = new Diary();

module.exports = { diary, _injectDependencies };
