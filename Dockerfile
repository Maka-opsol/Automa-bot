# ═══════════════════════════════════════════════════════════════════════════
# MathU Bot v6 — Hugging Face Spaces Dockerfile
# ═══════════════════════════════════════════════════════════════════════════
# Designed for 5-year unattended operation on HF Spaces (free CPU tier).
# All subsystems enabled: self-heal, model evolution, workers, exploration,
# adaptive performance, protocol chameleon, blackbox, GAN telemetry, etc.
#
# Key design decisions:
#   - Playwright Chromium installed at build time (not runtime)
#   - better-sqlite3 native addon compiled at build time
#   - All system deps pre-installed (no apt-get at runtime)
#   - Node 20 LTS for --import tsx support
#   - /data volume for ephemeral persistent state across restarts
#   - Health check on /health for HF Spaces uptime monitoring
#   - Non-root user for security
# ═══════════════════════════════════════════════════════════════════════════

FROM node:20-bookworm-slim

# Metadata for Hugging Face Spaces
LABEL org.opencontainers.image.title="MathU Bot v6"
LABEL org.opencontainers.image.description="Autonomous MathU educational platform bot with self-healing, multi-provider AI, and 5-year unattended operation"
LABEL org.opencontainers.image.authors="U.S.J Sibiya"

# Install Playwright system dependencies + build tools for native addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright Chromium dependencies
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libxshmfence1 libx11-xcb1 \
    # Build tools for better-sqlite3 native addon
    python3 make g++ \
    # Runtime utilities
    curl jq git \
    # Fonts (for screenshot / OCR accuracy)
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files first (layer caching)
COPY package.json package-lock.json* tsconfig.json ./

# Install ALL dependencies (including optional for sharp, tesseract, etc.)
# --ignore-scripts prevents postinstall from trying to download Playwright browsers
# (we install them separately below for Docker compatibility)
RUN npm install --ignore-scripts 2>/dev/null || npm install

# Install Playwright Chromium and its system deps
RUN npx playwright install chromium --with-deps 2>&1 || \
    (npx playwright install chromium 2>&1 && apt-get update && apt-get install -y --no-install-recommends libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 && rm -rf /var/lib/apt/lists/*)

# Copy application code
COPY . .

# Create data directory for ephemeral persistent state
RUN mkdir -p /data/logs /data/screenshots /data/.browser-data \
    && chown -R node:node /app /data

# HF Spaces requires non-root
USER node

# HF Spaces injects $PORT — must be exposed
EXPOSE 7860

# Environment defaults for HF Spaces
ENV NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true \
    MAX_MEMORY_MB=4096 \
    MAX_UPTIME_HOURS=168 \
    MAX_CYCLES_BEFORE_RESTART=500 \
    MEMORY_WARNING_THRESHOLD_MB=3072 \
    MEMORY_RESTART_THRESHOLD_MB=3584 \
    SLEEP_MIN_HOURS=0.25 \
    SLEEP_MAX_HOURS=0.5 \
    MAX_CYCLES_BEFORE_RESTART=999999 \
    SAVE_SCREENSHOTS=false \
    ENABLE_GAN_TELEMETRY=false \
    ENABLE_LOCAL_VLM=false \
    ENABLE_IP_CHECK=false \
    ENABLE_STATUS_SERVER=true \
    LOG_LEVEL=info \
    LOG_MAX_FILES=2 \
    LOG_MAX_SIZE_MB=10 \
    DB_PATH=/data/mathu-bot.db \
    USER_DATA_DIR=/data/.browser-data \
    LOG_DIR=/data/logs \
    HEARTBEAT_FILE=/data/.heartbeat \
    CHECKPOINT_FILE=/data/checkpoint.json \
    PROGRESS_LOG_PATH=/data/logs/progress.jsonl \
    LAST_STATE_PATH=/data/last-state.json \
    SCREENSHOT_DIR=/data/logs/screenshots \
    SELF_HEAL_BACKUP_DIR=/data/backups \
    SELF_HEAL_STAGING_DIR=/data/staging \
    REGRESSION_BANK_DIR=/data/regression \
    REPLIT_VM=false \
    SANDBOX_MODE=false \
    # Re-enable ALL features (HF has 16GB, no need to disable anything)
    ENABLE_BLACKBOX=true \
    BLACKBOX_REPLAY_ENABLED=true \
    ENABLE_ADAPTIVE_PERFORMANCE=true \
    ENABLE_PROTOCOL_CHAMELEON=true \
    ENABLE_EXPLORATION_PASS=true \
    ENABLE_FLUTTER_SEMANTICS=true \
    ENABLE_NETWORK_INTERCEPT=true \
    ENABLE_CANVAS_OCR=true \
    FLUTTER_DPR_AUTO_CALIBRATE=true \
    NETWORK_REPLAY_ON_CLICK_FAIL=true \
    ENABLE_RUNTIME_GUARDIAN=true \
    UPDATER_ENABLED=true \
    ENABLE_UI_PROMPT_UPDATER=true \
    WEB_SEARCH_ENABLED=true \
    OCR_FALLBACK_ENABLED=true \
    TEMPLATE_CACHE_ENABLED=true \
    SELF_HEAL_ENABLED=true \
    PREDICTIVE_HEAL_ENABLED=true \
    SELECTOR_DRIFT_HEAL_ENABLED=true \
    REGRESSION_BANK_ENABLED=true \
    CANARY_ROLLOUT_ENABLED=true \
    DIFF_MINIMIZER_ENABLED=true \
    ADVERSARIAL_TESTER_ENABLED=true \
    CRITICAL_SHADOW_MODE_ENABLED=true \
    PROMPT_EVOLUTION_ENABLED=true \
    DB_HEALER_ENABLED=true \
    AUTH_HEALER_ENABLED=true \
    STATE_RECOVERY_ENABLED=true \
    DEPENDENCY_HEALER_ENABLED=true \
    CONFIG_RECONCILER_ENABLED=true \
    EXTENDED_CHECKPOINT_ENABLED=true \
    BLACKBOX_FULL_ENABLED=true \
    PATCH_MEMORY_ENABLED=true \
    HEAL_REWARD_TRACKER_ENABLED=true \
    SELF_HEAL_TIMELINE_ENABLED=true \
    HEALER_SELF_TEST_ENABLED=true \
    HEALER_CIRCUIT_BREAKER_ENABLED=true \
    SUBSYSTEM_CB_MESH_ENABLED=true \
    CLEAN_ROOM_TEST_ENABLED=true \
    DEGRADATION_LADDER_ENABLED=true \
    GITOPS_ENABLED=true \
    # Chromium flags optimized for container
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider"

# Health check for HF Spaces
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Start the bot with HF Spaces entry point
CMD ["node", "--expose-gc", "--max-old-space-size=3584", "--import", "tsx", "hf-spaces.ts"]
