#!/usr/bin/env bash
# Rebuild the avatar roster from live sessions and wake the pane.
# Called after spawn / focus / session status changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"

node "$ROOT/scripts/avatar-roster.mjs" --json >/dev/null 2>&1 || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true

# USR1 the avatar watch pane (tmux layout: gotchibot:work.2)
if [ -n "${TMUX:-}" ]; then
  sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  pid="$(tmux display -p -t "${sess}:work.2" '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "${pid:-}" ]; then
    kill -USR1 "$pid" 2>/dev/null || true
  fi
fi

# Any avatar-pane.sh watch, even outside this tmux client
if command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'scripts/avatar-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done
fi
