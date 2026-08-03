# MathU Bot v5 — Hugging Face Spaces Edition

Autonomous educational platform bot. Runs unattended on Hugging Face Spaces (free CPU tier) for years without human intervention.

## What Changed vs. Original v5

| Problem | Original | HF Spaces Fix |
|---|---|---|
| **48h sleep** | No keepalive | Internal pinger every 4min + optional UptimeRobot external ping |
| **process.exit()** everywhere | Kills container, loses keepalive | `process.exit` intercepted; browser cleanup + GC recovery instead |
| **Memory limits 350/360MB** | Tuned for Render 512MB | Tuned for HF 16GB: 3072/3584MB |
| **10-16h sleep between cycles** | Designed for stealth | 15-30min on HF Spaces (keeps space active) |
| **MAX_UPTIME_HOURS=24** | Forced restart daily | Disabled (`MAX_UPTIME_HOURS=0`) |
| **100 cycles then exit** | `process.exit(0)` | Counter resets, bot continues |
| **No web server first** | Daemon blocks event loop | HTTP server on `$PORT` starts immediately |
| **Watchdog** | Separate process | Removed (HF manages lifecycle) |
| **All paths under PROJECT_ROOT** | Ephemeral on restart | `/data/` volume for DB, logs, state |
| **No Dockerfile** | | Custom Dockerfile with Playwright + Chromium |

## Quick Start

1. **Create a HF Space** (Docker, Free CPU)

2. **Set Secrets** (Settings → Repository secrets):
   - `MICROSOFT_EMAIL` — Your MathU login email
   - `MICROSOFT_PASSWORD` — Your MathU login password
   - `GROQ_API_KEY` — (Recommended) Free vision provider
   - `GEMINI_API_KEY` — (Optional) Google Gemini
   - `OPENROUTER_API_KEY` — (Optional) Free code-gen for self-heal

3. **Set Variables** (Settings → Environment variables):
   - `KEEPALIVE_PING_URL` — UptimeRobot ping URL (see below)

4. **Push this code** to the Space repository

5. **Wait for build** (~5-10 min first time, ~2-3 min after)

## Keepalive Strategy (Critical for 5-Year Operation)

HF Spaces sleeps containers after 48 hours of no HTTP traffic. Two-layer defense:

### Layer 1: Internal Self-Ping
Already built into `hf-spaces.ts`. Pings `http://localhost:7860/health` every 4 minutes. **Zero cost, always active.**

### Layer 2: External UptimeRobot (Recommended)
If the container IS restarted (HF maintenance, crash), Layer 1 is dead until the container wakes up. UptimeRobot wakes it:

1. Create a free [UptimeRobot](https://uptimerobot.com/) account
2. Add a monitor: type `HTTP(s)`, URL `https://your-username-mathu-bot.hf.space/health`
3. Set interval to 5 minutes
4. UptimeRobot will ping your space every 5 minutes → HF keeps it awake

Copy the UptimeRobot ping URL (from their docs) and set it as `KEEPALIVE_PING_URL` secret.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Status dashboard (dark theme HTML) |
| `/health` | GET | Health check (JSON, used by keepalive + HF monitoring) |
| `/api/status` | GET | Detailed status JSON |
| `/api/metrics` | GET | Performance metrics JSON |
| `/api/container` | GET | DI container health |
| `/api/run-cycle` | POST | Manually trigger a cycle (debugging) |

## Memory Management

On 16GB CPU instances:
- **Warning** at 3072 MB → closes browser, triggers GC
- **Critical** at 3584 MB → aggressive browser cleanup + GC
- **V8 heap limit**: 3584 MB (`--max-old-space-size=3584`)
- Never `process.exit()` — recovers in-place

## Ephemeral State

All data (SQLite DB, logs, screenshots, checkpoints) is stored in `/data/`. This is **ephemeral** — lost on container restart. The bot starts fresh each time but this is fine because:
- Provider health and budgets reset (good — prevents stale state)
- Self-heal history resets (acceptable — healing is idempotent)
- The bot re-seeds its active model on startup

For persistent state, set `REMOTE_BRAIN_URL` to an external database or API.

## Free Tier Cost

| Service | Cost | Notes |
|---|---|---|
| HF Spaces CPU | $0/mo | Free forever (with keepalive) |
| Groq API | $0/mo | Free tier: 30 req/min, unlimited tokens |
| Gemini API | $0/mo | Free tier available |
| OpenRouter | $0/mo | `openrouter/free` models available |
| UptimeRobot | $0/mo | 50 monitors free |
| **Total** | **$0/mo** | **5 years = $0** |

## Architecture

```
hf-spaces.ts (entry point)
  ├─ HTTP server on $PORT (immediate, for HF + keepalive)
  ├─ Keepalive pinger (every 4min)
  ├─ process.exit() interceptor
  ├─ Memory manager (GC + browser cleanup, no exit)
  └─ startDaemon() (background, non-blocking)
       └─ cycle-orchestrator.ts
            ├─ HF Spaces: 15-30min sleep between cycles
            ├─ HF Spaces: cycle counter resets (never exits)
            └─ HF Spaces: 5min max backoff on errors
```

## Troubleshooting

**Space keeps sleeping?**
- Verify UptimeRobot is hitting `/health` every 5 min
- Check HF Space logs — look for "Keepalive ping OK"

**Out of memory?**
- Increase `MEMORY_RESTART_THRESHOLD_MB` (up to 14336 on 16GB)
- Reduce `MAX_QUESTIONS` per cycle
- Disable self-heal: `SELF_HEAL_ENABLED=false`

**Browser fails to launch?**
- Check Docker build logs for Playwright install errors
- Verify `--no-sandbox` is in Chrome flags (already default)
- Try setting `CHROMIUM_EXECUTABLE_PATH` to Playwright's bundled path

**Cycle errors?**
- Set `SANDBOX_MODE=true` to test without credentials
- Check `/api/health` for current state
- Use `/api/run-cycle` to trigger a manual cycle

## License

MIT — U.S.J Sibiya