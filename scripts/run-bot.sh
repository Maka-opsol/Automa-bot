#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# MathU Bot Runner v5 — bulletproof error capture
# ═══════════════════════════════════════════════════════════════════════
#
# v5 fixes:
#   - Always writes startup info to log file BEFORE starting bot
#   - Captures bot crash errors even if node exits immediately
#   - Never exits with code 1 without writing the error to the log
#   - Artifact upload will always have something to show
# ═══════════════════════════════════════════════════════════════════════

# Don't use set -e — we want to capture errors, not abort
set +e

echo "========================================"
echo "MathU Bot Runner v5 — $(date)"
echo "========================================"

# ─── Create runtime directories FIRST ───
mkdir -p /tmp/mathu-logs/screenshots /tmp/mathu-logs/traces /tmp/.browser-data /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
chmod 777 /tmp/mathu-logs/traces 2>/dev/null || true

# ─── Write startup info to log file IMMEDIATELY ───
# This ensures the log file exists even if the bot crashes on line 1
LOG_FILE="/tmp/mathu-logs/bot-stdout.log"
cat > "$LOG_FILE" << 'EOF'
========================================
MathU Bot Runner v5 — Starting
========================================
EOF

echo "[runner] Mode: FULL POWER (all subsystems enabled)"
echo "[runner] Tracing: ENABLED (Playwright traces saved to /tmp/mathu-logs/traces/)"
echo "[runner] Local OCR: $( [ "$ENABLE_LOCAL_OCR" = "true" ] && echo 'ENABLED (Pix2Text)' || echo 'disabled' )"
echo "[runner] Parallel Workers: ${PARALLEL_WORKERS:-1}"
echo "[runner] Log file: $LOG_FILE"

# Write env vars to log for debugging
echo "" >> "$LOG_FILE"
echo "[runner] Environment:" >> "$LOG_FILE"
echo "  PARALLEL_WORKERS=${PARALLEL_WORKERS:-1}" >> "$LOG_FILE"
echo "  ENABLE_TRACING=${ENABLE_TRACING:-false}" >> "$LOG_FILE"
echo "  ENABLE_LOCAL_OCR=${ENABLE_LOCAL_OCR:-false}" >> "$LOG_FILE"
echo "  ENABLE_GAN_TELEMETRY=${ENABLE_GAN_TELEMETRY:-false}" >> "$LOG_FILE"
echo "  ENABLE_LOCAL_VLM=${ENABLE_LOCAL_VLM:-false}" >> "$LOG_FILE"
echo "  AUDITOR_PROVIDER=${AUDITOR_PROVIDER:-none}" >> "$LOG_FILE"
echo "  CHROMIUM_FLAGS=${CHROMIUM_FLAGS:-none}" >> "$LOG_FILE"
echo "  Node version: $(node --version)" >> "$LOG_FILE"
echo "  Working dir: $(pwd)" >> "$LOG_FILE"
echo "  Files in dir:" >> "$LOG_FILE"
ls -1 *.ts 2>/dev/null | head -20 >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# ─── Secret presence check (values NOT logged — security) ───
# Logs whether each secret/env var arrived NON-EMPTY in the runner's
# environment. Goes to BOTH stdout (visible in the GitHub Actions step
# log) and the log file. If a secret shows EMPTY here but you set it in
# GitHub Settings → Secrets and variables → Actions, the secret NAME in
# GitHub doesn't match what the workflow's env: block references (GitHub
# silently substitutes an empty string for an unknown secret name — it
# does NOT error). Compare the names exactly (case-sensitive, no spaces).
echo "[runner] Secret presence check (values redacted):"
echo "[runner] Secret presence check (values redacted):" >> "$LOG_FILE"
for key in MICROSOFT_EMAIL MICROSOFT_PASSWORD TURSO_DATABASE_URL TURSO_AUTH_TOKEN \
           GROQ_API_KEY ZAI_API_KEY AGNES_API_KEY NVIDIA_API_KEY GEMINI_API_KEY \
           OPENROUTER_API_KEY CEREBRAS_API_KEY DEEPINFRA_API_KEY BRAIN_API_KEY \
           CF_API_KEY CF_ACCOUNT_ID CLOUDINARY_CLOUD_NAME CLOUDINARY_API_KEY \
           CLOUDINARY_API_SECRET PAT_TOKEN; do
  val="${!key}"
  if [ -n "$val" ]; then
    line="  ✅ $key — SET (length: ${#val})"
  else
    line="  ❌ $key — EMPTY (not in env or secret name mismatch)"
  fi
  echo "$line"
  echo "$line" >> "$LOG_FILE"
done
echo ""
echo "" >> "$LOG_FILE"

# ─── Step 1: Start Xvfb ───
echo "[runner] Starting Xvfb virtual display..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
pkill -f 'Xvfb :99' 2>/dev/null || true
sleep 0.5
Xvfb :99 -screen 0 1280x800x24 -ac -nolisten tcp 2>/dev/null &
XVFB_PID=$!
sleep 1
export DISPLAY=:99
echo "[runner] Xvfb started (PID $XVFB_PID) on display :99"

# ─── Step 2: Verify Chrome/Playwright ───
echo "[runner] Checking Playwright Chromium..."
npx playwright install chromium 2>/dev/null || true

# ─── Step 3: Verify Pix2Text ───
if [ "$ENABLE_LOCAL_OCR" = "true" ]; then
  echo "[runner] Checking Pix2Text installation..."
  if python -c "import pix2text" 2>/dev/null; then
    echo "[runner] ✅ Pix2Text is available — local OCR active"
  else
    echo "[runner] ⚠️ Pix2Text not found — local OCR will use fallback"
  fi
fi

# ─── Step 4: Verify Ollama is running ───
if [ "$AUDITOR_PROVIDER" = "ollama" ]; then
  echo "[runner] Checking Ollama server..."
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "[runner] ✅ Ollama server is running"
    # Check if model is loaded
    OLLAMA_MODELS=$(curl -s http://localhost:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | head -5)
    echo "[runner] Ollama models: $OLLAMA_MODELS" >> "$LOG_FILE"
  else
    echo "[runner] ⚠️ Ollama server not responding — auditor will fall back to cloud"
    echo "[runner] WARNING: Ollama not running" >> "$LOG_FILE"
  fi
fi

# ─── Step 5: Determine entry point ───
echo "[runner] Starting MathU Bot..."
PARALLEL_WORKERS="${PARALLEL_WORKERS:-1}"
BOT_ENTRYPOINT="render-free-plan.ts"

if [ "$PARALLEL_WORKERS" -gt 1 ] && [ -f "parallel-entry.ts" ]; then
  BOT_ENTRYPOINT="parallel-entry.ts"
  echo "[runner] Using parallel-entry.ts (${PARALLEL_WORKERS} parallel browser workers)"
elif [ -f "hf-spaces.ts" ]; then
  BOT_ENTRYPOINT="hf-spaces.ts"
  echo "[runner] Using hf-spaces.ts entry point (single browser)"
else
  echo "[runner] Using render-free-plan.ts entry point (single browser)"
fi

# Verify the entry point exists
if [ ! -f "$BOT_ENTRYPOINT" ]; then
  echo "[runner] ❌ FATAL: Entry point $BOT_ENTRYPOINT not found!"
  echo "[runner] ❌ FATAL: Entry point $BOT_ENTRYPOINT not found!" >> "$LOG_FILE"
  echo "[runner] Available .ts files:" >> "$LOG_FILE"
  ls -1 *.ts 2>/dev/null >> "$LOG_FILE"
  exit 1
fi

echo "[runner] Entry point: $BOT_ENTRYPOINT"
echo "[runner] Starting node..." >> "$LOG_FILE"

# ─── Step 6: Start the bot ───
# Use node directly (not tsx) first to check for syntax errors
# Then start with tsx

# Load .env file if it exists (written by the workflow's "Write .env from
# BOT_ENV_FILE secret" step). Node 22+ supports --env-file which loads
# the file into process.env BEFORE the bot starts. This restores the
# BOT_ENV_FILE mechanism from the old bot-runner.yml workflow: the user
# stores the entire .env (all API keys, creds) as a single secret.
# If .env doesn't exist, the bot relies on individual secrets from the
# workflow's env: block (the secondary mechanism).
ENV_FILE_FLAG=""
if [ -f ".env" ]; then
  ENV_FILE_FLAG="--env-file=.env"
  echo "[runner] Loading .env file via --env-file" >> "$LOG_FILE"
  KEY_COUNT=$(grep -cE '^[A-Z_]+=' .env 2>/dev/null || echo 0)
  echo "[runner] .env contains $KEY_COUNT keys" >> "$LOG_FILE"
else
  echo "[runner] No .env file found — relying on workflow env: block secrets" >> "$LOG_FILE"
fi
node --expose-gc --max-old-space-size=8192 --import tsx $ENV_FILE_FLAG "$BOT_ENTRYPOINT" >> "$LOG_FILE" 2>&1 &
BOT_PID=$!
echo "[runner] Bot started (PID $BOT_PID)"
echo "[runner] Bot PID: $BOT_PID" >> "$LOG_FILE"

# ─── Step 7: Wait for initialization (max 120 seconds) ───
echo "[runner] Waiting for bot to initialize (up to 120s)..."
for i in $(seq 1 120); do
  # Check if bot is still alive
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ❌ Bot process died during initialization!"
    echo "[runner] ❌ Bot process died during initialization!" >> "$LOG_FILE"
    echo "[runner] Exit code: $(wait $BOT_PID; echo $?)" >> "$LOG_FILE"
    echo "[runner] Full log:" >> "$LOG_FILE"
    cat "$LOG_FILE"
    # Also print to Actions console
    echo "========================================"
    echo "BOT CRASH LOG (first 100 lines):"
    echo "========================================"
    head -100 "$LOG_FILE"
    echo "========================================"
    echo "BOT CRASH LOG (last 50 lines):"
    echo "========================================"
    tail -50 "$LOG_FILE"
    # Exit with 0 so artifact upload still runs and we can download the full log
    exit 0
  fi
  
  # Check if HTTP server is responding
  if curl -sf http://localhost:10000/health > /dev/null 2>&1; then
    echo "[runner] ✅ Bot is healthy (HTTP server responding after ${i}s)"
    echo "[runner] ✅ Bot healthy after ${i}s" >> "$LOG_FILE"
    break
  fi
  
  # Log progress every 15 seconds
  if [ $((i % 15)) -eq 0 ] && [ $i -gt 0 ]; then
    echo "[runner] Still waiting... (${i}s elapsed)"
    echo "[runner] Last log line:"
    tail -1 "$LOG_FILE" 2>/dev/null || echo "(no output yet)"
  fi
  sleep 1
done

# ─── Step 8: Monitor ───
RUN_DURATION=$((5 * 3600 + 30 * 60))
POLL_INTERVAL=30
STATUS_LOG_INTERVAL=120
MEMORY_LOG_INTERVAL=600

echo "[runner] Bot will run for $((RUN_DURATION / 3600))h $(((RUN_DURATION % 3600) / 60))m"
echo "[runner] Run started at: $(date)"

ELAPSED=0
while [ $ELAPSED -lt $RUN_DURATION ]; do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ⚠️ Bot process exited at $(date)"
    echo "[runner] ⚠️ Bot exited at $(date)" >> "$LOG_FILE"
    echo "[runner] Last 50 lines:" >> "$LOG_FILE"
    tail -50 "$LOG_FILE" >> "$LOG_FILE"
    echo "========================================"
    echo "BOT EXIT LOG (last 50 lines):"
    echo "========================================"
    tail -50 "$LOG_FILE"
    break
  fi

  if [ $((ELAPSED % STATUS_LOG_INTERVAL)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    echo "────────────────────────────────────────"
    echo "[runner] 📊 Bot running — ${HOURS}h ${MINS}m elapsed"
    echo "[runner] Last 10 log lines:"
    tail -10 "$LOG_FILE" 2>/dev/null || echo "(no logs)"
    echo "────────────────────────────────────────"
  fi

  if [ $((ELAPSED % MEMORY_LOG_INTERVAL)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    HOURS=$((ELAPSED / 3600))
    MINS=$(((ELAPSED % 3600) / 60))
    BOT_RSS=$(ps -o rss= -p $BOT_PID 2>/dev/null | awk '{print $1}')
    BOT_RSS_MB=$((BOT_RSS / 1024))
    MEM_INFO=$(free -m 2>/dev/null | head -2 | tail -1)
    echo "[runner] 💾 Memory at ${HOURS}h ${MINS}m: Bot RSS=${BOT_RSS_MB}MB | System: ${MEM_INFO}"
  fi

  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + $POLL_INTERVAL))
done

# ─── Step 9: Graceful shutdown ───
echo "========================================"
echo "[runner] Run duration reached — shutting down..."
echo "[runner] Final 30 lines:"
echo "────────────────────────────────────────"
tail -30 "$LOG_FILE" 2>/dev/null || true
echo "────────────────────────────────────────"

echo "[runner] Final memory:"
free -m 2>/dev/null | head -2 || true

echo "[runner] Trace files:"
ls -lh /tmp/mathu-logs/traces/ 2>/dev/null || echo "(no traces)"

echo "[runner] Sending SIGTERM..."
kill -TERM $BOT_PID 2>/dev/null || true

for i in $(seq 1 30); do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "[runner] ✅ Bot shut down after ${i}s"
    break
  fi
  sleep 1
done

if kill -0 $BOT_PID 2>/dev/null; then
  echo "[runner] Force killing..."
  kill -9 $BOT_PID 2>/dev/null || true
fi

kill $XVFB_PID 2>/dev/null || true

LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
LOG_SIZE_KB=$((LOG_SIZE / 1024))
echo "[runner] Bot log size: ${LOG_SIZE_KB}KB"

TOTAL_SIZE=$(du -sh /tmp/mathu-logs/ 2>/dev/null | awk '{print $1}')
echo "[runner] Total log+trace size: ${TOTAL_SIZE}"

echo "[runner] Done — exiting at: $(date)"
# Exit with 0 so artifacts upload
exit 0
