#!/usr/bin/env bash
# Rebuild the avatar roster from live sessions and wake the pane.
# Called after spawn / focus / session status changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"

node "$ROOT/scripts/avatar-roster.mjs" --json >/dev/null 2>&1 || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true

sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
if tmux has-session -t "$sess" 2>/dev/null; then
  # Desk avatar is work.2; meet gallery uses work.2 as # meet — USR1 is still fine.
  pid="$(tmux display -p -t "${sess}:work.2" '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "${pid:-}" ]; then
    kill -USR1 "$pid" 2>/dev/null || true
  fi
fi

if command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'scripts/avatar-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done || true
fi
exit 0
