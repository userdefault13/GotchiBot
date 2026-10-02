#!/usr/bin/env bash
# Publish the active gotchi + workflow, refresh every pane border, wake watchers.
# Called after spawn / focus / session status changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"

node "$ROOT/scripts/desk-active.mjs" publish --force >/dev/null 2>&1 || true
node "$ROOT/scripts/avatar-roster.mjs" --json >/dev/null 2>&1 || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true

sess_name="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess_name="${sess_name#=}"
sess="$sess_name"

signal_matching() {
  local pat="$1" pid cmd
  if tmux has-session -t "=$sess_name" 2>/dev/null; then
    while read -r pid cmd; do
      [[ "$cmd" == *"$pat"* ]] || continue
      [ -n "${pid:-}" ] && kill -USR1 "$pid" 2>/dev/null || true
    done < <(tmux list-panes -t "$sess:work" -F '#{pane_pid} #{pane_start_command}' 2>/dev/null || true)
  fi
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$pat" 2>/dev/null | while read -r p; do
      kill -USR1 "$p" 2>/dev/null || true
    done || true
  fi
}

signal_matching "scripts/avatar-pane.sh"
signal_matching "scripts/factory-window.mjs"
signal_matching "scripts/pstack-window.mjs"
signal_matching "scripts/label-bar-pane.sh"
signal_matching "scripts/chat-bar-pane.sh"
signal_matching "scripts/sidebar-pane.sh"
signal_matching "scripts/meet-room-prompter.mjs"
exit 0
