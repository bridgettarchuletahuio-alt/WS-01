#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$ROOT_DIR/.runtime/stack.pids"

free_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs -r kill >/dev/null 2>&1 || true
      sleep 1
      pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      if [[ -n "$pids" ]]; then
        echo "$pids" | xargs -r kill -9 >/dev/null 2>&1 || true
      fi
    fi
  fi
}

if [[ -f "$PID_FILE" ]]; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

pkill -f "node ./tools/visual-ui/server.js" >/dev/null 2>&1 || true
pkill -f "tools/ws-decode-service/server.js" >/dev/null 2>&1 || true

free_port 3399
free_port 3000

echo "stack stopped"
