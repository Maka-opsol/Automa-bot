Core Identity Anchor — MathU Bot

 Purpose: This document defines the bot's core identity and behavior. Every agent that submits patches MUST read this document first and ensure their changes do NOT contradict it.

How to fetch: GET /api/improvement/framework returns this as part of the framework JSON (under core_identity).

Rule: If a patch would change ANY of the items listed below as "IMMUTABLE", the patch MUST be rejected by the active agent (Toqi or Zapia) and the AI advisory should flag it.

1. What the Bot Does

MathU Bot is an autonomous web automation bot that:

 Logs into the MathU platform (https://app.mathu.co.za) using Microsoft S2S authentication
 Navigates through modules (tasks, exercises, videos)
 Completes math problems using AI vision (screenshots → VLM → answer)
 Tracks progress, handles CAPTCHAs, recovers from failures, and self-heals
The bot runs on Render's free plan (512MB RAM, 500 build minutes/month) and uses Turso as its primary database (persisted across deploys).

2. IMMUTABLE Core Behaviors (NEVER change these)

2.1 Mission

The bot's mission is to autonomously complete MathU tasks with minimal human intervention. Any patch that changes this mission (e.g. making the bot do something unrelated, or making it require manual intervention for core operations) is FORBIDDEN.

2.2 Authentication Flow

 The bot authenticates via Microsoft v2 login (Microsoft Entra ID / Azure AD)
 The auth flow is defined in auth-auth-manager.ts and auth-strategies-microsoft-v2.ts
 The bot must NEVER store or transmit credentials in plain text
 The bot must NEVER bypass authentication (e.g. by hardcoding session tokens)
2.3 State Machine Core

The state machine (state-machine.ts) defines these core states. Their string values must never change (they're persisted in the DB and referenced throughout the codebase):

 'mathu_login' — logging into MathU
 'microsoft_login' — Microsoft auth flow
 'assignments_page' — viewing the tasks list (state name is a string literal — preserve as-is)
 'video_player' — watching a video
 'exercise_info' / 'exercise_memo' — viewing an exercise
 'assessment' / 'assessment_correction' — taking a task (these state names are string literals that must be preserved as-is; they map to specific pages on the platform)
 'score_screen' — viewing results
 'pathway' / 'pathway_feedback' — pathway navigation
 'error' — error state
 'anywhere_click_recovery' — fallback recovery state
Rule: Patches may ADD new states but must NOT remove or rename existing ones.

2.4 URL Detection Patterns

The bot detects pages by URL patterns. These patterns must NOT be changed:

 url.includes('assignment') — detects task pages (the URL fragment is literal — must be preserved)
 url.includes('mathletics.com/#') — detects Mathletics pages
 url.includes('student') — detects user portal (literal URL fragment — preserve)
 url.includes('app.mathu.co.za') — detects MathU app
Rule: Patches may ADD new URL patterns but must NOT remove or weaken existing ones.

2.5 DOM Selectors

These CSS selectors are used to find elements on the page. They must NOT be changed without thorough testing:

 .assignment-card — task module cards (CSS selector — preserve as-is)
 Various selectors defined in selectors-mathu-app-current.json and selectors-microsoft-login-current.json
Rule: Patches to selectors must go through the selector drift healer (self-heal-selector-drift.ts) — don't hardcode new selectors in the main code.

2.6 Database Schema

The patch_history, calibration, completed_modules, action_cache, and model_registry tables are synced to Turso and must NOT have their schemas changed in ways that break existing data. New columns are OK; removing/renaming columns is FORBIDDEN.

2.7 Patching Pipeline

The dashboard's patching pipeline (sandbox-executor.ts, self-heal-auditor.ts, dashboard-server.ts) is the system that applies patches. A patch must NOT:

 Disable the sandbox audit
 Disable the AI advisory
 Bypass the deploy budget tracker
 Remove the patch dedup check
 Weaken the keyword scanner or blocked-pattern regexes
3. Allowed Changes (with care)

3.1 Performance optimizations

 Reducing memory usage (important on Render's 512MB plan)
 Reducing API call frequency (to stay within free-tier quotas)
 Improving error recovery logic
 Adding caching
3.2 Bug fixes

 Fixing runtime errors
 Fixing state machine dead-ends
 Fixing blank screenshot issues
 Fixing proxy/network issues
3.3 Feature additions

 New states for new page types (if MathU adds new features)
 New selector files (via the selector drift healer)
 New monitoring/metrics
 New self-heal subsystems
3.4 Documentation

 Improving code comments
 Updating this framework
 Adding inline docs
4. Drift Detection Checklist

Before approving any patch, the active agent (Toqi or Zapia) should verify:

 Does the patch change the bot's mission? (No — it should still autonomously complete MathU tasks)
 Does the patch change the authentication flow? (No — should still use Microsoft v2)
 Does the patch rename or remove any state machine state? (No — only additions allowed)
 Does the patch change URL detection patterns? (No — only additions allowed)
 Does the patch change DOM selectors? (No — should go through selector drift healer)
 Does the patch modify the database schema? (Only additive changes — new columns OK, no removals)
 Does the patch weaken the patching pipeline safeguards? (No — sandbox/auditor/budget must stay intact)
 Does the patch change the bot's personality or tone? (N/A — the bot has no user-facing personality)
If ANY answer is "Yes" (and the change wasn't explicitly approved by a human), the patch must be rejected.

5. The Bot's "Personality"

MathU Bot has no user-facing personality — it's a headless automation bot. The only "personality" is in the dashboard UI, which should remain:

 Professional and technical — this is a developer tool, not a consumer product
 Information-dense — show as much useful data as possible per screen
 Dark-themed — the existing dark color scheme should be preserved
 Non-judgmental — error messages should describe what happened, not assign blame
6. What Happens if Drift is Detected

If the active agent's reset review (every 6 hours / 6 shifts) detects that the bot has drifted from this identity:

The active agent submits a type: "drift_alert" proposal via POST /api/improvement/proposals
The alert should specify which immutable behavior was violated
All agents should PAUSE patching until the drift is corrected
The active agent (or the next-shift agent) should draft a "revert" patch that restores the original behavior
The revert patch goes through the normal pipeline (sandbox + advisory + budget check)
Once the revert is applied, normal operation resumes
This document is the single source of truth for the bot's identity. If it needs to change (e.g. the bot's mission evolves), it must be updated via a dashboard patch that goes through the full review pipeline — not edited directly.
