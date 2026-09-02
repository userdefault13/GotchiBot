#!/usr/bin/env bash
# Avatar pane xterm-256 profile — collateral art via gotchi-art.mjs.
# OpenCode chat chrome uses .opencode/themes/gotchi.json (256 indices).
# Do not source from chat-pane.sh (OpenCode owns that pane's colors).
export GOTCHIBOT_TRUECOLOR=0
if [ -n "${TMUX:-}" ]; then
  unset COLORTERM
fi
