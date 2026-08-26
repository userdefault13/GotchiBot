#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

debounced_winch() {
  local now
  now=$(date +%s)
  if [ "$((now - ${last_winch:-0}))" -lt 1 ]; then
    return
  fi
  last_winch=$now
  kill -WINCH $$ 2>/dev/null || true
}

trap debounced_winch WINCH
exec mc .
