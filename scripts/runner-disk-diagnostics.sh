#!/usr/bin/env bash
# Reports only aggregate sizes and filesystem capacity, never file contents.
# Read-only, best-effort diagnostics; failures must not change bot behavior.
set -u
report() {
  printf '\n[runner-disk] UTC %s\n' "$(date -u +%FT%TZ)"
  df -h / /tmp 2>/dev/null || true
  df -i / /tmp 2>/dev/null || true
  for entry in 'bot-logs:/tmp/mathu-logs' 'browser-data:/tmp/.browser-data' 'npm-cache:/home/runner/.npm' 'playwright:/home/runner/.cache/ms-playwright' 'ollama-service-models:/usr/share/ollama/.ollama/models' 'ollama-user-models:/home/runner/.ollama/models' 'workspace:'"${GITHUB_WORKSPACE:-/home/runner/work/Automa-bot/Automa-bot}"; do
    label=${entry%%:*}; location=${entry#*:}
    if [ -e "$location" ]; then
      size=$(du -shx -- "$location" 2>/dev/null | cut -f1) || size=unknown
      printf '[runner-disk] %s %s\n' "$label" "${size:-unknown}"
    else
      printf '[runner-disk] %s unavailable\n' "$label"
    fi
  done
}
if [ "${1:-}" = '--once' ]; then report; exit 0; fi
while :; do
  report
  sleep 300 >/dev/null 2>&1
done
