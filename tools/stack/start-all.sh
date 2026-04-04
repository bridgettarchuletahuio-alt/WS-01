#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/stack.pids"
UI_LOG="$RUNTIME_DIR/visual-ui.log"
DECODE_LOG="$RUNTIME_DIR/ws-decode.log"

mkdir -p "$RUNTIME_DIR"

cleanup_old() {
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
}

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

wait_http() {
  local url="$1"
  local label="$2"
  local timeout_sec="${3:-25}"

  local i=0
  while (( i < timeout_sec )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[ok] $label is ready: $url"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done

  echo "[warn] $label not ready after ${timeout_sec}s: $url"
  return 1
}

start_decode_service() {
  (
    cd "$ROOT_DIR/tools/ws-decode-service"
    nohup node server.js >"$DECODE_LOG" 2>&1 &
    echo $! >> "$PID_FILE"
  )
}

start_visual_ui() {
  (
    cd "$ROOT_DIR"
    nohup node ./tools/visual-ui/server.js >"$UI_LOG" 2>&1 &
    echo $! >> "$PID_FILE"
  )
}

open_ui() {
  local ui_url="http://127.0.0.1:3399"
  if [[ -n "${BROWSER:-}" ]]; then
    "$BROWSER" "$ui_url" >/dev/null 2>&1 || true
  fi
}

cleanup_old
: > "$PID_FILE"

start_decode_service
start_visual_ui

wait_http "http://127.0.0.1:3000/health" "decode-service"
wait_http "http://127.0.0.1:3399/api/state" "visual-ui"
open_ui

echo
echo "stack started"
echo "visual-ui: http://127.0.0.1:3399"
echo "decode-service: http://127.0.0.1:3000/health"
echo "logs:"
echo "  $UI_LOG"
echo "  $DECODE_LOG"
