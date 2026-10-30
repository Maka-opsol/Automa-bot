#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# MathU Bot Runner — starts the bot with a timeout, then triggers next run
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "========================================"
echo "MathU Bot Runner — $(date)"
echo "========================================"

# ─── Create runtime directories ───
mkdir -p /tmp/mathu-logs/screenshots /tmp/.browser-data /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

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

# ─── Step 3: Start the bot ───
echo "[runner] Starting MathU Bot..."
BOT_ENTRYPOINT="render-free-plan.ts"

if [ -f "hf-spaces.ts" ]; then
  BOT_ENTRYPOINT="hf-spaces.ts"
  echo "[runner] Using hf-spaces.ts entry point"
else
  echo "[runner] Using render-free-plan.ts entry point"
fi

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
  if curl -sf http://localhost:10000/health > /dev/null 2>&1; then
    echo "[runner] ✅ Bot is healthy (HTTP server responding)"
    break
  fi
  sleep 1
done

# ─── Step 5: Monitor the bot for 5 hours 30 minutes ───
RUN_DURATION=$((5 * 3600 + 30 * 60))
echo "[runner] Bot will run for $((RUN_DURATION / 3600))h $(((RUN_DURATION % 3600) / 60))m"
echo "[runner] Run started at: $(date)"

ELAPSED=0
while [ $ELAPSED -lt $RUN_DURATION ]; do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ⚠️ Bot process exited unexpectedly at $(date)"
    echo "[runner] Last 30 lines of log:"
    tail -30 /tmp/mathu-logs/bot-stdout.log
    break
  fi
  
  if [ $((ELAPSED % 300)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    echo "[runner] Bot running — ${HOURS}h ${MINS}m elapsed"
    tail -1 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || true
  fi
  
  sleep 60
  ELAPSED=$((ELAPSED + 60))
done

# ─── Step 6: Graceful shutdown ───
echo "[runner] Run duration reached — shutting down bot gracefully..."
echo "[runner] Final 20 lines of log:"
tail -20 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || true

kill -TERM $BOT_PID 2>/dev/null || true

for i in $(seq 1 30); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] Bot shut down gracefully"
    break
  fi
  sleep 1
done

if kill -0 $BOT_PID 2>/dev/null; then
  echo "[runner] Bot didn't shut down in 30s — force killing..."
  kill -9 $BOT_PID 2>/dev/null || true
fi

kill $XVFB_PID 2>/dev/null || true

echo "[runner] Cleanup complete — next iteration will be triggered by GitHub Actions"
exit 0
