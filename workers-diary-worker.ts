'use strict';

/**
 * Diary worker thread.
 *
 * Handles all diary logging and daily summary generation in an
 * isolated thread. Writes JSONL files to the diary directory
 * and calls LLM API for daily summaries.
 *
 * Dependencies passed via INIT:
 *   - config: { LOG_DIR, OPENROUTER_API_KEY, MISTRAL_CODE_API_KEY }
 *   - dbPath: path to SQLite DB (for getActiveModel)
 */

const fs = require('fs');
const path = require('path');
const { WorkerBase } = require('./workers-worker-base');
const { METHOD } = require('./workers-message-protocol');

// ─── Inline LLM caller (worker can't require main-thread modules) ───

function callLLM(endpoint: any, apiKey: any, modelId: any, prompt: any) { 
  // Use Node.js native fetch (Node 18+)
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.5,
    }),
  }).then(async (res) => {
    if (!(res as any).ok) {
      const text = await (res as any).text().catch(() => '');
      throw new Error(`LLM API ${(res as any).status}: ${text.slice(0, 200)}`);
    }
    return (res as any).json();
  });
}

// ─── Diary class (worker-local) ───

class DiaryWorkerImpl {
  ok: any;
  text: any;
  status: any;
  json: any;
  config: any;
  _emit: any;
  entries: any;
  lastSummary: any;
  DIARY_DIR: any;
  SUMMARY_INTERVAL_MS: any;

  constructor(config: any, emitFn: any) {
    this.config = config;
    this._emit = emitFn || (() => {});
    this.entries = [];
    this.lastSummary = 0;
    this.DIARY_DIR = path.join(config.LOG_DIR || '.', 'diary');
    this.SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

    if (!fs.existsSync(this.DIARY_DIR)) {
      fs.mkdirSync(this.DIARY_DIR, { recursive: true });
    }
  }

  logEntry(type: any, message: any, data = {}) { 
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > 1000) {
      this.entries = this.entries.slice(-1000);
    }
    try {
      const file = path.join(this.DIARY_DIR, `${new Date().toISOString().split('T')[0]}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err: any) {
      this._emitLog('Failed to write diary entry', err.message, 'ERROR');
    }
  }

  getTodayEntries() { 
    const today = new Date().toISOString().split('T')[0];
    const file = path.join(this.DIARY_DIR, `${today}.jsonl`);
    if (!fs.existsSync(file)) return [];
    try {
      const content = fs.readFileSync(file, 'utf8');
      return content.split('\n').filter(Boolean).map((line: any) => JSON.parse(line));
    } catch (_: any) {
      return [];
    }
  }

  async generateSummary() { 
    const entries = this.getTodayEntries();
    if (entries.length === 0) {
      return null;
    }

    const apiKey = this.config.OPENROUTER_API_KEY;
    if (!apiKey) {
      this._emitLog('No API key for diary summary', '', 'WARN');
      return null;
    }

    const actions = entries.filter((e: any) => e.type === 'action');
    const errors = entries.filter((e: any) => e.type === 'error');
    const transitions = entries.filter((e: any) => e.type === 'transition');
    const prompt = `You are a journalist summarising the daily activity of an autonomous bot.

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

Keep it under 300 words.`;

    try {
      const response = await callLLM(
        'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        'openrouter/free',
        prompt,
      );
      const summary = response.choices?.[0]?.message?.content;
      if (summary) {
        const summaryFile = path.join(this.DIARY_DIR, `summary-${new Date().toISOString().split('T')[0]}.txt`);
        fs.writeFileSync(summaryFile, summary);
        this._emitLog('Diary summary generated', '', 'INFO');
        return summary;
      }
    } catch (err: any) {
      this._emitLog('Failed to generate diary summary', err.message, 'ERROR');
    }
    return null;
  }

  async runDailySummary() { 
    const now = Date.now();
    if (now - this.lastSummary < this.SUMMARY_INTERVAL_MS && this.lastSummary > 0) {
      return null;
    }
    const summary = await this.generateSummary();
    if (summary) {
      this.lastSummary = now;
    }
    return summary;
  }

  _emitLog(message: any, detail: any, level: any) {
    this._emit('system.log', { message, detail, level });
  }
}

// ─── Worker Implementation ───

class DiaryWorker extends WorkerBase {
  ok: any;
  text: any;
  status: any;
  json: any;
  config: any;
  _emit: any;
  entries: any;
  lastSummary: any;
  DIARY_DIR: any;
  SUMMARY_INTERVAL_MS: any;

  constructor() {
    super();
    this._diary = null;
    this._summaryTimer = null;
  }

  _onInit(payload: any) { 
    const config = payload.config || {};
    this._diary = new DiaryWorkerImpl(config, (method: any, data: any) => this.emit(method, data));

    // Register method handlers
    this._registerMethod(METHOD.DIARY_LOG_ENTRY, (p: any) => {
      this._diary.logEntry(p.type, p.message, p.data);
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_LOG_ACTION, (p: any) => {
      this._diary.logEntry('action', `Action: ${p.action} on ${p.state}`, {
        action: p.action, state: p.state, success: p.success, reasoning: p.reasoning,
      });
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_LOG_DECISION, (p: any) => {
      this._diary.logEntry('decision', `Decision: ${p.decision}`, p.context);
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_LOG_ERROR, (p: any) => {
      const errObj = p.error || { message: 'Unknown error' };
      this._diary.logEntry('error', `Error: ${errObj.message}`, { stack: errObj.stack, ...p.context });
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_LOG_STATE_TRANS, (p: any) => {
      this._diary.logEntry('transition', `State: ${p.from} -> ${p.to}`, { from: p.from, to: p.to, reason: p.reason });
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_LOG_METRIC, (p: any) => {
      this._diary.logEntry('metric', `${p.name}: ${p.value} ${p.unit}`, { name: p.name, value: p.value, unit: p.unit });
      return { ok: true };
    });

    this._registerMethod(METHOD.DIARY_GET_TODAY, () => {
      return this._diary.getTodayEntries();
    });

    this._registerMethod(METHOD.DIARY_GET_SUMMARY, async () => {
      return this._diary.runDailySummary();
    });

    // Start daily summary timer
    this._summaryTimer = setInterval(() => {
      this._diary.runDailySummary().catch(() => {});
    }, 24 * 60 * 60 * 1000);

    // First summary after 60 seconds
    setTimeout(() => {
      this._diary.runDailySummary().catch(() => {});
    }, 60000).unref();

    if (this._summaryTimer.unref) this._summaryTimer.unref();
  }

  _onShutdown() { 
    if (this._summaryTimer) {
      clearInterval(this._summaryTimer);
      this._summaryTimer = null;
    }
  }

  _healthCheck() { 
    const base = super._healthCheck();
    return {
      ...base,
      entriesCount: this._diary ? this._diary.entries.length : 0,
      lastSummary: this._diary ? this._diary.lastSummary : 0,
    };
  }
}

// ─── Entry Point ───
new DiaryWorker().run();