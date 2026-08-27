#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
min_right="${GOTCHIBOT_TMUX_RIGHT_WIDTH:-45}"
min_avatar="${GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH:-39}"
min_left="${GOTCHIBOT_TMUX_LEFT_WIDTH:-30}"
sidebar_collapsed="${GOTCHIBOT_SIDEBAR_COLLAPSED:-3}"
chat_collapsed="${GOTCHIBOT_CHAT_COLLAPSED:-3}"
min_center="${GOTCHIBOT_TMUX_CENTER_WIDTH:-50}"
win_w_default="${GOTCHIBOT_WINDOW_WIDTH:-143}"
win_h_default="${GOTCHIBOT_WINDOW_HEIGHT:-40}"
resize_hook="$ROOT/scripts/orchestrator-resize.sh"
status_bar="$ROOT/scripts/session-status-bar.sh"
LAYOUT_FILE="$ROOT/sessions/.tmux-layout"
LAYOUT_MODE="$ROOT/sessions/.layout-mode"

layout_mode() {
  if [ -f "$LAYOUT_MODE" ]; then
    tr -d '[:space:]' < "$LAYOUT_MODE"
  else
    echo normal
  fi
}

set_layout_mode() {
  mkdir -p "$ROOT/sessions"
  printf '%s\n' "$1" > "$LAYOUT_MODE"
}

# Panes: 0 sidebar | 1 opencode chat | 2 avatar (sessions → tmux status bar)
layout_ready() {
  [ "$(tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' ')" -eq 3 ]
}

require_three_panes() {
  layout_ready && return 0
  rebuild_panes || return 1
  layout_ready || {
    echo "orchestrator layout failed: need 3 panes (sidebar | chat | avatar)" >&2
    return 1
  }
}

pane_start_cmd() {
  tmux display -p -t "$sess:work.$1" '#{pane_start_command}' 2>/dev/null || echo ""
}

layout_correct() {
  layout_ready || return 1
  local c0 c1 c2
  c0="$(pane_start_cmd 0)"
  c1="$(pane_start_cmd 1)"
  c2="$(pane_start_cmd 2)"
  [[ "$c0" == *sidebar-pane* ]] && [[ "$c1" == *chat-pane* ]] && [[ "$c2" == *avatar-pane* ]]
}

rebuild_panes() {
  local need=$((sidebar_collapsed + min_center + min_right + 2))
  tmux resize-window -t "$sess:work" -x "$win_w_default" -y "$win_h_default" 2>/dev/null || true
  tmux select-pane -t "$sess:work.0" 2>/dev/null || true
  tmux kill-pane -a -t "$sess:work.0" 2>/dev/null || true
  # work.0 = chat (center) → split avatar right, then sidebar left
  tmux split-window -h -t "$sess:work.0" -l "$min_right"
  tmux select-pane -t "$sess:work.0"
  tmux split-window -h -b -t "$sess:work.0" -l "$sidebar_collapsed"
  layout_ready || { echo "orchestrator layout failed (window too small? need ${need} cols)" >&2; return 1; }
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
  if layout_correct; then
    return 0
  fi
  require_three_panes
}

start_pane_commands() {
  require_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.0" C-c Enter "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" Enter
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-pane.sh" 2>/dev/null || \
    tmux send-keys -t "$sess:work.1" C-c Enter "cd \"$ROOT\" && exec ./scripts/chat-pane.sh" Enter
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.2" C-c Enter "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" Enter
}

collapse_sidebar() {
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
}

expand_sidebar() {
  # Medium explorer (~min_left); not full-bleed. Use files-max for 100%.
  if [ "$(layout_mode)" = "files-max" ]; then
    restore_normal_layout
  fi
  tmux resize-pane -t "$sess:work.0" -x "$min_left" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/mc-pane.sh"
  set_layout_mode normal
}

# Files take remaining width; chat collapses to a thin Gotchi bar; avatar stays.
enter_files_max() {
  layout_ready || return 1
  if [ "$(layout_mode)" = "avatar-max" ]; then
    # Leave avatar-max without restoring chat yet — we collapse chat again below.
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  local win_w files_w
  win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo "$win_w_default")"
  files_w=$((win_w - chat_collapsed - min_avatar - 2))
  [ "$files_w" -lt 20 ] && files_w=20

  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/mc-pane.sh"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  # Size order matters: grow files, then lock chat bar + avatar so tmux doesn't steal.
  tmux resize-pane -t "$sess:work.0" -x "$files_w" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  set_layout_mode files-max
  tmux select-pane -t "$sess:work.0"
  save_layout
}

# Avatar takes remaining width; chat → bar; files stay collapsed.
enter_avatar_max() {
  layout_ready || return 1
  if [ "$(layout_mode)" = "files-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  local win_w avatar_w
  win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo "$win_w_default")"
  avatar_w=$((win_w - sidebar_collapsed - chat_collapsed - 2))
  [ "$avatar_w" -lt 40 ] && avatar_w=40

  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  collapse_sidebar
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  tmux resize-pane -t "$sess:work.2" -x "$avatar_w" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  set_layout_mode avatar-max
  tmux select-pane -t "$sess:work.2"
  save_layout
  signal_panes
}

restore_normal_layout() {
  layout_ready || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-pane.sh"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  set_layout_mode normal
  tmux select-pane -t "$sess:work.1"
  save_layout
  signal_panes
}

toggle_files_max() {
  if [ "$(layout_mode)" = "files-max" ]; then
    restore_normal_layout
  else
    enter_files_max
  fi
}

toggle_avatar_max() {
  if [ "$(layout_mode)" = "avatar-max" ]; then
    restore_normal_layout
  else
    enter_avatar_max
  fi
}

toggle_sidebar() {
  local pw
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ]; then
    restore_normal_layout
    return
  fi
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
  if [ "$(layout_mode)" = "files-max" ]; then
    local win_w files_w
    win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo "$win_w_default")"
    files_w=$((win_w - chat_collapsed - min_avatar - 2))
    [ "$files_w" -lt 20 ] && files_w=20
    tmux resize-pane -t "$sess:work.0" -x "$files_w" 2>/dev/null || true
    tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
    tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
    return 0
  fi
  if [ "$(layout_mode)" = "avatar-max" ]; then
    local win_w avatar_w
    win_w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo "$win_w_default")"
    avatar_w=$((win_w - sidebar_collapsed - chat_collapsed - 2))
    [ "$avatar_w" -lt 40 ] && avatar_w=40
    tmux resize-pane -t "$sess:work.2" -x "$avatar_w" 2>/dev/null || true
    tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
    tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
    return 0
  fi
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

install_agent_keys() {
  [ "${GOTCHIBOT_TAB_TMUX:-1}" = "1" ] || return 0
  local hook="$ROOT/scripts/tmux-chat-focus-hook.sh"
  local layout="$ROOT/scripts/orchestrator-layout.sh"
  chmod +x "$hook" "$layout" "$ROOT/scripts/chat-bar-pane.sh" 2>/dev/null || true
  # Tab in the chat pane cycles gotchi → plan → build → ask (respawns OpenCode with persisted agent).
  tmux bind-key -T gotchi-chat Tab run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --restart" 2>/dev/null || true
  tmux bind-key -T gotchi-chat S-Tab run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --reverse --restart" 2>/dev/null || true
  tmux bind-key -T gotchi-chat F2 run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --restart" 2>/dev/null || true
  # Files full-bleed ↔ chat bar — Mac: Ctrl-b f · chat: fn-F4
  tmux bind-key -T gotchi-chat F4 run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' files-max" 2>/dev/null || true
  tmux bind-key f run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' files-max" 2>/dev/null || true
  tmux bind-key -T prefix C-f run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' files-max" 2>/dev/null || true
  tmux unbind-key -T root M-e 2>/dev/null || true
  tmux bind-key -T root M-f run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' files-max" 2>/dev/null || true
  # Avatar full-bleed ↔ chat bar — Mac: Ctrl-b a · chat: fn-F6
  tmux bind-key -T gotchi-chat F6 run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' avatar-max" 2>/dev/null || true
  tmux bind-key a run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' avatar-max" 2>/dev/null || true
  tmux bind-key -T prefix C-a run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' avatar-max" 2>/dev/null || true
  tmux bind-key -T root M-a run-shell "cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout' avatar-max" 2>/dev/null || true
  tmux set-hook -t "$sess" pane-focus-in "run-shell '$hook'" 2>/dev/null || true
  "$hook" 2>/dev/null || true
}

install_ui_theme() {
  # tmux mouse stays off so OpenCode owns the wheel (history scroll). Shift+drag still copies.
  # Pane resize / tmux scrollback: GOTCHIBOT_TMUX_MOUSE=1
  if [ "${GOTCHIBOT_TMUX_MOUSE:-0}" = "1" ]; then
    tmux set-option -g mouse on 2>/dev/null || true
    tmux set-option -t "$sess" mouse on 2>/dev/null || true
  else
    tmux set-option -t "$sess" mouse off 2>/dev/null || true
    tmux set-option -t "$sess" set-clipboard on 2>/dev/null || true
  fi
  install_agent_keys
  tmux set-option -t "$sess" pane-border-lines heavy 2>/dev/null || true
  tmux set-option -t "$sess" pane-border-style 'fg=colour238' 2>/dev/null || true
  tmux set-option -t "$sess" pane-active-border-style 'fg=colour39' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  tmux set-option -t "$sess" status-style 'bg=colour24,fg=colour252' 2>/dev/null || true
  tmux set-option -t "$sess" status-left-length 14 2>/dev/null || true
  tmux set-option -t "$sess" status-right-length 400 2>/dev/null || true
  tmux set-option -t "$sess" status-interval 30 2>/dev/null || true
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
  set_layout_mode normal
  fit_window
  signal_panes
  # Always boot with Files collapsed to a bar.
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
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
      require_three_panes || exit 1
      start_pane_commands
      finish_ensure
    elif ! layout_correct; then
      disable_resize_hook
      rm -f "$LAYOUT_FILE"
      require_three_panes || exit 1
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
    if [ "$(layout_mode)" != "files-max" ] && [ "$(layout_mode)" != "avatar-max" ]; then
      tmux select-pane -t "$sess:work.1"
    fi
    ;;
  files-max|explorer)
    toggle_files_max
    ;;
  avatar-max|avatar)
    toggle_avatar_max
    ;;
  fit)
    fit_window
    install_ui_theme
    ;;
  *)
    echo "usage: orchestrator-layout.sh [ensure|refresh|refresh-soft|fit-quiet|sidebar|files-max|avatar-max|fit]" >&2
    exit 2
    ;;
esac
