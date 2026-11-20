#!/usr/bin/env bash
# Aggregate-only, best-effort runner disk diagnostics. Never print paths,
# contents, command stderr, environment variables, or arbitrary command output.
set -u
set -o pipefail

report() {
  printf '\n[runner-disk] UTC %s\n' "$(date -u +%FT%TZ 2>/dev/null || printf unknown)"
  local label location size values
  for label in root tmp; do
    case "$label" in root) location=/ ;; tmp) location=/tmp ;; esac
    # GNU df --output omits device and mount names; accept only numeric fields.
    values=$(timeout 10s df -k --output=size,used,avail,pcent -- "$location" 2>/dev/null | tail -n 1) || values=''
    if [[ "$values" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+%[[:space:]]*$ ]]; then
      printf '[runner-disk] %s blocks-kib total used available percent: %s\n' "$label" "$values"
    else
      printf '[runner-disk] %s blocks unavailable\n' "$label"
    fi
    values=$(timeout 10s df --output=itotal,iused,iavail,ipcent -- "$location" 2>/dev/null | tail -n 1) || values=''
    if [[ "$values" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+%[[:space:]]*$ ]]; then
      printf '[runner-disk] %s inodes total used available percent: %s\n' "$label" "$values"
    else
      printf '[runner-disk] %s inodes unavailable\n' "$label"
    fi
  done
  for label in bot-logs browser-data npm-cache playwright ollama-service-models ollama-user-models workspace; do
    case "$label" in
      bot-logs) location=/tmp/mathu-logs ;;
      browser-data) location=/tmp/.browser-data ;;
      npm-cache) location=/home/runner/.npm ;;
      playwright) location=/home/runner/.cache/ms-playwright ;;
      ollama-service-models) location=/usr/share/ollama/.ollama/models ;;
      ollama-user-models) location=/home/runner/.ollama/models ;;
      workspace) location=${GITHUB_WORKSPACE:-/home/runner/work/Automa-bot/Automa-bot} ;;
    esac
    if [[ -e "$location" ]]; then
      size=$(timeout 10s du -skx -- "$location" 2>/dev/null | cut -f1) || size=''
      if [[ "$size" =~ ^[0-9]+$ ]]; then
        printf '[runner-disk] %s kib %s\n' "$label" "$size"
      else
        printf '[runner-disk] %s unavailable\n' "$label"
      fi
    else
      printf '[runner-disk] %s unavailable\n' "$label"
    fi
  done
}

if [[ "${1:---once}" == --once ]]; then report; exit 0; fi
if [[ "${1:-}" != --monitor ]]; then exit 0; fi
child=''
trap '[[ -z "$child" ]] || kill "$child" 2>/dev/null || :; exit 0' TERM INT
while :; do
  report || :
  sleep 300 & child=$!
  wait "$child" 2>/dev/null || :
  child=''
done
