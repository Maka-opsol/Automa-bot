FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="MathU Bot v6 — Render Free Plan"
LABEL org.opencontainers.image.description="Autonomous MathU bot, all features, 512 MB, ephemeral disk"
LABEL org.opencontainers.image.authors="U.S.J Sibiya"

# System deps: Chromium shared libs + build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    python3 make g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./

# Main npm install — --ignore-scripts defers postinstall, --no-optional skips
# ~140MB of native deps (onnxruntime-node, sharp, tesseract.js, @xenova/transformers)
RUN NODE_OPTIONS=--max-old-space-size=256 \
    npm_config_jobs=1 \
    npm_config_build_from_source=false \
    npm install --ignore-scripts --no-optional

# esbuild puts its platform binary in optionalDependencies — install it explicitly
RUN npm install --ignore-scripts @esbuild/linux-x64

# better-sqlite3 native addon — build tools from apt-get step above
RUN npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"

# Playwright Chromium — install to a world-readable path so the runtime
# USER node can find it.  Default is ~/.cache/ms-playwright/ which would
# be /root/.cache/ (unreadable by node user) if installed as root.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install chromium

# App code last — layers above are cached when only .ts files change
COPY . .

# Runtime directories under /tmp (ephemeral disk)
RUN mkdir -p /tmp/mathu-logs/screenshots \
    /tmp/.browser-data \
    /tmp/mathu-backups \
    /tmp/mathu-staging \
    /tmp/mathu-regression

USER node

EXPOSE 10000

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

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:10000/health || exit 1

CMD ["node", "--expose-gc", "--max-old-space-size=384", "--import", "tsx", "render-free-plan.ts"]
