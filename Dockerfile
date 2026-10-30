# ═══════════════════════════════════════════════════════════════════════
# MathU Bot v6 — Hugging Face Spaces Edition (16GB RAM)
# ═══════════════════════════════════════════════════════════════════════
#
# This Dockerfile runs the ENTIRE bot on Hugging Face Spaces.
# Unlike Render's 512MB, HF free tier gives 16GB RAM — more than enough
# for Chrome + CanvasKit + the orchestrator + AI tribunal all together.
#
# What we removed vs the Render Dockerfile:
#   - All memory-limiting hacks (Chrome V8 heap caps, --single-process, etc.)
#   - --disable-gpu (we WANT WebGL/SwiftShader for CanvasKit)
#   - MINIMUM mode forcing (we have RAM for FULL POWER mode)
#   - Memory watchdog (HF manages process lifecycle)
#   - MAX_UPTIME_HOURS (HF keeps it running)
#
# What we added:
#   - libvulkan1 + Mesa GL libs (for SwiftShader WebGL)
#   - Port 7860 (HF requirement)
#   - Uses hf-spaces.ts entry point (built-in keepalive pinger)
#   - Chrome with full WebGL support (no --disable-gpu)
# ═══════════════════════════════════════════════════════════════════════

FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="MathU Bot v6 — Hugging Face Spaces"
LABEL org.opencontainers.image.description="Autonomous MathU bot, 16GB RAM, full features"

# System deps — full Chrome support including WebGL/SwiftShader
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    libxfixes3 libxext6 libxi6 libxtst6 \
    libxcursor1 libxss1 libdbus-1-3 libexpat1 \
    libglib2.0-0 \
    libvulkan1 mesa-vulkan-drivers \
    libgl1-mesa-dri libegl1 libegl-mesa0 libgl1 libgles2 \
    python3 make g++ \
    curl \
    xvfb xauth \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./

# Install dependencies — no need for --no-optional on 16GB
RUN npm install --ignore-scripts

# esbuild platform binary
RUN npm install --ignore-scripts @esbuild/linux-x64

# better-sqlite3 native addon
RUN npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"

# Playwright Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install chromium

# App code
COPY . .

# Runtime directories
RUN mkdir -p /tmp/mathu-logs/screenshots \
    /tmp/.browser-data \
    /tmp/mathu-backups \
    /tmp/mathu-staging \
    /tmp/mathu-regression \
    /tmp/.X11-unix \
    && chown root:root /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

# HF Spaces runs as user "user" (uid 1000) — create and switch
RUN useradd -m -u 1000 user 2>/dev/null || true
RUN chown -R user:user /app /tmp/mathu-logs /tmp/.browser-data /tmp/mathu-backups /tmp/mathu-staging /tmp/mathu-regression /opt/pw-browsers 2>/dev/null || true
USER user

# HF Spaces requires port 7860
EXPOSE 7860

# Environment — tuned for 16GB, NO memory limits, full Chrome WebGL
ENV NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true \
    DISPLAY=:99 \
    LOG_LEVEL=info \
    LOG_MAX_FILES=5 \
    LOG_MAX_SIZE_MB=20 \
    SAVE_SCREENSHOTS=false \
    ENABLE_GAN_TELEMETRY=false \
    ENABLE_LOCAL_VLM=false \
    DB_PATH=/tmp/mathu-bot.db \
    USER_DATA_DIR=/tmp/.browser-data \
    LOG_DIR=/tmp/mathu-logs \
    HEARTBEAT_FILE=/tmp/.heartbeat \
    RENDER=false \
    HF_SPACES=true \
    MAX_UPTIME_HOURS=0 \
    MAX_CYCLES_BEFORE_RESTART=999999 \
    # Chrome flags — FULL WebGL support, no memory limits (we have 16GB!)
    # --use-gl=angle --use-angle=swiftshader = software WebGL via SwiftShader
    # --enable-unsafe-swiftshader = allow SwiftShader in headless mode
    # NO --disable-gpu, NO --single-process, NO --max-old-space-size cap
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1280,800"

# No HEALTHCHECK needed — HF Spaces monitors the port directly

# Start Xvfb (for WebGL) + the bot via hf-spaces.ts entry point
# hf-spaces.ts has a built-in keepalive pinger that prevents HF's 48h sleep
CMD ["sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true; pkill -f 'Xvfb :99' 2>/dev/null || true; sleep 0.5; Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp 2>/dev/null & sleep 1; export DISPLAY=:99; exec node --expose-gc --import tsx hf-spaces.ts"]
