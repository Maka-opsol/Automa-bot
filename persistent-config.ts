
168
169
170
171
172
173
174
175
176
177
178
179
180
181
182
183
184
185
186
187
188
189
190
191
192
193
194
195
196
197
198
199
200
201
202
203
204
205
206
207
208
209
210
211
212
213
214
215
216
217
218
219
220
221
222
223
224
⌄
⌄
⌄
⌄
⌄
⌄
⌄
⌄
// ═══════════════════════════════════════════════════════════════════════
// Persistent Config & State Ban Store

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
  // Lifecycle
  flush,
  getStoreInfo,
};
