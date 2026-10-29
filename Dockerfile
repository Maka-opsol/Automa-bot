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
# TASK 145 (2026-10-29): Added libvulkan1 + Mesa GL/Vulkan libraries.
# Chrome's bundled SwiftShader (used via --use-angle=swiftshader) talks to
# the SwiftShader Vulkan ICD through the SYSTEM Vulkan loader (libvulkan.so.1).
# Without libvulkan1, Chrome cannot load the ICD → ANGLE fails → no WebGL
# context → CanvasKit fails to compile → page stays permanently BLANK.
#
# This is the missing piece Task 144 (headless=false) needed to actually
# work. headless=false got us full Chromium (which has WebGL support), but
# WebGL itself still couldn't initialize because libvulkan1 wasn't installed.
#
# mesa-vulkan-drivers provides lavapipe (a software Vulkan ICD) as a
# fallback in case Chrome's bundled SwiftShader Vulkan ICD fails to load.
#
# libgl1-mesa-dri provides Mesa's DRI drivers including llvmpipe (software
# OpenGL rasterizer) — needed as a fallback for --use-gl=egl or
# --use-angle=gl if SwiftShader Vulkan path fails.
#
# libegl1 + libegl-mesa0 + libgl1 + libgles2 provide the EGL/GLES runtime
# that ANGLE uses for EGL surface management even when using SwiftShader.
#
# Memory cost: ~60MB on disk, ~0MB RAM until actually used. When
# SwiftShader is active, expect ~30-50MB additional RAM (within the 90s
# CanvasKit grace period Task 139 added).
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
    && rm -rf /var/lib/apt/lists/*

# TASK 126 (2026-10-22): REMOVED Pix2Text and torch entirely.
# Pix2Text + torch CPU wheels take 30-60+ minutes to install on Render's
# free tier build environment, causing deployment timeouts.
# The bot doesn't critically need Pix2Text — it has multiple other OCR paths:
#   1. page.evaluate(() => document.body.innerText) — extracts text from
#      the DOM directly (Flutter Web renders text in the DOM)
#   2. Cloud vision providers (Groq, NVIDIA, z.ai, etc.) can read math
#      from screenshots
#   3. Wolfram solver can solve problems from text
# Removing pix2text + torch saves ~2GB+ of image space and prevents build
# timeouts. Python3 is still installed (needed by other potential scripts)
# but no pip packages are installed.
# If Pix2Text is needed in the future, install it as a separate optional
# build stage or use a pre-built image.

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
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --disable-component-extensions-with-background-pages --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,BackForwardCache,SharedArrayBuffer --enable-features=Vulkan,UseSkiaRenderer,VulkanFromANGLE --js-flags=--max-old-space-size=64 --optimize-for-size --single-process --purge-memory-policy --use-gl=angle --use-angle=swiftshader"

# TASK 140 (2026-10-29): Removed --disable-gpu and --disable-software-rasterizer
# from CHROMIUM_FLAGS. These flags were KILLING the page — CanvasKit requires
# WebGL to render. Without GPU (even software GPU/SwiftShader), CanvasKit
# can't paint anything → page stays permanently BLANK.
# Also removed --disable-features=V8VmFuture (was causing issues).
#
# Chrome in headless mode uses SwiftShader (software WebGL) by default.
# This is slower than hardware GPU but works on headless servers.
# SwiftShader uses ~30-50MB more memory than --disable-gpu, but
# a blank page that uses less memory is USELESS — the bot needs to see
# the rendered page to complete questions.
#
# The 90s CanvasKit compile grace period (Task 139) handles the memory spike.
# TASK 132 (2026-10-28): Chrome V8 heap lowered 96→64MB + memory flags added.
# See CHROMIUM_FLAGS above. Combined with render-free-plan.ts aggressive
# memory monitor (5s interval, L2 at RSS>350MB, L3 at RSS>400MB), this
# prevents the kernel OOM kill during the Flutter Web CanvasKit render phase.

# TASK 131 (2026-10-28): Bumped start-period from 60s to 300s and timeout
# from 10s to 30s. The render-free-plan.ts now DEFERS container.get('orchestrator')
# until AFTER server.listen() fires — that load takes 5-15s and blocks the
# event loop. HEALTHCHECK requests queue up in the OS TCP buffer during the
# block, so the timeout needs to be long enough to survive it (30s).
# The start-period of 300s gives Render 5 minutes of tolerance for the
# orchestrator load + first cycle to spin up before health checks count
# against the service.
HEALTHCHECK --interval=60s --timeout=30s --start-period=300s --retries=5 \
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
# TASK 135 (2026-10-28): Raised Node V8 heap from 384MB to 448MB.
# The bot was hitting V8's own OOM limit (384MB) during Playwright's
# closeBrowser() teardown, which generates ~300MB of transient JS objects
# (targetdestroyed events, response objects, page cleanup). Node's heap
# would jump from 77MB to 380MB in <1 second, hitting the 384MB limit.
# 448MB gives 64MB more headroom for these teardown spikes.
# Total budget: 448MB Node V8 + ~64MB Chrome = 512MB (fits container).
# TASK 141 (2026-10-29): RESTORED Xvfb. Task 136 removed it to save 30MB,
# but Xvfb is REQUIRED for Chrome's WebGL/SwiftShader to initialize. Without
# a display, EGL fails with "eglInitialize SwANGLE failed" and Chrome crashes
# with SIGTRAP. CanvasKit needs WebGL to render the page. No display = blank page.
#
# The 30MB cost of Xvfb is worth it — a blank page that uses less memory
# is useless. The bot needs to SEE the rendered page to complete questions.
# TASK 145 (2026-10-29): Updated CMD to explicitly export VK_ICD_FILENAMES
# before launching Chrome. Chrome's bundled SwiftShader Vulkan ICD lives at
# /opt/pw-browsers/chromium-XXXX/chrome-linux/vk_swiftshader_icd.json.
# Normally Chrome auto-registers this via --use-angle=swiftshader, but on
# minimal Debian-slim images without a Vulkan ICD dispatcher, the
# auto-registration can silently fail. Setting VK_ICD_FILENAMES explicitly
# guarantees the SwiftShader ICD is discoverable by the Vulkan loader.
#
# mesa-vulkan-drivers (installed above) ALSO drops a lavapipe ICD at
# /usr/share/vulkan/icd.d/radeon_icd.x86_64.json — if SwiftShader is
# somehow missing or broken, lavapipe will be tried as a fallback (slower
# but functional).
#
# Fallback chain if Vulkan/SwiftShader still fails:
#   1. SwiftShader Vulkan ICD (Chrome's bundled, via libvulkan1 + VK_ICD_FILENAMES)
#   2. Mesa lavapipe Vulkan ICD (mesa-vulkan-drivers)
#   3. Mesa llvmpipe OpenGL (libgl1-mesa-dri, requires --use-gl=egl instead
#      of --use-angle=swiftshader)
#
# Diagnostic logging (Task 145c, in browser.ts) will print WebGL availability
# after page load so we can verify the chain actually works at runtime.
# TASK 146 (2026-10-29): Fixed VK_ICD_FILENAMES lookup.
# Task 145's `ls /opt/pw-browsers/chromium-*/chrome-linux/vk_swiftshader_icd.json`
# returned EMPTY on Render (Playwright's chromium download for this version
# doesn't bundle vk_swiftshader_icd.json at that path). The subsequent
# `dirname` of empty string produced "dirname: missing operand" bash errors
# in the logs.
#
# New approach: use `find` to search the entire /opt/pw-browsers tree for
# any Vulkan ICD JSON (SwiftShader's, lavapipe's, or anything else). If
# found, set VK_ICD_FILENAMES to the first match. If NOT found, leave it
# unset — Chrome will auto-discover ICDs via the standard /usr/share/vulkan/icd.d
# path (mesa-vulkan-drivers drops lavapipe there) OR fall back to llvmpipe
# via libgl1-mesa-dri + --use-gl=egl.
#
# This is non-fatal: if SwiftShader's ICD isn't found, Chrome's WebGL backend
# falls back to lavapipe (slower but functional). The diagnostic probe
# (Task 146 in browser.ts) will tell us at runtime which renderer actually
# got selected.
CMD ["sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true; pkill -f 'Xvfb :99' 2>/dev/null || true; sleep 0.5; Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp 2>/dev/null & sleep 1; export DISPLAY=:99; VK_ICD=$(find /opt/pw-browsers /usr/share/vulkan/icd.d /etc/vulkan/icd.d -name '*icd*.json' -o -name '*swiftshader*.json' 2>/dev/null | head -1); if [ -n \"$VK_ICD\" ]; then export VK_ICD_FILENAMES=\"$VK_ICD\"; export VK_LAYER_PATH=$(dirname \"$VK_ICD\"); echo \"[TASK 146] VK_ICD_FILENAMES=$VK_ICD_FILENAMES\"; echo \"[TASK 146] VK_LAYER_PATH=$VK_LAYER_PATH\"; else echo \"[TASK 146] No Vulkan ICD found — Chrome will use system auto-discovery (lavapipe/llvmpipe fallback)\"; fi; exec node --expose-gc --max-old-space-size=448 --import tsx render-free-plan.ts"]
