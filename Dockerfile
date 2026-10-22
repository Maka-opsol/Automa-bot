FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="MathU Bot v6 — Render Free Plan"
LABEL org.opencontainers.image.description="Autonomous MathU bot, all features, 512 MB, ephemeral disk"
LABEL org.opencontainers.image.authors="U.S.J Sibiya"

# System deps: Chromium shared libs + build tools for better-sqlite3.
# libxfixes3 was missing — caused "cannot open shared object file" at runtime.
# The rest are the full set Chromium needs on Debian Bookworm (from
# npx playwright install-deps chromium).  Being explicit avoids one-more-
# missing-lib roundtrips on 512 MB builds that take several minutes each.
#
# TASK 35 (2026-09-09): Added xvfb + xauth for headed browser mode.
# When the user calls /api/browser/headed, the bot needs a virtual display
# to run Chromium in headed mode on a headless server. Xvfb provides a
# virtual X server that Chromium can render to. xauth is needed for
# DISPLAY-based authentication.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    libxfixes3 libxext6 libxi6 libxtst6 \
    libxcursor1 libxss1 libdbus-1-3 libexpat1 \
    libglib2.0-0 \
    python3 python3-pip make g++ \
    curl \
    xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

# TASK 121 (2026-10-21): Install Pix2Text for math OCR.
# Pix2Text provides accurate OCR for math equations and formulas — far
# better than the 5x7 pixel template fallback in pixel-fallback.ts.
# We install with --no-cache-dir and --break-system-packages (Python 3.11+
# on Debian Bookworm requires this flag for system pip installs).
# Also install torch CPU-only to keep the image small (no CUDA needed).
RUN pip3 install --no-cache-dir --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu && \
    pip3 install --no-cache-dir --break-system-packages pix2text

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
# TASK 35 (2026-09-09): Also create /tmp/.X11-unix for Xvfb (headed mode).
# TASK 44 (2026-09-10): Fix "_XSERVTransmkdir: Owner of /tmp/.X11-unix
# should be set to root" warning.
# Xvfb requires /tmp/.X11-unix to be:
#   - Owned by root:root
#   - Permissions 1777 (sticky bit + world-writable)
# The sticky bit (1xxx) prevents users from deleting each other's sockets.
# The `chown root:root` is explicit even though RUN runs as root — it
# ensures the ownership survives any future COPY --chown operations.
RUN mkdir -p /tmp/mathu-logs/screenshots \
    /tmp/.browser-data \
    /tmp/mathu-backups \
    /tmp/mathu-staging \
    /tmp/mathu-regression \
    /tmp/.X11-unix \
    && chown root:root /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

USER node

EXPOSE 10000

ENV NODE_ENV=production \
    PORT=10000 \
    HEADLESS=true \
    DISPLAY=:99 \
    MAX_MEMORY_MB=448 \
    MEMORY_WARNING_THRESHOLD_MB=200 \
    MEMORY_RESTART_THRESHOLD_MB=220 \
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
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --disable-component-extensions-with-background-pages --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion --js-flags=--max-old-space-size=96 --optimize-for-size --single-process"

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:10000/health || exit 1

# TASK 35 (2026-09-09): Start Xvfb in the background before the bot.
# Xvfb provides a virtual X display at :99 with 1280x720 resolution and
# 24-bit color depth. This allows the bot to switch to headed mode
# (via /api/browser/headed) for visual debugging / human intervention.
#
# TASK 40 (2026-09-10): Clean up stale Xvfb lock files before starting.
# When the bot process restarts (e.g. after OOM) but the container keeps
# running, the old Xvfb may still be alive with a stale /tmp/.X99-lock.
# The new Xvfb would fail with "Server is already active for display 99".
# Fix: remove the lock file + kill any existing Xvfb process before start.
#
# TASK 41 (2026-09-10): Raised V8 heap limit from 384MB → 448MB.
# The bot was crashing at 380MB V8 heap because:
#   - Chromium --single-process mode shares the V8 heap with Node
#   - Flutter Web loads ~150MB into the heap
#   - DI container + modules = ~80MB
#   - Tribunal calls (JSON parse, provider responses) = ~50MB transient
#   - Total steady-state: ~280-350MB, with spikes to 380MB+
# The 384MB limit was too tight — any spike caused V8 OOM → crash →
# memory_protection restart → still 380MB → crash → death loop.
# 448MB gives 64MB headroom above the typical peak, enough to absorb
# transient spikes without crashing. Render free plan has 512MB total,
# so 448MB V8 + ~64MB non-V8 (Chromium C++ heap, stack, etc.) = 512MB.
# TASK 44 (2026-09-10): Added `|| true` to cleanup commands so they don't
# cause the shell to exit if the files don't exist or can't be deleted
# (e.g. owned by root from a previous container). The Xvfb startup is
# non-fatal — if it fails, the bot still runs in headless mode.
# TASK 86 (2026-09-25): Reduced from 448MB to 384MB.
# 448MB V8 + ~100-150MB Chromium RSS = 548-598MB total, which EXCEEDS the
# 512MB container limit → kernel OOM killer fires. 384MB V8 + 128MB for
# Chromium/OS = 512MB, fitting within the container.
CMD ["sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true; pkill -f 'Xvfb :99' 2>/dev/null || true; sleep 0.5; Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp 2>/dev/null & sleep 1; exec node --expose-gc --max-old-space-size=384 --import tsx render-free-plan.ts"].
