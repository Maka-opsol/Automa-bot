'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Codebase Architecture Context for Self-Heal Codegen Models
// ═══════════════════════════════════════════════════════════════════════════════
// This file exports a constant string that gets injected into codegen prompts.
// It tells the AI models what the codebase looks like so they generate
// fixes that actually make sense (correct file names, patterns, constraints).
//
// CRITICAL RULES FOR CODEGEN MODELS:
//
// 1. FILE NAMING: All source files are in the project root (flat structure).
//    Names use kebab-case with a group prefix:
//      cycle-*.ts          — Main bot loop (orchestrator, cycle-manager, action-executor, auth-guard, etc.)
//      providers-*.ts      — LLM provider system (base, registry, fallback, tribunal, vision, codegen, detection)
//      self-heal-*.ts      — Self-healing subsystem (auditor, circuit-breaker, patch-memory, tmp-overlay, etc.)
//      flutter-*.ts        — Flutter Web interaction (gestures, modal-slayer, canvas-parser, stability-waiter)
//      longevity-*.ts      — Long-running process stability (browser guardian, node monitor, tmp guardian)
//      services-*.ts       — External service integrations (pix2tex, wolfram, model-discovery, ip-check)
//      monitoring-*.ts     — Health checks, anomaly detection, circuit breakers
//      config-*.ts         — Configuration management (boot-validation, drift-detector, remote-config)
//      auth-*.ts           — Authentication (auth-manager, strategies-*, captcha-loop-guard, token-graveyard)
//      browser-*.ts        — Browser lifecycle (chrome-flags, ghost-mode, phoenix)
//      policy-*.ts         — Decision policy (action-validator, policy-engine, state-guard)
//      memory-mode.ts      — Memory management (Full Power / Memory Protection / Minimum modes)
//      container-*.ts      — Dependency injection container
//      workers-*.ts        — Background worker system (diary, metrics, reward-tracker)
//      utils-*.ts          — Utility functions (sleep, fetch, user-agent, a11y-snapshot)
//      selectors.ts        — UI element selectors (JSON-based)
//      math-*.ts           — Math handling (problem-classifier, solution-cache, verify)
//      progress-*.ts       — Progress tracking (semantic-detector, circular-path-detector, speed-benchmark)
//      pixel-*.ts          — Pixel analysis (calibration, explorer, fallback, training)
//      meta-learner-*.ts   — Meta-learning (reflection, suggestion-applier, suggestion-validator)
//      survival-*.ts       — Survival/recovery (restart-guardian, heartbeat-beacon, tombstone, ephemeral-shield)
//      planning-*.ts       — Planning (module-selector)
//      exploration-*.ts    — UI exploration (cartographer, domain-adapter)
//      experiments-*.ts    — A/B testing (strategy-variants)
//      economy-*.ts        — Budget management (quota-rations)
//      render-*.ts         — Render management (cold-start, free-plan)
//      telemetry-*.ts      — Telemetry (GAN-based)
//      resource-*.ts       — Resource management
//      runtime-*.ts        — Runtime protection (guardian, heap-guardian, module-quarantine)
//      persistent-config.ts — Persistent mode/state storage
//      project-root.ts     — PROJECT_ROOT constant
//      network-*.ts        — Network (ip-rotator)
//      protocol-*.ts       — Protocol adaptation (chameleon)
//      provider-quota-bargain.ts — Provider quota negotiation
//      bazaarlink-rate-limiter.ts — BazaarLink API rate limiting
//      openrouter-rate-limiter.ts — OpenRouter rate limiting
//      local-vlm-failover.ts — Local VLM fallback
//      cascade-breaker.ts  — Error cascade prevention
//      failsafe-coordinator.ts — Failsafe coordination
//      screenshot-storage.ts — Screenshot persistence
//      cache.ts             — In-memory cache
//      db-backup.ts        — Database backup
//      blackbox-recorder.ts — Request/response recording
//      brute-force-navigator.ts — Brute-force page navigation
//      captcha-human-fallback.ts — Human captcha fallback
//      remote-brain-injector.ts — Remote brain injection
//      ui-drift-discovery.ts — UI drift detection
//      dependency-*.ts     — Dependency management (manager, survivor)
//      puzzle-sandbox.ts   — Code execution sandbox
//      instance-lock.ts    — Single-instance lock
//      hf-spaces.ts        — HuggingFace Spaces
//      jwt.ts              — JWT handling
//      web-search.ts       — Web search
//      watchdog.ts         — General watchdog
//
// 2. THERE IS NO src/ DIRECTORY. Files like "src/bot/boot.ts" DO NOT EXIST.
//    All .ts files are in the project root: /app/<filename>.ts
//
// 3. DEPENDENCY INJECTION PATTERN:
//    Every module uses this exact pattern:
//      let _deps: Record<string, any> = {};
//      function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
//      module.exports = { ..., _injectDependencies };
//    Access dependencies via: _deps.logger, _deps.config, _deps.browser, etc.
//    NEVER use top-level require() for other project modules.
//
// 4. OVERLAY SYSTEM (read-only filesystem):
//    On Render, source files are read-only. Self-heal writes patches to /tmp.
//    ONLY files matching ALLOWED_PREFIXES can be patched. Attempting to
//    patch any other file will be silently blocked.
//
//    ALLOWED PREFIXES (the ONLY files you can fix):
//      selectors-
//      providers-detection-
//      cycle-
//      providers-base
//      providers-config-loader
//      providers-registry
//      providers-fallback
//      providers-prompts
//      providers-vision-pipeline
//      providers-stats
//      providers-tribunal
//      providers-serializers
//      providers-prompt-evolution
//      cache
//      auth-auth-manager
//      config
//      browser
//      state-machine
//      longevity-ui-recovery
//      self-heal-degradation-ladder
//      math-problem-classifier
//      services-pix2tex
//
//    BLOCKED FILES (will be rejected — DO NOT attempt to fix these):
//      agent.ts, logger.ts, database.ts, alerting.ts, progress-tracker.ts,
//      self-heal.ts, self-heal-gitops.ts, self-heal-auditor.ts,
//      container.ts, container-container.ts, container-modules.ts,
//      providers.ts, providers-codegen-*.ts, providers-health.ts,
//      auth.ts, memory-mode.ts, get-config.ts, persistent-config.ts,
//      and many others. If the file is not in the ALLOWED list above,
//      your fix WILL be blocked.
//
// 5. FILE FORMAT:
//    - TypeScript (.ts) with 'use strict' at top
//    - CommonJS modules (require/module.exports, NOT import/export)
//    - No TypeScript enums, use string unions or numeric constants
//    - No decorators
//
// 6. KEY ARCHITECTURE:
//    - agent.ts: Entry point, starts the orchestrator
//    - cycle-orchestrator.ts: Top-level loop, calls cycle-cycle-manager.runCycle()
//    - cycle-cycle-manager.ts: Main cycle logic — screenshot → auth → tribunal → action
//    - providers-tribunal.ts: Vision tribunal (multiple LLMs vote on what's on screen)
//    - providers-codegen-tribunal.ts: Codegen tribunal (LLMs generate code fixes for self-heal)
//    - self-heal.ts: Orchestrates self-healing (investigation → codegen → patch → promote)
//    - self-heal-tmp-overlay.ts: /tmp file overlay for read-only filesystem patches
//    - memory-mode.ts: Three modes — full_power, memory_protection, minimum
//    - container-modules.ts: DI container registration for all modules
//    - browser.ts: Playwright browser launch/manage
//    - auth.ts: Authentication orchestrator (delegates to auth-strategies-*.ts)
//
// 7. FLUTTER WEB: The target app (MathU) is a Flutter Web SPA.
//    - Everything renders to <canvas>, so document.body.innerText is always empty
//    - URL never changes between pages (SPA routing)
//    - Text-length heuristics DO NOT WORK for blank page detection
//    - Use pixel-based screenshot analysis instead (see cycle-auth-guard.ts)
//
// ═══════════════════════════════════════════════════════════════════════════════

const CODEBASE_CONTEXT = `\
IMPORTANT CODEBASE RULES (violation = rejected fix):\
\
1. FLAT FILE STRUCTURE: All .ts files are in the project root (/app/).\
   There is NO src/ directory. NEVER use paths like "src/bot/boot.ts".\
\
2. COMMONJS MODULES: Use require() and module.exports. NO import/export syntax.\
\
3. DEPENDENCY INJECTION: Every module has _injectDependencies(deps) exported.\
   Access deps via _deps.logger, _deps.config, _deps.browser, etc.\
   NEVER add top-level require() for other project modules.\
\
4. PATCHABLE FILES: Files matching these PREFIXES can be patched freely\
   (the sandbox allows them without approval):\
   selectors-, providers-detection-, cycle-, utils-, test-, plugins-,\
   planning-, exploration-, longevity-, pixel-, flutter-, services-,\
   policy-, auth-, progress-, network-, monitoring-, survival-, render-,\
   self-heal- (submodules only — self-heal.ts itself is restricted),\
   brute-force-, browser-, container-, state-, error-, config-,\
   cache-, alerting-, logger-, watchdog-, failsafe-,\
   providers-base, providers-config-loader, providers-registry,\
   providers-fallback, providers-prompts, providers-vision-pipeline,\
   providers-stats, providers-tribunal, providers-serializers,\
   providers-prompt-evolution, providers-health, providers-fallback,\
   cache, auth-auth-manager, math-problem-classifier, services-pix2tex,\
   math-verify, math-solution-cache, memory-mode, jwt, web-search,\
   openrouter-rate-limiter, bazaarlink-rate-limiter, local-vlm-failover,\
   cascade-breaker, failsafe-coordinator, screenshot-storage, db-backup,\
   blackbox-recorder, captcha-human-fallback, captcha-solver-external,\
   remote-brain-injector, ui-drift-discovery, dependency-manager,\
   dependency-survivor, puzzle-sandbox, instance-lock, hf-spaces,\
   provider-quota-bargain, protocol-chameleon, telemetry-gan,\
   resource-manager, runtime-guardian, runtime-heap-guardian,\
   runtime-module-quarantine, persistent-config, project-root,\
   experiment-strategy-variants, economy-quota-rations,\
   meta-learner-reflection, meta-learner-suggestion-applier,\
   meta-learner-suggestion-validator.\
\
   RESTRICTED (require dashboard approval — fixes will be blocked without it):\
   self-heal.ts, self-heal-gitops.ts, self-heal-auditor.ts,\
   self-heal-approval-workflow.ts, self-heal-circuit-breaker.ts.\
\
   IMMUTABLE (can NEVER be patched — do not attempt):\
   agent.ts, config.ts, database.ts, container.ts, container-container.ts,\
   container-modules.ts, providers.ts, providers-codegen-tribunal.ts,\
   providers-codegen-bazaarlink.ts, providers-codegen-deepseek.ts,\
   providers-codegen-mistral.ts, providers-codegen-qwen.ts,\
   providers-codegen-openrouter.ts, get-config.ts.\
\
5. PATCH FORMAT: The "patch" field can be EITHER:\
   a) A unified diff (starting with --- a/filename) for surgical edits — PREFERRED for small changes.\
   b) The COMPLETE file content for full replacement — use for large rewrites.\
   For diffs, include @@ -old +new @@ hunk headers.\
   For full replacement, include 'use strict' at top and module.exports at bottom.\
\
6. FLUTTER WEB SPA: The target app renders to <canvas>. document.body.innerText\
   is always empty. URL never changes. Do not suggest text-content checks.\
\
7. FILE NAMING: Use kebab-case with group prefix.\
   Example: cycle-auth-guard.ts, providers-base.ts, self-heal-tmp-overlay.ts.\
\
8. MULTI-FILE FIXES: You may fix MULTIPLE files in a single response if the\
   bug spans multiple modules. Return an array with one object per file.\
   Each file must independently pass the sandbox audit. Max 3 files per response.\
\
9. ROOT-CAUSE ANALYSIS: Before writing a patch, explain your diagnosis in the\
   "change" field. State: (a) what the bug is, (b) WHY it happens (root cause),\
   (c) how your fix addresses the root cause. Surface-level fixes that only\
   suppress symptoms will be rejected.\
`;

module.exports = { CODEBASE_CONTEXT, _injectDependencies() {} };
