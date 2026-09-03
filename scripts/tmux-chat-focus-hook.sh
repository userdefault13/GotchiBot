#!/usr/bin/env bash
# Switch tmux key table by focused pane (layout hotkeys + Tab agent cycle in chat).
# Identify panes by flags — never pane_index (meet-gallery reuses work.1).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess="${sess#=}"
name="$(tmux display -p "#{session_name}" 2>/dev/null || echo "")"
win="$(tmux display -p "#{window_name}" 2>/dev/null || echo "")"
chat="$(tmux display -p "#{@gotchibot-chat}" 2>/dev/null || echo "")"
meet="$(tmux display -p "#{@gotchibot-meet-room}" 2>/dev/null || echo "")"
channel="$(tmux display -p "#{@gotchibot-meet-channel}" 2>/dev/null || echo "")"
avatar="$(tmux display -p "#{@gotchibot-avatar}" 2>/dev/null || echo "")"
idx="$(tmux display -p "#{pane_index}" 2>/dev/null || echo "")"
mode="$(tr -d "[:space:]" < "$ROOT/sessions/.layout-mode" 2>/dev/null || echo normal)"

if [ "$name" != "$sess" ] || [ "$win" != "work" ]; then
  tmux switch-client -T root 2>/dev/null || true
  exit 0
fi

# Meet room / channel must stay on root so Tab reaches the process (@mentions, etc).
if [ "$meet" = "1" ] || [ "$channel" = "1" ]; then
  tmux switch-client -T root 2>/dev/null || true
  exit 0
fi

if [ "$chat" = "1" ]; then
  tmux switch-client -T gotchi-chat 2>/dev/null || true
  exit 0
fi

if [ "$avatar" = "1" ]; then
  tmux switch-client -T gotchi-avatar 2>/dev/null || true
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
