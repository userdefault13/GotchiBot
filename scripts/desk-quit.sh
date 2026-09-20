#!/usr/bin/env bash
# One Ctrl+C → kill the GotchiBot desk tmux session and return to the parent shell.
# Bound from orchestrator-layout.sh (install_agent_keys). Session-scoped via if-shell.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess="${sess#=}"

# Only kill the desk session — never touch other tmux sessions on this server.
if ! tmux has-session -t "=$sess" 2>/dev/null; then
  exit 0
fi

# Best-effort: stop pane children cleanly before the session vanishes.
tmux list-panes -t "=$sess" -F '#{pane_pid}' 2>/dev/null | while read -r pid; do
  [ -n "$pid" ] || continue
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 0.05

tmux kill-session -t "=$sess" 2>/dev/null || tmux kill-session -t "$sess" 2>/dev/null || true
