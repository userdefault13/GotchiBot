#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
min_right="${GOTCHIBOT_TMUX_RIGHT_WIDTH:-45}"
min_avatar="${GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH:-39}"
min_left="${GOTCHIBOT_TMUX_LEFT_WIDTH:-30}"
sidebar_collapsed="${GOTCHIBOT_SIDEBAR_COLLAPSED:-3}"
min_center="${GOTCHIBOT_TMUX_CENTER_WIDTH:-50}"
win_w_default="${GOTCHIBOT_WINDOW_WIDTH:-143}"
win_h_default="${GOTCHIBOT_WINDOW_HEIGHT:-40}"
resize_hook="$ROOT/scripts/orchestrator-resize.sh"
status_bar="$ROOT/scripts/session-status-bar.sh"
LAYOUT_FILE="$ROOT/sessions/.tmux-layout"

# Panes: 0 sidebar | 1 opencode chat | 2 avatar (sessions → tmux status bar)
layout_ready() {
  [ "$(tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' ')" -eq 3 ]
}

save_layout() {
  layout_ready || return 0
  tmux list-windows -t "$sess:work" -F '#{window_layout}' 2>/dev/null | head -1 > "$LAYOUT_FILE"
}

apply_window_policy() {
  tmux set-option -t "$sess" window-size manual 2>/dev/null || true
  tmux set-option -t "$sess" aggressive-resize off 2>/dev/null || true
}

ensure_panes() {
  tmux has-session -t "$sess" 2>/dev/null || return 1
  apply_window_policy
  if layout_ready; then
    return 0
  fi
  local need=$((sidebar_collapsed + min_center + min_right + 2))
  tmux resize-window -t "$sess" -x "$win_w_default" -y "$win_h_default" 2>/dev/null || true
  tmux select-pane -t "$sess:work.0"
  tmux kill-pane -a -t "$sess:work.0" 2>/dev/null || true
  tmux split-window -h -l "$min_right" -t "$sess:work.0"
  tmux split-window -hb -l "$sidebar_collapsed" -t "$sess:work.0"
  layout_ready || { echo "orchestrator layout failed (window too small?)" >&2; return 1; }
}

start_pane_commands() {
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-pane.sh"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
}

collapse_sidebar() {
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
}

expand_sidebar() {
  tmux resize-pane -t "$sess:work.0" -x "$min_left" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/mc-pane.sh"
}

toggle_sidebar() {
  local pw
  pw="$(tmux display -p -t "$sess:work.0" '#{pane_width}' 2>/dev/null || echo 0)"
  if [ "$pw" -lt 12 ]; then
    expand_sidebar
  else
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
    collapse_sidebar
  fi
  save_layout
}

enforce_sizes() {
  local win_w need pw
  win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo 0)"
  pw="$(tmux display -p -t "$sess:work.0" '#{pane_width}' 2>/dev/null || echo "$sidebar_collapsed")"
  if [ "$pw" -lt 12 ]; then
    need=$((sidebar_collapsed + min_center + min_right + 2))
  else
    need=$((min_left + min_center + min_right + 2))
  fi
  if [ "$win_w" -gt 0 ] && [ "$win_w" -lt "$need" ]; then
    tmux resize-window -t "$sess" -x "$need" 2>/dev/null || true
  fi
}

fit_quiet() {
  apply_pane_sizes
  enforce_sizes
}

fit_window() {
  tmux resize-window -t "$sess" -x "$win_w_default" -y "$win_h_default" 2>/dev/null || true
  fit_quiet
  if should_signal_avatar; then signal_panes; fi
}

apply_pane_sizes() {
  local win_w aw need_w
  layout_ready || return 0
  win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo 0)"
  need_w="$min_right"
  [ "$need_w" -lt "$min_avatar" ] && need_w="$min_avatar"
  tmux resize-pane -t "$sess:work.2" -x "$need_w" 2>/dev/null || true
  aw="$(tmux display -p -t "$sess:work.2" '#{pane_width}' 2>/dev/null || echo 0)"
  if [ "$aw" -lt "$min_avatar" ] && [ "$win_w" -gt 0 ]; then
    tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
    local chat_w=$((win_w - sidebar_collapsed - min_avatar - 2))
    [ "$chat_w" -gt 20 ] && tmux resize-pane -t "$sess:work.1" -x "$chat_w" 2>/dev/null || true
  fi
}

signal_panes() {
  local pane pid
  pane="$sess:work.2"; pid="$(tmux display -p -t "$pane" '#{pane_pid}' 2>/dev/null || echo '')"
  [ -n "$pid" ] && kill -USR1 "$pid" 2>/dev/null || true
}

should_signal_avatar() {
  [ "${GOTCHIBOT_SIGNAL_AVATAR_ON_FIT:-0}" = 1 ]
}

install_ui_theme() {
  tmux set-option -t "$sess" pane-border-lines heavy 2>/dev/null || true
  tmux set-option -t "$sess" pane-border-style 'fg=colour238' 2>/dev/null || true
  tmux set-option -t "$sess" pane-active-border-style 'fg=colour39' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' OpenCode ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  tmux set-option -t "$sess" status-style 'bg=colour24,fg=colour252' 2>/dev/null || true
  tmux set-option -t "$sess" status-left-length 14 2>/dev/null || true
  tmux set-option -t "$sess" status-right-length 400 2>/dev/null || true
  tmux set-option -t "$sess" status-interval 60 2>/dev/null || true
  tmux set-option -t "$sess" status-left '#[fg=white,bold] GotchiBot ' 2>/dev/null || true
  tmux set-option -t "$sess" status-right "#[fg=colour252]#($status_bar) #[fg=colour238]|#[default] #[fg=colour250]#S " 2>/dev/null || true
  apply_window_policy
}

install_resize_hook() {
  [ "${GOTCHIBOT_RESIZE_HOOK:-0}" = 1 ] || return 0
  tmux set-hook -t "$sess" client-resized "run-shell '$resize_hook'"
}

disable_resize_hook() {
  tmux set-hook -t "$sess" client-resized "" 2>/dev/null || true
}

finish_ensure() {
  fit_window
  signal_panes
  collapse_sidebar
  save_layout
  install_ui_theme
  install_resize_hook
  tmux select-pane -t "$sess:work.1"
}

cmd="${1:-ensure}"
case "$cmd" in
  ensure)
    disable_resize_hook
    rm -f "$LAYOUT_FILE"
    apply_window_policy
    ensure_panes
    start_pane_commands
    finish_ensure
    ;;
  refresh-soft)
    if ! layout_ready; then
      disable_resize_hook
      rm -f "$LAYOUT_FILE"
      ensure_panes
      start_pane_commands
      finish_ensure
    else
      fit_quiet
    fi
    ;;
  fit-quiet)
    fit_quiet
    ;;
  refresh)
    disable_resize_hook
    rm -f "$LAYOUT_FILE"
    ensure_panes
    start_pane_commands
    finish_ensure
    ;;
  sidebar)
    toggle_sidebar
    tmux select-pane -t "$sess:work.1"
    ;;
  fit)
    fit_window
    install_ui_theme
    ;;
  *)
    echo "usage: orchestrator-layout.sh [ensure|refresh|refresh-soft|fit-quiet|sidebar|fit]" >&2
    exit 2
    ;;
esac
