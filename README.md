# MathU Bot — Autonomous Render Free-Tier Edition

Autonomous educational platform bot for the MathU Flutter Web SPA. Runs unattended on **Render's free tier** (512MB RAM, `--single-process` mode) for extended periods without human intervention. Multi-provider AI vision tribunal, code-patch self-heal pipeline, action cache with sequential mode, pixel fallback, and session-preservation swipe.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [Vision Providers (Tribunal)](#vision-providers-tribunal)
4. [Codegen Providers (Self-Heal)](#codegen-providers-self-heal)
5. [Self-Heal System](#self-heal-system)
6. [Action Cache & Sequential Mode](#action-cache--sequential-mode)
7. [Fallback Chain](#fallback-chain)
8. [Memory Management](#memory-management)
9. [Proxy Rotation](#proxy-rotation)
10. [API Endpoints](#api-endpoints)
11. [Environment Variables](#environment-variables)
12. [Troubleshooting](#troubleshooting)
13. [Recent Fixes](#recent-fixes)

---

## Quick Start

1. **Create a Render free-tier Web Service** (Docker)

2. **Set Environment Variables** (Settings → Environment):
   - `MICROSOFT_EMAIL` — Your MathU login email
   - `MICROSOFT_PASSWORD` — Your MathU login password
   - At least one vision provider key (see [Vision Providers](#vision-providers-tribunal))
   - At least one codegen provider key (see [Codegen Providers](#codegen-providers-self-heal))

3. **Push this code** to your Render service's connected repository

4. **Wait for build** (~5-10 min first time, ~2-3 min after)

5. **Optional**: Set up [UptimeRobot](https://uptimerobot.com/) to ping `https://your-service.onrender.com/health` every 5 min

---

## Architecture

```
cycle-orchestrator.ts (entry point)
  └─ cycle-cycle-manager.ts (main cycle loop)
       ├─ 1. Screenshot capture (CDP-based, bypasses font-waiting)
       ├─ 2. Auth guard (SPA session check, re-auth on expiry)
       ├─ 3. Action cache lookup (state-fingerprint + state-only fallback)
       ├─ 4. Vision tribunal (parallel providers OR sequential mode)
       ├─ 5. Pixel fallback (if tribunal fails)
       ├─ 6. Session-preservation swipe (if pixel fallback fails)
       ├─ 7. Action execution (click, input, swipe, etc.)
       ├─ 8. Cache save (unless state is cache-banned)
       └─ 9. Stagnation / progress tracking
            └─ E_PROGRESS_STALL after 60min → full self-heal

Self-heal pipeline (triggered on E_PROGRESS_STALL, restart storms, blank-page escalation):
  └─ self-heal.ts
       ├─ Step 1: Runtime heal fast-pass (7 avenues, runs on transient errors)
       └─ Step 2: Code-patch pipeline (runs on DESPERATE errors, skipRuntimeHeal=true)
            ├─ investigatePage() — gather page state + error logs
            ├─ enrichInvestigationWithTargetFile() — infer target file from error
            ├─ _aiIdentifyTargetFile() — two-pass file identification
            ├─ generateCodeFixViaTribunal() — parallel codegen providers
            │    ├─ BazaarLink (3 models, parallel)
            │    ├─ Mistral (1 model, parallel)
            │    └─ VoidAI (top 3 of 7 models, parallel)
            ├─ Patch voting consensus (2+ agreements = high confidence)
            ├─ validateFixArray (rejects hallucinated files, bulk rewrites)
            ├─ applyFixesToStaging() — write to /tmp/self-heal-overlay/
            └─ Process restart to apply changes cleanly
```

---

## Vision Providers (Tribunal)

The vision tribunal (`providers-tribunal.ts`) calls multiple LLMs in parallel, then runs a weighted consensus algorithm. Each provider's vote is weighted by:
- **Health score** (0.0-1.0) — success rate, latency, error diversity
- **Confidence** (0.0-1.0) — extracted from the provider's response
- **Latency inverse** — faster responses get slightly higher weight

### Available Vision Providers

| Provider | API Key Env Var | Model | Notes |
|---|---|---|---|
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Free tier, 30 req/min |
| **z.ai** | `ZAI_API_KEY` | `GLM-4.6V-Flash` | Vision-capable |
| **Agnes** | `AGNES_API_KEY` | `agnes-2.0-flash` | Vision-capable |
| **NVIDIA** | `NVIDIA_API_KEY` | `meta/llama-3.1-8b-instruct` | Free tier |
| **Cloudflare** | `CLOUDFLARE_API_KEY` | `@cf/meta/llama-4-scout-17b-16e-instruct` + `@cf/google/gemma-4-26b-a4b-it` | Workers AI |
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | Free tier |
| **OpenRouter** | `OPENROUTER_API_KEY` | `google/gemma-4-31b-it:free` | 50 free req/day, resets at midnight |

### Tribunal Modes

- **Parallel mode** (default): All healthy providers called simultaneously. Best consensus quality.
- **Sequential mode**: One provider at a time, most-trusted first. Activated when:
  - All parallel providers fail in a single round (instant switch, Task 69)
  - Sustained no-providers for 30+ minutes (DB-persisted flag)
  - Cleared when a sequential round succeeds OR at midnight (quota reset)

### No-Providers Pause

If ALL providers are unavailable for 30+ minutes straight:
1. Sequential mode is enabled (persisted to DB)
2. Bot pauses for 3 hours (doesn't touch the browser)
3. Resumes automatically when pause expires
4. Midnight reset clears the sequential flag (quotas reset)

---

## Codegen Providers (Self-Heal)

The codegen tribunal (`providers-codegen-tribunal.ts`) is called by the self-heal code-patch pipeline. It runs code-generation LLMs in parallel to produce `{file, change, patch}` arrays, then runs patch voting consensus.

### Available Codegen Providers

| Provider | API Key Env Var | Primary Model | Notes |
|---|---|---|---|
| **BazaarLink** | `BAZAARLINK_API_KEY` | `auto:free` | 50 free req/day, rate-limited |
| **VoidAI** | `VOIDAI_API_KEY` | `gpt-5.3-codex` | OpenAI SDK with `api.voidai.app` baseURL |
| **Mistral** | `MISTRAL_CODE_API_KEY` | `codestral-latest` | Dedicated codegen |

### VoidAI Models (Task 67)

The following 7 VoidAI models are configured (top 3 are tried per tribunal round):

1. `gpt-5.3-codex` (primary, best for code generation)
2. `claude-haiku-4-5-20251001`
3. `deepseek-v4-pro`
4. `qwen3-coder-480b-a35b-instruct`
5. `kimi-k2.7-code`
6. `glm-5.3`
7. `qwen3.8-27b:free`

### Parallel Calling (Task 71)

All codegen providers run in **parallel** via `Promise.allSettled`:
- BazaarLink: 3 models spawned simultaneously
- Mistral: 1 model spawned simultaneously
- VoidAI: top 3 models spawned simultaneously
- Total wall-clock time: ~60-90s (was ~140s with old sequential blocking)
- Budget guard: stops spawning more models when <15s of the 120s tribunal timeout remains

### Non-Codegen Fallback

If ALL dedicated codegen providers fail AND this is a repeated failure (attempt 2+), the tribunal falls back to general vision providers (Groq, z.ai, NVIDIA, etc.) with the codegen prompt. Capped at 3 providers to conserve quota.

---

## Self-Heal System

The self-heal system (`self-heal.ts`) has two tiers:

### Tier 1: Runtime Heal Fast-Pass

Runs on every healable error. 7 avenues in parallel:
1. **Database repair** — DB integrity check
2. **Config reconcile** — sync with remote config
3. **Selector reload** — evict selector module from `require.cache`
4. **Module quarantine reset** — clear quarantined modules
5. **Provider reset** — fix stale/EOL models, reset circuits
6. **Auth refresh** — re-authenticate if needed
7. **Cache flush** — clear all caches

If any avenue succeeds, the fast-pass returns `true` and the code-patch pipeline is skipped.

### Tier 2: Code-Patch Pipeline

Triggered on DESPERATE errors (E_PROGRESS_STALL, restart storms, blank-page escalation). Always passes `skipRuntimeHeal: true` (Task 70) so the codegen tribunal actually runs.

**Steps:**
1. `investigatePage()` — gather screenshot, HTML, URL
2. `enrichInvestigationWithTargetFile()` — infer target file from error pattern
3. `_aiIdentifyTargetFile()` — two-pass: AI picks the file, then reads its full content
4. `generateCodeFixViaTribunal()` — parallel codegen providers (Task 71)
5. Patch voting consensus — 2+ agreements = high confidence
6. `validateFixArray()` — rejects:
   - Files not matching `PATCHABLE_PREFIXES`
   - Files that don't exist on disk (hallucinated)
   - More than 3 fixes per response (bulk rewrite protection)
   - Total patch size > 100KB
7. `applyFixesToStaging()` — write patches to `/tmp/self-heal-overlay/`
8. Process restart — overlay interceptor makes Node load patched files

### /tmp Overlay System

On Render (read-only filesystem), patches are written to `/tmp/self-heal-overlay/`. A `require()` interceptor redirects module loads to the overlay. The overlay is repopulated from `patch_history` DB on each boot, so patches survive restarts.

### Self-Heal Session

- **No timeout** (Task 65) — session runs until explicitly ended
- Progress saved to DB (survives OOM kills)
- Memory protection mode lifts automatically when session starts

---

## Action Cache & Sequential Mode

### Action Cache (`services-action-cache.ts`)

Caches tribunal-decided actions keyed by:
- **Exact match**: Screenshot fingerprint (region-based similarity)
- **Similar match**: Similarity threshold 0.50, length tolerance ±10KB
- **State-only fallback**: Any cached action for the same state label

**Cache-banned states** (never cached — these require fresh AI analysis):
- `loading`, `exploration` (without proof), `error`, `unknown`
- Multiple-choice questions (until `_answerSubmitted` is set)
- States requiring human intervention

**Eviction**: If a cached action doesn't change the screenshot for 3 consecutive cycles, it's evicted.

**Turso sync**: Cache entries are synced to Turso (cloud SQLite) when heap allows.

### Sequential Provider Mode

When the bot proves it lacks providers across restarts:
1. Tribunal switches from parallel to sequential (one provider at a time)
2. Most-trusted provider first (sorted by health score)
3. Stops at first success — saves free-tier API quota
4. **Instant switch** (Task 69): if a parallel round produces 0 valid responses, sequential mode activates immediately (no 30-min wait)
5. **Midnight reset**: cleared daily when API quotas reset

---

## Fallback Chain

When the vision tribunal can't produce a confident action, the bot falls through this chain:

1. **Tribunal result** (parallel or sequential)
2. **Pixel fallback** (`pixel-fallback.ts`) — CDP-based screenshot capture, analyzes pixels to find clickable elements. Bypasses Playwright font-waiting. Never times out (Task 68).
3. **Session-preservation swipe** (Task 50) — Random `flutter_swipe` to keep the Flutter session alive while waiting for providers to recover. Better than just waiting.
4. **No-providers pause** — After 30 min of sustained provider failure, bot pauses 3h (doesn't touch browser).

---

## Memory Management

On Render free tier (512MB RAM):

| Threshold | Value | Action |
|---|---|---|
| V8 heap limit | 448 MB | `--max-old-space-size=448` |
| Early OOM guard | 350 MB | Triggers memory shed (L2: page reload) |
| Hard restart heap | 380 MB | Process restart via survival-restart-guardian |
| Pre-tribunal shield | 70% of limit | Forces L2 page reload before provider calls |
| GC interval | 90s | Automatic GC when in memory protection |

Memory shedding levels:
- **L1**: Clear caches (screenshots, action cache, provider state)
- **L2**: Page reload (preserves browser)
- **L3**: Browser close + relaunch

---

## Proxy Rotation

ProxyScrape integration with per-context proxy (`network-ip-rotator.ts`):

- **TCP validation**: `validateProxy()` via raw TCP socket before use
- **Per-context proxy**: `proxy: { server: 'per-context' }` only when proxy is active
- **Full shutdown**: `bypassProxy()` clears HTTP_PROXY, HTTPS_PROXY, NO_PROXY env vars + resets state
- **Error tracking**: 12+ error types recorded (`recordNetworkError()`)
- **Navigation recovery**: 3-attempt retry (proxy → rotated → direct)

---

## API Endpoints

### Status & Health

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Status dashboard (dark theme HTML) |
| `/health` | GET | Health check JSON (used by keepalive + Render monitoring) |
| `/api/status` | GET | Detailed status JSON |
| `/api/metrics` | GET | Performance metrics JSON |
| `/api/container` | GET | DI container health |

### Cycle Control

| Endpoint | Method | Description |
|---|---|---|
| `/api/run-cycle` | POST | Manually trigger a cycle |
| `/api/browser/headed` | POST | Switch browser to headed mode (for debugging) |
| `/api/browser/headless` | POST | Switch browser to headless mode |

### Self-Heal Control

| Endpoint | Method | Description |
|---|---|---|
| `/api/self-heal/trigger` | POST | Manually trigger full self-heal (code-patch pipeline) |
| `/api/self-heal/session` | GET | Self-heal session status |

### Intervention Control

| Endpoint | Method | Description |
|---|---|---|
| `/api/intervention/pause` | POST | Pause the bot (human intervention) |
| `/api/intervention/resume` | POST | Resume the bot |
| `/api/intervention/status` | GET | Intervention status |

### Health Response Fields

The `/api/health` endpoint includes:
- `noProvidersPause` — true when bot is in 3h no-providers pause
- `humanIntervention` — true when bot is paused for human intervention
- `sequentialMode` — true when tribunal is using sequential single-provider mode
- `consecutiveFailures` — current failure count
- `healthScore` — overall provider health (0.0-1.0)

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `MICROSOFT_EMAIL` | MathU login email |
| `MICROSOFT_PASSWORD` | MathU login password |

### Vision Providers (at least one recommended)

| Variable | Provider |
|---|---|
| `GROQ_API_KEY` | Groq |
| `ZAI_API_KEY` | z.ai |
| `AGNES_API_KEY` | Agnes |
| `NVIDIA_API_KEY` | NVIDIA |
| `CLOUDFLARE_API_KEY` | Cloudflare Workers AI |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |

### Codegen Providers (at least one recommended for self-heal)

| Variable | Provider |
|---|---|
| `BAZAARLINK_API_KEY` | BazaarLink |
| `VOIDAI_API_KEY` | VoidAI |
| `MISTRAL_CODE_API_KEY` | Mistral |

### Optional Configuration

| Variable | Default | Description |
|---|---|---|
| `SELF_HEAL_ENABLED` | `true` | Enable self-heal system |
| `SELF_HEAL_MANUAL_OVERRIDE` | (unset) | Skip self-heal entirely |
| `SELF_HEAL_MAX_ATTEMPTS` | `3` | Max codegen retry attempts |
| `SELF_HEAL_TRIBUNAL_TIMEOUT_MS` | `120000` | Codegen tribunal timeout |
| `MAX_QUESTIONS` | varies | Max questions per cycle |
| `SANDBOX_MODE` | `false` | Test without credentials |
| `DISPLAY_WIDTH` | `1280` | Browser viewport width |
| `DISPLAY_HEIGHT` | `720` | Browser viewport height |
| `BEACON_URL` | (unset) | Heartbeat beacon URL |

---

## Troubleshooting

**Bot stuck in "wait" loops?**
- Check if providers are rate-limited (429 errors in logs)
- Sequential mode should activate automatically (look for "INSTANT switch to SEQUENTIAL MODE")
- Pixel fallback + session-preservation swipe should keep the bot functional

**Self-heal reports "successful" but nothing changes?**
- Verify Task 70 fix is deployed: logs should show "Attempting full self-heal (code-patch pipeline)..."
- Check for "CODEGEN TRIBUNAL: Consulting N models" — if absent, the codegen tribunal isn't running
- Look for "Tribunal: spawning BL/... (parallel)" — confirms Task 71 parallel calling

**Codegen tribunal times out?**
- Verify Task 71 fix: logs should show "capping VoidAI from 7 to top 3 models"
- Check API keys are set: `BAZAARLINK_API_KEY`, `VOIDAI_API_KEY`, `MISTRAL_CODE_API_KEY`

**Out of memory?**
- V8 heap limit is 448MB on Render free tier
- Early OOM guard triggers at 350MB
- Reduce `MAX_QUESTIONS` per cycle
- Disable self-heal: `SELF_HEAL_ENABLED=false`

**Browser fails to launch?**
- Check Docker build logs for Playwright install errors
- Verify `--no-sandbox` is in Chrome flags (already default)
- Xvfb runs on display 99 for headed mode debugging

**Proxy errors?**
- Look for "Proxy BYPASSED" — bot automatically falls back to direct connection
- `bypassProxy()` fully clears env vars + state

**Need to debug visually?**
- POST to `/api/browser/headed` to switch to headed mode
- The bot will use Xvfb on display 99
- POST to `/api/browser/headless` to switch back

---

## Recent Fixes

### Task 69 — Instant Parallel→Sequential Switch
When a parallel tribunal round produces 0 valid responses, sequential mode activates immediately (no 30-min wait). Cleared after a successful sequential round.

### Task 70 — Self-Heal Now Actually Calls Codegen
The DESPERATE self-heal trigger was calling `performSelfHeal()` without `skipRuntimeHeal: true`, so the runtime heal fast-pass would always "succeed" (clearing caches) and the codegen tribunal was never invoked. Fixed: all `performSelfHeal()` calls now pass `skipRuntimeHeal: true`.

### Task 71 — Codegen Tribunal Parallel Calling
The codegen tribunal was sequentially blocking all providers — BazaarLink's 3 models had to complete before Mistral, before VoidAI's 7 models. Total ~140s exceeded the 120s timeout. Fixed: all providers now spawn in parallel via `Promise.allSettled`. VoidAI capped to top 3 models. Budget guard stops spawning when <15s remains.

### Task 67 — Provider Model Fixes
- Groq: `qwen/qwen3.6-27b` → `llama-3.3-70b-versatile` (404 fix)
- NVIDIA: `meta/llama-3.1-70b-instruct` → `meta/llama-3.1-8b-instruct` (410 EOL fix)
- Gemini: removed all deprecated fallbacks, only `gemini-2.5-flash` remains
- Cloudflare: removed `@cf/moonshotai/kimi-k2.5` (403 forbidden)
- DB stale model cleanup on boot

### Task 68 — Pixel Fallback on Non-Login Waits
Pixel fallback now activates on ANY "wait" action on non-login states, not just error/unknown states.

### Task 50 — Session-Preservation Swipe
When all providers AND pixel fallback fail, the bot does a random `flutter_swipe` to keep the Flutter session alive.

---

## License

MIT
