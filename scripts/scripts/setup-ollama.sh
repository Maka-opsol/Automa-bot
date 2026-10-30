#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Ollama Setup Script — installs Ollama + pulls a code-focused LLM
# ═══════════════════════════════════════════════════════════════════════
#
# This script is called by the GitHub Actions workflow to:
#   1. Install Ollama (local LLM server)
#   2. Pull a code-focused model for self-heal auditing
#   3. Start the Ollama server in the background
#
# The bot's self-heal auditor then calls http://localhost:11434/v1/chat/completions
# to review code patches locally — no API calls, no rate limits, fully autonomous.
#
# MODEL: qwen2.5-coder:7b
#   - 7B parameters, 4-bit quantized
#   - ~4GB RAM when loaded
#   - Excellent at code review (trained on code)
#   - OpenAI-compatible API via Ollama
#
# MEMORY BUDGET:
#   Ollama server:     ~50MB
#   Model (loaded):    ~4GB (when active)
#   Total:             ~4GB — fits in 16GB with 12GB to spare
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "[ollama-setup] Installing Ollama..."

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

echo "[ollama-setup] Starting Ollama server..."
# Start Ollama in the background
nohup ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!
echo "[ollama-setup] Ollama server started (PID $OLLAMA_PID)"

# Wait for Ollama to be ready
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

# Pull the code-focused model
MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
echo "[ollama-setup] Pulling model: $MODEL"
echo "[ollama-setup] This will download ~4GB — please wait..."
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
  echo "[ollama-setup] ✅ Model responds correctly — self-heal auditor ready"
else
  echo "[ollama-setup] ⚠️ Model test returned unexpected result (non-fatal):"
  echo "$TEST_RESULT" | head -5
fi

echo "[ollama-setup] Ollama setup complete"
echo "[ollama-setup] Server: http://localhost:11434"
echo "[ollama-setup] OpenAI-compatible endpoint: http://localhost:11434/v1/chat/completions"
echo "[ollama-setup] Model: $MODEL"
