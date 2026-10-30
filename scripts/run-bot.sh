#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# MathU Bot Runner v4 — TIER 1 UPGRADE
# ═══════════════════════════════════════════════════════════════════════
#
# TIER 1 features:
#   - FULL POWER mode (all subsystems enabled)
#   - Playwright trace recording (every click/page-load captured)
#   - Pix2Text + Torch local OCR (installed by workflow)
#   - Full Chrome with WebGL/SwiftShader
#
# LOGGING:
#   - Status every 2 minutes (last 10 bot log lines)
#   - Memory usage every 10 minutes
#   - Full bot stdout → /tmp/mathu-logs/bot-stdout.log
#   - Playwright traces → /tmp/mathu-logs/traces/
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "========================================"
echo "MathU Bot Runner v4 (TIER 1) — $(date)"
echo "========================================"
echo "[runner] Mode: FULL POWER (all subsystems enabled)"
echo "[runner] Tracing: ENABLED (Playwright traces saved to /tmp/mathu-logs/traces/)"
echo "[runner] Local OCR: $( [ "$ENABLE_LOCAL_OCR" = "true" ] && echo 'ENABLED (Pix2Text)' || echo 'disabled' )"

# ─── Create runtime directories ───
mkdir -p /tmp/mathu-logs/screenshots /tmp/mathu-logs/traces /tmp/.browser-data /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
chmod 777 /tmp/mathu-logs/traces 2>/dev/null || true

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

# ─── Step 3: Verify Pix2Text is available (if local OCR enabled) ───
if [ "$ENABLE_LOCAL_OCR" = "true" ]; then
  echo "[runner] Checking Pix2Text installation..."
  if python -c "import pix2text" 2>/dev/null; then
    echo "[runner] ✅ Pix2Text is available — local OCR active"
  else
    echo "[runner] ⚠️ Pix2Text not found — local OCR will use fallback (Tesseract/API)"
  fi
fi

# ─── Step 4: Start the bot ───
echo "[runner] Starting MathU Bot..."
BOT_ENTRYPOINT="render-free-plan.ts"

# If hf-spaces.ts exists, prefer it (better for ephemeral environments)
if [ -f "hf-spaces.ts" ]; then
  BOT_ENTRYPOINT="hf-spaces.ts"
  echo "[runner] Using hf-spaces.ts entry point"
else
  echo "[runner] Using render-free-plan.ts entry point"
fi

# TIER 1: Give Node 8GB heap — we have 16GB total and FULL POWER mode
# uses more memory for all the subsystems.
node --expose-gc --max-old-space-size=8192 --import tsx "$BOT_ENTRYPOINT" > /tmp/mathu-logs/bot-stdout.log 2>&1 &
BOT_PID=$!
echo "[runner] Bot started (PID $BOT_PID)"
echo "[runner] Logs: /tmp/mathu-logs/bot-stdout.log"
echo "[runner] Traces: /tmp/mathu-logs/traces/"

# ─── Step 5: Wait for the bot to initialize (max 90 seconds) ───
# TIER 1: Increased from 60s to 90s because FULL POWER mode starts more
# subsystems and takes longer to initialize.
echo "[runner] Waiting for bot to initialize (up to 90s)..."
for i in $(seq 1 90); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ❌ Bot process died during initialization!"
    echo "[runner] Last 80 lines of log:"
    tail -80 /tmp/mathu-logs/bot-stdout.log
    exit 1
  fi
  # Check if the bot is responding (if it has an HTTP server)
  if curl -sf http://localhost:10000/health > /dev/null 2>&1; then
    echo "[runner] ✅ Bot is healthy (HTTP server responding after ${i}s)"
    break
  fi
  # Log progress every 15 seconds
  if [ $((i % 15)) -eq 0 ] && [ $i -gt 0 ]; then
    echo "[runner] Still waiting... (${i}s elapsed) Last log line:"
    tail -1 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || echo "(no output yet)"
  fi
  sleep 1
done

# ─── Step 6: Monitor the bot for 5 hours 30 minutes ───
RUN_DURATION=$((5 * 3600 + 30 * 60))  # 5h 30m in seconds
POLL_INTERVAL=30                         # Check every 30 seconds
STATUS_LOG_INTERVAL=120                  # Log status every 2 minutes
MEMORY_LOG_INTERVAL=600                  # Log memory every 10 minutes
TRACE_CHECK_INTERVAL=1800                 # Check trace files every 30 minutes

echo "[runner] Bot will run for $((RUN_DURATION / 3600))h $(((RUN_DURATION % 3600) / 60))m"
echo "[runner] Run started at: $(date)"
echo "[runner] Run will end at: $(date -d "+$RUN_DURATION seconds" 2>/dev/null || date -v+${RUN_DURATION}S 2>/dev/null || echo 'unknown')"
echo "[runner] Polling every ${POLL_INTERVAL}s, status every $((STATUS_LOG_INTERVAL / 60))min, memory every $((MEMORY_LOG_INTERVAL / 60))min"
echo "========================================"

# Monitor loop
ELAPSED=0
while [ $ELAPSED -lt $RUN_DURATION ]; do
  # Check if bot is still alive
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ⚠️ Bot process exited unexpectedly at $(date)"
    echo "[runner] Last 50 lines of log:"
    tail -50 /tmp/mathu-logs/bot-stdout.log
    break
  fi

  # Status log — every 2 minutes, show last 10 lines of bot log
  if [ $((ELAPSED % STATUS_LOG_INTERVAL)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    echo "────────────────────────────────────────"
    echo "[runner] 📊 Bot running — ${HOURS}h ${MINS}m elapsed"
    echo "[runner] Last 10 log lines:"
    tail -10 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || echo "(no logs yet)"
    echo "────────────────────────────────────────"
  fi

  # Memory log — every 10 minutes
  if [ $((ELAPSED % MEMORY_LOG_INTERVAL)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    BOT_RSS=$(ps -o rss= -p $BOT_PID 2>/dev/null | awk '{print $1}')
    BOT_RSS_MB=$((BOT_RSS / 1024))
    MEM_INFO=$(free -m 2>/dev/null | head -2 | tail -1)
    # Count trace files
    TRACE_COUNT=$(ls /tmp/mathu-logs/traces/ 2>/dev/null | wc -l)
    echo "[runner] 💾 Memory at ${HOURS}h ${MINS}m: Bot RSS=${BOT_RSS_MB}MB | Traces: ${TRACE_COUNT} files | System: ${MEM_INFO}"
  fi

  # Trace check — every 30 minutes, report trace file sizes
  if [ $((ELAPSED % TRACE_CHECK_INTERVAL)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    echo "[runner] 🎥 Trace files:"
    ls -lh /tmp/mathu-logs/traces/ 2>/dev/null || echo "(no traces yet)"
  fi

  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + $POLL_INTERVAL))
done

# ─── Step 7: Graceful shutdown ───
echo "========================================"
echo "[runner] Run duration reached — shutting down bot gracefully..."
echo "[runner] Final 30 lines of log:"
echo "────────────────────────────────────────"
tail -30 /tmp/mathu-logs/bot-stdout.log 2>/dev/null || true
echo "────────────────────────────────────────"

# Show final memory usage
echo "[runner] Final memory usage:"
free -m 2>/dev/null | head -2 || true

# Show trace files
echo "[runner] Playwright trace files:"
ls -lh /tmp/mathu-logs/traces/ 2>/dev/null || echo "(no traces generated)"

# Try graceful shutdown first (SIGTERM)
echo "[runner] Sending SIGTERM to bot (PID $BOT_PID)..."
kill -TERM $BOT_PID 2>/dev/null || true

# Wait up to 30 seconds for graceful shutdown
for i in $(seq 1 30); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ✅ Bot shut down gracefully after ${i}s"
    break
  fi
  sleep 1
done

# Force kill if still running
if kill -0 $BOT_PID 2>/dev/null; then
  echo "[runner] ⚠️ Bot didn't shut down in 30s — force killing (SIGKILL)..."
  kill -9 $BOT_PID 2>/dev/null || true
fi

# Clean up Xvfb
echo "[runner] Stopping Xvfb (PID $XVFB_PID)..."
kill $XVFB_PID 2>/dev/null || true

# Show log file size for debugging
LOG_SIZE=$(stat -c%s /tmp/mathu-logs/bot-stdout.log 2>/dev/null || stat -f%z /tmp/mathu-logs/bot-stdout.log 2>/dev/null || echo 0)
LOG_SIZE_KB=$((LOG_SIZE / 1024))
echo "[runner] Bot log size: ${LOG_SIZE_KB}KB"

# Show total artifact size
TOTAL_SIZE=$(du -sh /tmp/mathu-logs/ 2>/dev/null | awk '{print $1}')
echo "[runner] Total log+trace size: ${TOTAL_SIZE}"

echo "[runner] Cleanup complete — next iteration will be triggered by GitHub Actions"
echo "[runner] Exiting at: $(date)"
exit 0
