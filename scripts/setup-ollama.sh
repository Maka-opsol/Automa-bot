#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Ollama Setup Script — installs Ollama + pulls a vision model
# ═══════════════════════════════════════════════════════════════════════
#
# For operators running the bot on a dedicated host (Render, VPS, etc.).
# On GitHub Actions, the workflow's "Setup Ollama + vision model" step
# (Step 5.5 in mathu-bot-loop.yml) handles this inline — this standalone
# script is for non-CI environments.
#
# This script:
#   1. Installs Ollama (the local LLM server) via the official installer
#   2. Starts the Ollama server in the background
#   3. Pulls a vision-capable model (the tribunal sends screenshots, so
#      the model MUST support vision)
#   4. Verifies the model responds
#
# After running this, the bot auto-detects Ollama within 30 seconds via
# its reachability probe (providers-ollama.ts) — no restart, no env vars
# required. When every cloud provider goes down, the methodology rotator
# switches to Ollama and the bot keeps running on local hardware.
#
# MODEL: qwen2.5vl:7b (default — matches providers-ollama.ts, .env.example,
#   and bootstrap-calibration.ts). Override with OLLAMA_MODEL env var.
#   Other vision options: qwen2.5vl:32b, minicpm-v:8b, llama3.2-vision:11b.
#
# MEMORY BUDGET:
#   Ollama server:     ~50MB
#   Model (loaded):    ~4.7GB (when active)
#   Total:             ~4.7GB — fits in 16GB with 11GB to spare
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "[ollama-setup] Installing Ollama..."

# Install Ollama via the official installer
curl -fsSL https://ollama.com/install.sh | sh

echo "[ollama-setup] Starting Ollama server..."
# Start Ollama in the background
nohup ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!
echo "[ollama-setup] Ollama server started (PID $OLLAMA_PID)"

# Wait for Ollama to be ready (30s timeout)
echo "[ollama-setup] Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "[ollama-setup] ✅ Ollama server is ready"
    break
  fi
  sleep 1
done

# Check if Ollama is actually running
if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "[ollama-setup] ❌ Ollama server failed to start"
  echo "[ollama-setup] Ollama log:"
  cat /tmp/ollama.log 2>/dev/null || true
  exit 1
fi

# Pull the vision model (default qwen2.5vl:7b — vision-capable, ~4.7GB)
MODEL="${OLLAMA_MODEL:-qwen2.5vl:7b}"
echo "[ollama-setup] Pulling model: $MODEL"
echo "[ollama-setup] This will download ~4.7GB — please wait..."
ollama pull "$MODEL"

echo "[ollama-setup] ✅ Model '$MODEL' pulled successfully"

# Verify the model is available
echo "[ollama-setup] Available models:"
ollama list

# Quick test — send a simple prompt to verify the model works
echo "[ollama-setup] Testing model with a simple prompt..."
TEST_RESULT=$(curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say 'OK' if you can read this.\"}],
    \"max_tokens\": 10
  }" 2>/dev/null || echo '{"error":"test failed"}')

if echo "$TEST_RESULT" | grep -q "OK"; then
  echo "[ollama-setup] ✅ Model responds correctly — bot will auto-detect within 30s"
else
  echo "[ollama-setup] ⚠️ Model test returned unexpected result (non-fatal):"
  echo "$TEST_RESULT" | head -5
fi

echo "[ollama-setup] Ollama setup complete"
echo "[ollama-setup] Server: http://localhost:11434"
echo "[ollama-setup] OpenAI-compatible endpoint: http://localhost:11434/v1/chat/completions"
echo "[ollama-setup] Model: $MODEL"
