#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/sessions"
date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/sessions/.meet-room.stamp" 2>/dev/null || true
if command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'meet-room-prompter.mjs' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done || true
  pgrep -f 'meet-room-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done || true
fi
exit 0
