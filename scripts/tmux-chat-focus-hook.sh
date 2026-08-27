#!/usr/bin/env bash
# Switch tmux key table when the OpenCode chat pane is focused (Tab → agent cycle).
set -euo pipefail

sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
idx="$(tmux display -p '#{pane_index}' 2>/dev/null || echo "")"
win="$(tmux display -p '#{window_index}' 2>/dev/null || echo "")"
name="$(tmux display -p '#{session_name}' 2>/dev/null || echo "")"

if [ "$name" = "$sess" ] && [ "$win" = "0" ] && [ "$idx" = "1" ]; then
  tmux switch-client -T gotchi-chat 2>/dev/null || true
else
  tmux switch-client -T root 2>/dev/null || true
fi
