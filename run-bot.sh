#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# MathU Bot Runner — starts the bot with a timeout, then triggers next run
# ═══════════════════════════════════════════════════════════════════════
#
# This script:
#   1. Starts Xvfb (virtual display for Chrome WebGL)
#   2. Starts the MathU bot in the background
#   3. Waits for 5 hours 30 minutes (leaving 20 min for cleanup)
#   4. Gracefully shuts down the bot
#   5. The GitHub Actions workflow then triggers the next iteration
#
# The bot runs as a background process. Logs go to /tmp/mathu-logs/.
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "========================================"
echo "MathU Bot Runner — $(date)"
echo "========================================"

# ─── Create runtime directories ───
mkdir -p /tmp/mathu-logs/screenshots /tmp/.browser-data /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# ─── Step 1: Start Xvfb (virtual display for Chrome WebGL) ───
echo "[runner] Starting Xvfb virtual display..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
pkill -f 'Xvfb :99' 2>/dev/null || true
sleep 0.5
Xvfb :99 -screen 0 1280x800x24 -ac -nolisten tcp 2>/dev/null &
XVFB_PID=$!
sleep 1
export DISPLAY=:99
echo "[runner] Xvfb started (PID $XVFB_PID) on display :99"

# ─── Step 2: Verify Chrome/Playwright is available ───
echo "[runner] Checking Playwright Chromium..."
npx playwright install chromium 2>/dev/null || true
echo "[runner] Playwright Chromium path: $(npx playwright install --dry-run chromium 2>&1 | head -1 || echo 'unknown')"

# ─── Step 3: Start the bot ───
echo "[runner] Starting MathU Bot..."
# Use hf-spaces.ts entry point (it has the keepalive pinger built in)
# but we DON'T need the keepalive — GitHub Actions handles the loop.
# We use render-free-plan.ts because it has the deferred boot + memory watchdog.
# On 16GB RAM, the watchdog won't trigger anyway.
BOT_ENTRYPOINT="render-free-plan.ts"

# If hf-spaces.ts exists, prefer it (better for ephemeral environments)
if [ -f "hf-spaces.ts" ]; then
  BOT_ENTRYPOINT="hf-spaces.ts"
  echo "[runner] Using hf-spaces.ts entry point"
else
  echo "[runner] Using render-free-plan.ts entry point"
fi

# Start the bot in the background
# --expose-gc enables manual garbage collection
# --max-old-space-size=4096 gives Node 4GB heap (we have 16GB total)
node --expose-gc --max-old-space-size=4096 --import tsx "$BOT_ENTRYPOINT" > /tmp/mathu-logs/bot-stdout.log 2>&1 &
BOT_PID=$!
echo "[runner] Bot started (PID $BOT_PID)"
echo "[runner] Logs: /tmp/mathu-logs/bot-stdout.log"

# ─── Step 4: Wait for the bot to initialize (max 60 seconds) ───
echo "[runner] Waiting for bot to initialize (up to 60s)..."
for i in $(seq 1 60); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ❌ Bot process died during initialization!"
    echo "[runner] Last 50 lines of log:"
    tail -50 /tmp/mathu-logs/bot-stdout.log
    exit 1
  fi
  # Check if the bot is responding (if it has an HTTP server)
  if curl -sf http://localhost:10000/health > /dev/null 2>&1; then
    echo "[runner] ✅ Bot is healthy (HTTP server responding)"
    break
  fi
  sleep 1
done

# ─── Step 5: Monitor the bot for 5 hours 30 minutes ───
# GitHub Actions hard limit is 6 hours (360 min). We use 350 min for the
# workflow timeout, and 330 min (5.5 hours) here to leave room for cleanup.
RUN_DURATION=$((5 * 3600 + 30 * 60))  # 5h 30m in seconds
echo "[runner] Bot will run for $((RUN_DURATION / 3600))h $(((RUN_DURATION % 3600) / 60))m"
echo "[runner] Run started at: $(date)"
echo "[runner] Run will end at: $(date -d "+$RUN_DURATION seconds" 2>/dev/null || date -v+${RUN_DURATION}S 2>/dev/null || echo 'unknown')"

# Monitor loop — check every 60 seconds that the bot is still alive
ELAPSED=0
while [ $ELAPSED -lt $RUN_DURATION ]; do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ⚠️ Bot process exited unexpectedly at $(date)"
    echo "[runner] Last 30 lines of log:"
    tail -30 /tmp/mathu-logs/bot-stdout.log
    # Don't exit with error — let the workflow trigger the next iteration
    break
  fi
  
  # Log status every 5 minutes
  if [ $((ELAPSED % 300)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    echo "[runner] Bot running — ${HOURS}h ${MINS}m elapsed"
    # Show last log line for visibility
    tail -1 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || true
  fi
  
  sleep 60
  ELAPSED=$((ELAPSED + 60))
done

# ─── Step 6: Graceful shutdown ───
echo "[runner] Run duration reached — shutting down bot gracefully..."
echo "[runner] Final 20 lines of log:"
tail -20 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || true

# Try graceful shutdown first (SIGTERM)
kill -TERM $BOT_PID 2>/dev/null || true

# Wait up to 30 seconds for graceful shutdown
for i in $(seq 1 30); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] Bot shut down gracefully"
    break
  fi
  sleep 1
done

# Force kill if still running
if kill -0 $BOT_PID 2>/dev/null; then
  echo "[runner] Bot didn't shut down in 30s — force killing..."
  kill -9 $BOT_PID 2>/dev/null || true
fi

# Clean up Xvfb
kill $XVFB_PID 2>/dev/null || true

echo "[runner] Cleanup complete — next iteration will be triggered by GitHub Actions"
echo "[runner] Exiting at: $(date)"
exit 0
