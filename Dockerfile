FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="MathU Bot v6 — Render Free Plan"
LABEL org.opencontainers.image.description="Autonomous MathU bot, all features, 512 MB, ephemeral disk"
LABEL org.opencontainers.image.authors="U.S.J Sibiya"

# ═══════════════════════════════════════════════════════════════════════════
# SYSTEM DEPENDENCIES — single layer, cleaned immediately
# ═══════════════════════════════════════════════════════════════════════════
# Chromium needs ~20 shared libs.  Build tools needed for better-sqlite3.
# curl is for the Docker HEALTHCHECK (Render uses its own health probe).
# ═══════════════════════════════════════════════════════════════════════════

RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    python3 make g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ═══════════════════════════════════════════════════════════════════════════
# LAYER 1 — Dependency manifests
# ═══════════════════════════════════════════════════════════════════════════
# Cached until package.json or tsconfig.json changes.

COPY package.json tsconfig.json ./

# ═══════════════════════════════════════════════════════════════════════════
# LAYER 2 — Node dependencies
# ═══════════════════════════════════════════════════════════════════════════
# --ignore-scripts  → postinstall.js won't run here; we handle sqlite3
#                     and Playwright in isolated steps below so each gets
#                     its own memory budget inside the 512 MB build env.
# --no-optional     → skips onnxruntime-node (~50 MB), sharp, tesseract.js,
#                     @xenova/transformers.  All are disabled or unnecessary
#                     at runtime on 512 MB (ENABLE_LOCAL_VLM=false by
#                     default; OCR falls back to vision APIs).
# NODE_OPTIONS      → caps V8 heap at 256 MB so the OS + apt + gcc have
#                     room to breathe during install.
# npm_config_jobs=1 → serialises native compilations.  Two parallel g++
#                     processes would each grab 100-200 MB and OOM.
# npm_config_build_from_source=false → grabs prebuilt binaries when
#                     available (better-sqlite3 ships them for glibc/Linux).
# ═══════════════════════════════════════════════════════════════════════════

RUN NODE_OPTIONS=--max-old-space-size=256 \
    npm_config_jobs=1 \
    npm_config_build_from_source=false \
    npm install --ignore-scripts --no-optional

# ═══════════════════════════════════════════════════════════════════════════
# LAYER 3 — better-sqlite3 native addon
# ═══════════════════════════════════════════════════════════════════════════
# Separated from npm install so node-gyp gets a fresh 512 MB budget.
# The build tools (python3, make, g++) were installed in step 1.
# npm rebuild compiles the .node file from source if no prebuilt was
# cached.  On Debian Bookworm x64 a prebuilt usually exists.

RUN npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"

# ═══════════════════════════════════════════════════════════════════════════
# LAYER 4 — Playwright Chromium
# ═══════════════════════════════════════════════════════════════════════════
# Downloaded + extracted in its own layer.  ~130 MB download,
# ~280 MB on disk.  Isolated from npm install to avoid OOM.
# System deps (libnss3 etc.) are already installed in step 1.

RUN npx playwright install chromium

# ═══════════════════════════════════════════════════════════════════════════
# LAYER 5 — Application code
# ═══════════════════════════════════════════════════════════════════════════
# Copied LAST so that Layers 1-4 are reused when only .ts files change.

COPY . .

# ═══════════════════════════════════════════════════════════════════════════
# RUNTIME DIRECTORIES — all under /tmp (ephemeral, no persistent disk)
# ═══════════════════════════════════════════════════════════════════════════

RUN mkdir -p /tmp/mathu-logs/screenshots \
    /tmp/.browser-data \
    /tmp/mathu-backups \
    /tmp/mathu-staging \
    /tmp/mathu-regression

# ═══════════════════════════════════════════════════════════════════════════
# SECURITY — non-root user
# ═══════════════════════════════════════════════════════════════════════════

USER node

# ═══════════════════════════════════════════════════════════════════════════
# PORT
# ═══════════════════════════════════════════════════════════════════════════
# Render injects $PORT (usually 10000).  The app reads it at startup.

EXPOSE 10000

# ═══════════════════════════════════════════════════════════════════════════
# ENVIRONMENT DEFAULTS
# ═══════════════════════════════════════════════════════════════════════════
# Sensible defaults for Render free plan (512 MB RAM, ephemeral disk).
# Any env var set in the Render dashboard takes precedence over these.
# Feature flags are intentionally NOT set here — they default to true
# in config.ts, so all features are enabled out of the box.
#
# IMPORTANT: MEMORY_RESTART_THRESHOLD_MB must be < MAX_MEMORY_MB.
# config.ts validates this at startup and exits with code 1 if violated.
# If the user sets MAX_MEMORY_MB in the Render dashboard to a lower value
# (e.g. 384 to match the V8 heap cap), the threshold here (360) is still
# below it.  Previously this was set to 400, which broke when the user
# overrode MAX_MEMORY_MB to 384 in the dashboard.

ENV NODE_ENV=production \
    PORT=10000 \
    HEADLESS=true \
    MAX_MEMORY_MB=448 \
    MEMORY_WARNING_THRESHOLD_MB=350 \
    MEMORY_RESTART_THRESHOLD_MB=360 \
    MAX_UPTIME_HOURS=0 \
    MAX_CYCLES_BEFORE_RESTART=999999 \
    LOG_LEVEL=info \
    LOG_MAX_FILES=2 \
    LOG_MAX_SIZE_MB=10 \
    SAVE_SCREENSHOTS=false \
    ENABLE_GAN_TELEMETRY=false \
    ENABLE_LOCAL_VLM=false \
    DB_PATH=/tmp/mathu-bot.db \
    USER_DATA_DIR=/tmp/.browser-data \
    LOG_DIR=/tmp/mathu-logs \
    HEARTBEAT_FILE=/tmp/.heartbeat \
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --disable-component-extensions-with-background-pages --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion --js-flags=--max-old-space-size=128 --optimize-for-size --single-process"

# ═══════════════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ═══════════════════════════════════════════════════════════════════════════
# Render has its own health probe (pings /health on $PORT).  This
# Docker HEALTHCHECK is for local `docker run` testing only.

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:10000/health || exit 1

# ═══════════════════════════════════════════════════════════════════════════
# START
# ═══════════════════════════════════════════════════════════════════════════
# render-free-plan.ts keeps ALL features enabled.  Memory savings come
# only from skipping worker threads and running Chromium single-process.
# --expose-gc allows manual GC calls from the memory manager.
# --max-old-space-size=384 leaves ~128 MB for Chromium + OS on 512 MB.

CMD ["node", "--expose-gc", "--max-old-space-size=384", "--import", "tsx", "render-free-plan.ts"]
