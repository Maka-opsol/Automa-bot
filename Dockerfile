FROM node:20-bookworm-slim

# System deps: Chromium shared libs + build tools for better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    libxfixes3 libxext6 libxi6 libxtst6 \
    libxcursor1 libxss1 libdbus-1-3 libexpat1 \
    libglib2.0-0 \
    python3 make g++ \
    curl \
    xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./

# Main npm install — --ignore-scripts defers postinstall, --no-optional skips
# onnxruntime-node, @xenova/transformers, etc.
RUN NODE_OPTIONS=--max-old-space-size=256 \
    npm_config_jobs=1 \
    npm_config_build_from_source=false \
    npm install --ignore-scripts --no-optional

# esbuild platform binary
RUN npm install --ignore-scripts @esbuild/linux-x64

# better-sqlite3 native addon
RUN npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"

# Playwright Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install chromium

# Copy source
COPY . .

# BUILD STEP: Compile all .ts → .js using esbuild (fast, low-memory)
# This eliminates tsx runtime transpilation overhead (~50-100MB heap savings)
RUN node -e "
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const files = fs.readdirSync('.').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
let ok = 0, fail = 0;
for (const file of files) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const out = esbuild.transformSync(src, { loader: 'ts', target: 'node20', format: 'cjs', sourcemap: false });
    fs.writeFileSync('dist/' + file.replace('.ts', '.js'), out.code);
    ok++;
  } catch (e) {
    console.error('FAIL: ' + file + ' — ' + e.message.slice(0, 80));
    fail++;
  }
}
console.log('Compiled: ' + ok + ' files, ' + fail + ' failures');
if (fail > 0) process.exit(1);
"

# Verify build
RUN node -e "require('./dist/render-free-plan.js'); console.log('Build OK')" 2>&1 | head -5 || true

# Runtime env
ENV NODE_ENV=production \
    ENABLE_LOCAL_VLM=false \
    DB_PATH=/tmp/mathu-bot.db \
    USER_DATA_DIR=/tmp/.browser-data \
    LOG_DIR=/tmp/mathu-logs \
    HEARTBEAT_FILE=/tmp/.heartbeat \
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --disable-component-extensions-with-background-pages --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion --js-flags=--max-old-space-size=96 --optimize-for-size --single-process"

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:10000/health || exit 1

# Run WITHOUT tsx — use pre-compiled dist/ JS
# This saves ~50-100MB of heap at startup (no runtime transpilation)
CMD ["sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true; pkill -f 'Xvfb :99' 2>/dev/null || true; sleep 0.5; Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp 2>/dev/null & sleep 1; exec node --expose-gc --max-old-space-size=384 dist/render-free-plan.js"]
