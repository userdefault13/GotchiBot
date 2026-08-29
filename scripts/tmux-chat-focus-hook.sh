#!/usr/bin/env bash
# Switch tmux key table by focused pane (layout hotkeys + Tab agent cycle in chat).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
idx="$(tmux display -p "#{pane_index}" 2>/dev/null || echo "")"
win="$(tmux display -p "#{window_index}" 2>/dev/null || echo "")"
name="$(tmux display -p "#{session_name}" 2>/dev/null || echo "")"
mode="$(tr -d "[:space:]" < "$ROOT/sessions/.layout-mode" 2>/dev/null || echo normal)"

if [ "$name" != "$sess" ] || [ "$win" != "0" ]; then
  tmux switch-client -T root 2>/dev/null || true
  exit 0
fi

case "$idx" in
  1)
    if [ "$mode" = "files-max" ] || [ "$mode" = "avatar-max" ]; then
      tmux switch-client -T gotchi-files 2>/dev/null || true
    else
      tmux switch-client -T gotchi-chat 2>/dev/null || true
    fi
    ;;
  0) tmux switch-client -T gotchi-files 2>/dev/null || true ;;
  2) tmux switch-client -T gotchi-avatar 2>/dev/null || true ;;
  *) tmux switch-client -T root 2>/dev/null || true ;;
esac
