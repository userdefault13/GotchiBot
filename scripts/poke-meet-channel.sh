#!/usr/bin/env bash
# Wake meet-channel-pane after transcript updates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.meet-channel.stamp" 2>/dev/null || true

if command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'meet-channel-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done
fi

if [ -n "${TMUX:-}" ]; then
  sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  pid="$(tmux display -p -t "${sess}:work.2" '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "${pid:-}" ]; then
    kill -USR1 "$pid" 2>/dev/null || true
  fi
fi
