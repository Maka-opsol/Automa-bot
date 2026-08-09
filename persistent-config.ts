'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Persistent Config & State Ban Store
// ═══════════════════════════════════════════════════════════════════════
// Stores dashboard-changed configs and banned states to /tmp so they
// survive process restarts (same Render instance). Lost only on
// redeploy or Render instance change (which is expected on free plan).
//
// Storage format: JSON file at /tmp/mathu-persist.json
// {
//   configs: { KEY: value, ... },
//   bannedStates: { state: { reason, bannedAt, bannedBy }, ... },
//   forcedState: { state, reason, forcedAt } | null,
//   version: 1
// }
//
// Coalesced writes: multiple changes within 2s are batched into one write.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');

const PERSIST_PATH = path.join(os.tmpdir(), 'mathu-persist.json');
const COALESCE_DELAY_MS = 2000;
const VERSION = 1;

interface PersistData {
  configs: Record<string, any>;
  bannedStates: Record<string, { reason: string; bannedAt: number; bannedBy: string }>;
  forcedState: { state: string; reason: string; forcedAt: number } | null;
  mode: {
    current: 'full_power' | 'memory_protection';
    switchedAt: number;
    reason: string;
    autoSwitch: boolean;
  };
  memoryReadings: Array<{ ts: number; heapMB: number; rssMB: number }>;
  version: number;
}

let _data: PersistData | null = null;
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _dirty = false;

function _load(): PersistData {
  if (_data) return _data;
  try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === VERSION) {
      _data = parsed;
      return _data;
    }
  } catch {
    // File doesn't exist or corrupt — start fresh
  }
  _data = {
    configs: {},
    bannedStates: {},
    forcedState: null,
    mode: { current: 'full_power', switchedAt: Date.now(), reason: 'initial', autoSwitch: false },
    memoryReadings: [],
    version: VERSION,
  };
  return _data;
}

function _scheduleWrite(): void {
  if (_writeTimer) return;
  _dirty = true;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    if (!_dirty) return;
    _dirty = false;
    try {
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(_data, null, 2), 'utf8');
    } catch (writeErr: any) {
      console.error(`[persistent-config] Write failed: ${writeErr.message}`);
    }
  }, COALESCE_DELAY_MS);
  // Don't prevent process exit for coalesced writes — use unref
  if (_writeTimer && typeof (_writeTimer as any).unref === 'function') {
    (_writeTimer as any).unref();
  }
}

// Force immediate flush (for shutdown)
function flush(): void {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  if (!_data || !_dirty) return;
  _dirty = false;
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(_data, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

// ── Config persistence ──

function setConfigOverride(key: string, value: any): void {
  const d = _load();
  d.configs[key] = value;
  _scheduleWrite();
}

function getConfigOverride(key: string): any {
  const d = _load();
  return d.configs[key] !== undefined ? d.configs[key] : undefined;
}

function getAllConfigOverrides(): Record<string, any> {
  const d = _load();
  return { ...d.configs };
}

function removeConfigOverride(key: string): void {
  const d = _load();
  delete d.configs[key];
  _scheduleWrite();
}

function clearAllConfigOverrides(): void {
  const d = _load();
  d.configs = {};
  _scheduleWrite();
}

// ── Banned states persistence ──

function setBannedState(state: string, reason: string, bannedBy: string = 'dashboard'): void {
  const d = _load();
  d.bannedStates[state] = { reason, bannedAt: Date.now(), bannedBy };
  _scheduleWrite();
}

function removeBannedState(state: string): void {
  const d = _load();
  delete d.bannedStates[state];
  _scheduleWrite();
}

function isStateBanned(state: string): boolean {
  const d = _load();
  return state in d.bannedStates;
}

function getAllBannedStates(): Array<{ state: string; reason: string; bannedAt: number; bannedBy: string }> {
  const d = _load();
  return Object.entries(d.bannedStates).map(([state, info]) => ({
    state,
    reason: info.reason,
    bannedAt: info.bannedAt,
    bannedBy: info.bannedBy,
  }));
}

function clearAllBannedStates(): void {
  const d = _load();
  d.bannedStates = {};
  _scheduleWrite();
}

// ── Forced state persistence ──

function setForcedState(state: string, reason: string): void {
  const d = _load();
  d.forcedState = { state, reason, forcedAt: Date.now() };
  _scheduleWrite();
}

function getForcedState(): { state: string; reason: string; forcedAt: number } | null {
  const d = _load();
  return d.forcedState;
}

function clearForcedState(): void {
  const d = _load();
  d.forcedState = null;
  _scheduleWrite();
}

// ── Diagnostics ──

function getStoreInfo(): { path: string; size: number; configCount: number; bannedStateCount: number; hasForcedState: boolean } {
  try {
    const stat = fs.statSync(PERSIST_PATH);
    const d = _load();
    return {
      path: PERSIST_PATH,
      size: stat.size,
      configCount: Object.keys(d.configs).length,
      bannedStateCount: Object.keys(d.bannedStates).length,
      hasForcedState: d.forcedState !== null,
    };
  } catch {
    return {
      path: PERSIST_PATH,
      size: 0,
      configCount: 0,
      bannedStateCount: 0,
      hasForcedState: false,
    };
  }
}

// ── Operational Mode ──

function setMode(mode: 'full_power' | 'memory_protection', reason: string, autoSwitch: boolean = false): void {
  const d = _load();
  d.mode = { current: mode, switchedAt: Date.now(), reason, autoSwitch };
  _scheduleWrite();
}

function getMode(): { current: 'full_power' | 'memory_protection'; switchedAt: number; reason: string; autoSwitch: boolean } {
  const d = _load();
  return { ...d.mode };
}

// ── Memory Readings (ring buffer for history-based detection) ──

const MEMORY_READINGS_MAX = 100;

function pushMemoryReading(heapMB: number, rssMB: number): void {
  const d = _load();
  d.memoryReadings.push({ ts: Date.now(), heapMB, rssMB });
  // Keep only last N readings to bound file size
  if (d.memoryReadings.length > MEMORY_READINGS_MAX) {
    d.memoryReadings = d.memoryReadings.slice(-MEMORY_READINGS_MAX);
  }
  _scheduleWrite();
}

function getMemoryReadings(): Array<{ ts: number; heapMB: number; rssMB: number }> {
  const d = _load();
  return [...d.memoryReadings];
}

/** Get the peak heap and RSS from the last N minutes of readings */
function getRecentPeak(minutes: number = 30): { peakHeapMB: number; peakRssMB: number; count: number } {
  const d = _load();
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recent = d.memoryReadings.filter(r => r.ts >= cutoff);
  if (recent.length === 0) return { peakHeapMB: 0, peakRssMB: 0, count: 0 };
  return {
    peakHeapMB: Math.max(...recent.map(r => r.heapMB)),
    peakRssMB: Math.max(...recent.map(r => r.rssMB)),
    count: recent.length,
  };
}

/** Check if the process was recently OOM-killed (no recent readings but had high readings before) */
function wasRecentlyOOMKilled(): boolean {
  const d = _load();
  if (d.memoryReadings.length < 5) return false;
  // If the last reading is older than 5 minutes but readings existed before,
  // the process likely crashed (OOM kill)
  const lastReading = d.memoryReadings[d.memoryReadings.length - 1];
  if (Date.now() - lastReading.ts > 5 * 60 * 1000) {
    // Check if last few readings were high
    const last5 = d.memoryReadings.slice(-5);
    const avgHeap = last5.reduce((s, r) => s + r.heapMB, 0) / last5.length;
    return avgHeap > 300; // Was running hot before the gap
  }
  return false;
}

module.exports = {
  // Configs
  setConfigOverride,
  getConfigOverride,
  getAllConfigOverrides,
  removeConfigOverride,
  clearAllConfigOverrides,
  // Banned states
  setBannedState,
  removeBannedState,
  isStateBanned,
  getAllBannedStates,
  clearAllBannedStates,
  // Forced state
  setForcedState,
  getForcedState,
  clearForcedState,
  // Operational mode
  setMode,
  getMode,
  // Memory readings
  pushMemoryReading,
  getMemoryReadings,
  getRecentPeak,
  wasRecentlyOOMKilled,
  // Lifecycle
  flush,
  getStoreInfo,
};
