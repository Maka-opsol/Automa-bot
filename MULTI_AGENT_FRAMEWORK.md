# Multi-Agent Improvement Framework

> **Purpose**: This document defines how two AI agents — **Toqi** and **Zapia** — collaborate to improve the MathU Bot. Every agent that submits patches via the dashboard MUST read this framework first and follow its rules.
>
> **How to fetch this document programmatically**: `GET /api/improvement/framework` returns this as structured JSON.
>
> **Last updated**: 2026-10-26

---

## 1. The Two Agents

There are exactly **two AI agents**: **Toqi** and **Zapia**. Both do the full improvement loop (review → analyze → improve → test) on **alternating shifts**. Each runs hourly, offset by 30 minutes so they don't collide.

### Toqi
- **Shift**: Runs at the top of each hour (`:00`)
- **Full loop**: Review logs → Analyze patterns → Write/submit patches → Test results
- **Coordinator role**: When running, Toqi acts as the coordinator — checks the deploy budget, reviews recent proposals, decides priorities

### Zapia
- **Shift**: Runs at the half-hour mark (`:30`)
- **Full loop**: Same as Toqi — Review logs → Analyze patterns → Write/submit patches → Test results
- **Coordinator role**: When running, Zapia acts as the coordinator — checks what Toqi did in the prior shift and either builds on it or addresses a different priority

### Why alternating shifts?
- **No collisions**: The patch pipeline serializes patches (only one runs at a time), so concurrent submissions would queue anyway. Alternating shifts avoid queue buildup.
- **Continuity**: Each agent's shift starts by reviewing what the OTHER agent did in the previous shift. Improvements compound across shifts.
- **Coverage**: One agent is always monitoring; the bot is never unattended for more than 30 minutes.

---

## 2. The Improvement Loop (both agents run this each shift)

Every shift, the active agent (Toqi or Zapia) follows this loop:

### Step 1: Review (find issues)
- **First, check if the bot is alive**: `GET /api/ping` (ultra-lightweight — no memory pressure)
  - If this returns 503 or times out, the bot is down. Wait 60s and retry.
  - If `rss_mb > 380`, the bot is under memory pressure. Non-essential API requests will return 503. Only use `/api/ping` until RSS drops below 380MB.
- Fetch recent logs: `GET /api/logs?limit=100` (skip if memory pressure)
- Fetch recent patch history: `GET /api/patch/history?limit=20` (lightweight — OK during memory pressure)
- Fetch the previous shift's summary: `GET /api/improvement/proposals?type=summary&limit=2` (lightweight — OK during memory pressure)
- Look for:
  - Errors that appear 3+ times (`ERROR`, `WARN`, `crash`, `timeout`)
  - Patches that FAILED the sandbox audit or AI advisory — understand WHY
  - Screenshot blank-check failures (search for `BLANK` in logs)
  - State transitions that consistently fail
  - The bot getting stuck (no progress in 10+ minutes)

### Step 2: Analyze (find patterns)
- Are the same errors repeating? (count occurrences)
- Are the same files being patched over and over? (sign of instability)
- Which AI providers are failing most often?
- Are there state machine dead-ends (states visited but never transition forward)?

### Step 3: Improve (write + submit patches)
- Pick ONE issue to fix (highest severity first — see priority levels in §5)
- Fetch the current source: `GET /api/patch/file?path=...`
- Use the **Diff Preview** feature in the dashboard to see exactly what will change
- Write the patch following the Change Proposal Template (see §4)
- Check the deploy budget: `GET /api/patch/budget` — if `paused` is true, DON'T submit (the deploy won't happen)
- Submit via `POST /api/patch/submit`
- **Log your work**: Submit a summary via `POST /api/improvement/proposals` with `type: "summary"` so the next agent knows what you did

### Step 4: Test (verify)
- Wait ~5 minutes after a patch is deployed
- Check `GET /api/patch/status/:id` — did all stages pass?
- Check `GET /api/health` — any new critical issues?
- Scan the latest logs for new errors that didn't exist before the patch
- If the patch broke something, submit a revert proposal immediately

---

## 3. Handoff Protocol (how Toqi and Zapia stay in sync)

Since the agents alternate shifts, the handoff between them is critical:

### When Toqi's shift ends (at :30, when Zapia starts)
1. Toqi submits a shift summary via `POST /api/improvement/proposals`:
   ```json
   {
     "type": "summary",
     "agent_role": "toqi",
     "shift": "2026-10-26T14:00:00Z",
     "issues_found": 2,
     "patches_submitted": 1,
     "patches_applied": 0,
     "patches_rejected": 0,
     "notes": "Found blank screenshot bug in pixel-fallback.ts. Submitted fix patch-X. Next agent should verify it deployed + check if the BLANK errors stopped."
   }
   ```
2. Zapia's shift starts by fetching this summary: `GET /api/improvement/proposals?type=summary&limit=1`
3. Zapia picks up where Toqi left off — verify the patch, check for new issues, or work on a different priority

### When Zapia's shift ends (at :00, when Toqi starts)
1. Zapia submits the same type of shift summary (with `agent_role: "zapia"`)
2. Toqi's shift starts by reviewing Zapia's summary

### What to include in the handoff summary
- What issues you found
- What patches you submitted (include patch IDs)
- What patches were applied/rejected (and why)
- What the next agent should focus on
- Any blockers (e.g. "OpenRouter rate-limited, couldn't audit — next agent should retry")
- Deploy budget status (if approaching the cap)

---

## 4. Standardized Hourly Checklist

Both Toqi and Zapia follow this checklist each shift:

### What to review
- [ ] Previous shift's summary (`GET /api/improvement/proposals?type=summary&limit=1`)
- [ ] Recent logs (`GET /api/logs?limit=100`)
- [ ] Recent patch history (`GET /api/patch/history?limit=20`)
- [ ] Deploy budget status (`GET /api/patch/budget` — check `paused` and `warn`)
- [ ] Current pipeline queue (from budget endpoint's `queueDepth`)

### What counts as "needs fixing"
- [ ] Error appears 3+ times in the last hour
- [ ] A patch was rejected — understand why (sandbox? AI advisory? dedup?)
- [ ] A state transition consistently fails
- [ ] The bot is stuck (no progress in 10+ minutes)
- [ ] Blank screenshots (page didn't load)

### How to write changes clearly
- [ ] Use the Change Proposal Template (see below)
- [ ] Reference the issue you're fixing (include the proposal ID)
- [ ] Explain WHY the change is needed (not just WHAT changed)
- [ ] Note any risks or side effects
- [ ] Submit a shift summary so the other agent knows what you did

### What NOT to touch
- [ ] State machine state names (string literals like `'assignments_page'`)
- [ ] URL detection patterns (`url.includes('assignment')` — preserves the URL fragment, not the word)
- [ ] DOM selectors (`.assignment-card` — preserves the selector, not the word)
- [ ] The sandbox/auditor/patching pipeline itself
- [ ] The Turso sync configuration
- [ ] Core identity (see CORE_IDENTITY.md)

### Change-log format
Every patch submission MUST include a `description` field in this format:
```
[AGENT] Fix: <one-line summary>
Issue: <proposal ID or "ad-hoc">
Root cause: <one sentence>
Change: <one sentence>
Risk: <low/medium/high> — <one sentence on what could break>
```

Example:
```
[TOQI] Fix: blank screenshots due to proxy re-activation
Issue: proposal-1792955610940
Root cause: network-ip-rotator.start() re-sets HTTP_PROXY env vars even when bypassProxy() was called
Change: start() now checks __proxyDisabled flag before activating proxy
Risk: low — only affects Render deployments where proxy is bypassed; direct-connection mode is unaffected
```

---

## 5. Templates

### Change Proposal Template

When proposing a change (via `POST /api/improvement/proposals` with `type: "proposal"`):

```json
{
  "type": "proposal",
  "agent_role": "toqi",
  "file": "pixel-fallback.ts",
  "title": "Fix blank screenshots by respecting bypass flag in start()",
  "severity": "critical",
  "issue_description": "Bot produces blank screenshots because proxy env vars are re-set by start() after bypassProxy() cleared them",
  "root_cause": "start() unconditionally sets process.env.HTTP_PROXY without checking __proxyDisabled",
  "proposed_change": "Add a check for __proxyDisabled at the top of start() and skip proxy activation if true",
  "risks": "low — only affects Render deployments; direct mode unaffected",
  "references": ["proposal-1792955610940"],
  "patch_id": "patch-1792937616320-07b8ml"
}
```

### Shift Summary Template

```json
{
  "type": "summary",
  "agent_role": "toqi",
  "shift": "2026-10-26T14:00:00Z",
  "issues_found": 2,
  "issues": [
    {
      "severity": "critical",
      "file": "network-ip-rotator.ts",
      "line": 655,
      "description": "start() re-activates proxy after bypassProxy() cleared env vars",
      "suggested_fix": "Check __proxyDisabled before setting HTTP_PROXY"
    },
    {
      "severity": "moderate",
      "file": "pixel-fallback.ts",
      "line": 2550,
      "description": "url.includes('assignment') may miss new URL format — check for updated paths",
      "suggested_fix": "Add additional URL pattern check"
    }
  ],
  "patches_submitted": 1,
  "patches_applied": 0,
  "patches_rejected": 0,
  "notes": "Submitted fix for proxy bug. Next agent (Zapia) should verify it deployed and check if BLANK errors stopped."
}
```

### Conflict Resolution Guide

If Toqi and Zapia submit patches to the same file in consecutive shifts:

1. **The file-level mutex handles serialization automatically** — the second patch waits for the first to complete
2. **BUT**: the second patch was written against the OLD version of the file (before the first patch applied). So the second patch may conflict with the first.
3. **Resolution**: The active agent should:
   - Fetch the CURRENT version of the file (after the first patch applied) via `GET /api/patch/file?path=...`
   - Compare it to what the second patch expects
   - If the second patch's changes are now irrelevant (already fixed by the first), mark it as "superseded" in a new proposal
   - If the second patch's changes are still needed, re-submit against the new file content
4. **Prevention**: Check `GET /api/patch/budget` for `filesInFlight` before starting work on a file. If the other agent patched it in the last shift, review their changes first.

### Quick Sanity-Check Test Suite

Before submitting any patch, mentally run through:

1. **Transpile check**: Does the file use valid TypeScript? (No `\b` in regex literals inside template literals, no `(st: any)` annotations inside `<script>` blocks, etc.)
2. **String literal check**: Does the patch preserve all string literals that the bot depends on? (State names, URLs, selectors)
3. **Import check**: Does the patch add any new `require()` calls to modules not already used?
4. **Loop check**: Does the patch introduce any `while(true)` or unbounded recursion?
5. **Side-effect check**: Does the patch modify `process.env`, `globalThis`, or `require.cache`?
6. **Identity check**: Does the patch change the bot's core behavior? (Cross-reference CORE_IDENTITY.md)
7. **Budget check**: Is there deploy budget remaining? (`GET /api/patch/budget` — `paused` should be false)

---

## 6. Priority Levels (don't fix edge cases at the cost of common ones)

| Priority | Description | Example |
|---|---|---|
| **P0 (critical)** | Bot is down, producing blank screenshots, or stuck in a loop | `BLANK` errors, navigation failures, OOM crashes |
| **P1 (high)** | A core feature is broken (login, navigation, task completion) | Microsoft login fails, state transition dead-ends |
| **P2 (moderate)** | A non-core feature is broken (logging, dashboard, monitoring) | Dashboard won't load, Turso sync failing |
| **P3 (low)** | Code quality, documentation, minor optimizations | Rename a variable, add a comment, refactor |

**Rule**: Only work on P3 if there are no P0/P1/P2 issues. Both agents should check the previous shift's summary to see if there are open P0/P1 issues before starting new work.

---

## 7. Drift Prevention & Reset Reviews

### Core Identity Anchor

The bot's core identity is defined in `CORE_IDENTITY.md`. Both Toqi and Zapia MUST read it before submitting patches. If a patch would change the bot's core identity, it must be rejected.

### Periodic reset reviews (every 6 hours = every 6 shifts)

Whichever agent is running at the 6-hour mark (e.g. 06:00, 12:00, 18:00, 00:00) should run a reset review:
1. Fetch the last 6 hours of patch history (`GET /api/patch/history?limit=50`)
2. Check if the bot's behavior has drifted from CORE_IDENTITY.md
3. Check if any "stable core" files were modified (they shouldn't be)
4. Check if the deploy budget is on track (should be <80% at the 6-hour mark)
5. If drift is detected, submit a "drift alert" proposal (`type: "drift_alert"`) and pause further patching until the drift is corrected

### Meta-review (once a day)

Whichever agent is running at midnight UTC should review:
- How many patches were submitted in the last 24 hours? How many applied? How many rejected?
- What was the most common rejection reason?
- Are Toqi and Zapia working on the right priorities?
- Is the framework itself (this document) still accurate?

If the framework needs updating, submit a patch to `MULTI_AGENT_FRAMEWORK.md` via the dashboard.

---

## 8. Quality Metrics

Track these over time to measure if the bot is actually getting better:

| Metric | How to measure | Target |
|---|---|---|
| Patch success rate | `applied / submitted` in last 24h | >80% |
| Average patch pipeline time | Time from `validation` to `complete` | <120s |
| Blank screenshot rate | Count `BLANK` in logs per hour | <5% |
| Error rate per hour | Count `ERROR` in logs per hour | Decreasing trend |
| Deploy budget utilization | `GET /api/patch/budget` → `deploys / maxDeploys` | <80% |
| Time since last critical bug | Hours since last P0 issue | Increasing |

The midnight-shift agent should include these metrics in the daily meta-review.

---

## 9. API Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/improvement/framework` | GET | Fetch this framework (JSON) |
| `/api/improvement/proposals` | GET | List recent proposals/summaries |
| `/api/improvement/proposals` | POST | Submit a proposal or summary |
| `/api/patch/submit` | POST | Submit a patch |
| `/api/patch/status/:id` | GET | Check patch pipeline status |
| `/api/patch/history` | GET | List past patches |
| `/api/patch/file?path=...` | GET | Fetch current source of a file |
| `/api/patch/budget` | GET | Check deploy budget + queue status |
| `/api/ping` | GET | Ultra-lightweight health check (returns ok + RSS/heap). Use this FIRST before any other API call — it adds zero memory pressure. |
| `/api/logs?limit=N` | GET | Fetch recent logs (skip when RSS > 380MB — will return 503) |
| `/api/status` | GET | Bot health/status (skip when RSS > 380MB — will return 503) |
| `/api/health` | GET | Deep health check |

---

## 10. Quick Start for Toqi and Zapia

If you're Toqi or Zapia starting a new shift:

1. **Read `CORE_IDENTITY.md`** (via `GET /api/improvement/framework` → `core_identity` field) — understand what the bot does and what must never change
2. **Fetch the previous shift's summary** — `GET /api/improvement/proposals?type=summary&limit=1` — see what the other agent did
3. **Check the current state** — `GET /api/patch/budget` (is the deploy budget OK?) and `GET /api/patch/history?limit=5` (recent patches)
4. **Run your hourly checklist** (see §4)
5. **If you found an issue** — submit a proposal via `POST /api/improvement/proposals`
6. **If you're fixing it** — fetch the current source, write the patch, use Diff Preview, submit via `POST /api/patch/submit`
7. **Log your work** — submit a shift summary via `POST /api/improvement/proposals` with `type: "summary"` so the other agent knows what you did
8. **Don't break the bot** — when in doubt, don't touch it. Read CORE_IDENTITY.md again.
