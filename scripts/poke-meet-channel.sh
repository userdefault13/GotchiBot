#!/usr/bin/env bash
# Wake meet-channel-pane after transcript updates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.meet-channel.stamp" 2>/dev/null || true

if command -v pgrep >/dev/null 2>&1; then
  # Empty pgrep must not fail the script under set -e (pipeline / pipefail).
  pgrep -f 'meet-channel-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done || true
fi

# Signal the channel pane by what it runs, never by slot: on the 9-pane desk
# work.2 is the cockpit, and USR1 with no trap kills it.
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess="${sess#=}"
if tmux has-session -t "=$sess" 2>/dev/null; then
  tmux list-panes -t "$sess:work" -F '#{pane_pid} #{pane_start_command}' 2>/dev/null | \
    while read -r pid cmd; do
      [[ "$cmd" == *meet-channel-pane* ]] || continue
      kill -USR1 "$pid" 2>/dev/null || true
    done || true
fi
exit 0
