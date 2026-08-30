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
  tmux resize-pane -Z -t "$sess:work" 2>/dev/null || true
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

# Mark the avatar pane so wheel binds survive pane-index drift.
# work.2 is the current avatar index; @gotchibot-avatar is the stable mark.
mark_avatar_pane() {
  # Pane-only. Unset window/global so cockpit/files/chat never inherit the flag.
  tmux set-option -gu @gotchibot-avatar 2>/dev/null || true
  tmux set-option -u -w -t "$sess:work" @gotchibot-avatar 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" @gotchibot-avatar 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" history-limit 0 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-scrollbars off 2>/dev/null || true
}

# Mouse on for prev/next clicks. Wheel on the avatar pane is ignored.
# Chat/files/cockpit keep default (OpenCode mouse / send-keys -M).
# NEVER send-keys -t #{pane_id} — that format is empty and errors in the status bar.
# Match avatar ONLY via @gotchibot-avatar=1 (never pane_index).
install_avatar_mouse() {
  local av_if='#{==:#{@gotchibot-avatar},1}'
  local click="$ROOT/scripts/avatar-pane.sh sb-click #{mouse_x} #{mouse_y} #{pane_pid}"
  local def_wheel='if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -e"'
  local def_drag='if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'

  tmux set-option -g mouse on 2>/dev/null || true
  tmux set-option -t "$sess" mouse on 2>/dev/null || true
  mark_avatar_pane

  tmux unbind-key -n WheelUpPane 2>/dev/null || true
  tmux unbind-key -n WheelDownPane 2>/dev/null || true
  tmux unbind-key -n MouseDown1Pane 2>/dev/null || true
  tmux unbind-key -n MouseDrag1Pane 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar WheelUp 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar WheelDown 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar WheelUpPane 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar WheelDownPane 2>/dev/null || true

  # Avatar: ignore wheel (no sb-wheel, no send-keys). Else OpenCode/default.
  # Invert so the avatar branch has no command at all (empty if-shell is invalid).
  tmux bind-key -n WheelUpPane \
    if-shell -F "#{!=:#{@gotchibot-avatar},1}" "$def_wheel" 2>/dev/null || true
  tmux bind-key -n WheelDownPane \
    if-shell -F "#{!=:#{@gotchibot-avatar},1}" "$def_wheel" 2>/dev/null || true

  # Click prev/next hitboxes. Never copy-mode the avatar pane.
  tmux bind-key -n MouseDown1Pane \
    if-shell -F "$av_if" "run-shell '$click'" \
    'select-pane -t = ; send-keys -M' 2>/dev/null || true
  tmux bind-key -n MouseDrag1Pane \
    if-shell -F "#{!=:#{@gotchibot-avatar},1}" "$def_drag" 2>/dev/null || true
}

start_pane_commands() {
  require_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.0" C-c Enter "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" Enter
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-pane.sh" 2>/dev/null || \
    tmux send-keys -t "$sess:work.1" C-c Enter "cd \"$ROOT\" && exec ./scripts/chat-pane.sh" Enter
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.2" C-c Enter "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" Enter
  mark_avatar_pane
}

window_width() {
  local w
  w="$(tmux display -p -t "$sess" '#{window_width}' 2>/dev/null || echo 0)"
  [ "$w" -gt 0 ] || w="$(tmux display -p '#{client_width}' 2>/dev/null || echo 0)"
  [ "$w" -gt 0 ] || w="$win_w_default"
  echo "$w"
}

# tmux kills the rightmost pane if pane 0 is grown with -x before neighbors are locked.
apply_files_max_sizes() {
  local win_w files_w pw0 delta
  win_w="$(window_width)"
  files_w=$((win_w - chat_collapsed - min_avatar - 2))
  [ "$files_w" -lt 20 ] && files_w=20
  tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
  pw0="$(tmux display -p -t "$sess:work.0" '#{pane_width}' 2>/dev/null || echo "$sidebar_collapsed")"
  delta=$((files_w - pw0))
  if [ "$delta" -gt 0 ]; then
    tmux resize-pane -t "$sess:work.0" -R "$delta" 2>/dev/null || true
  elif [ "$delta" -lt 0 ]; then
    tmux resize-pane -t "$sess:work.0" -L "$((0 - delta))" 2>/dev/null || true
  fi
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
}

apply_avatar_max_sizes() {
  local win_w avatar_w
  win_w="$(window_width)"
  avatar_w=$((win_w - sidebar_collapsed - chat_collapsed - 2))
  [ "$avatar_w" -lt 40 ] && avatar_w=40
  tmux resize-pane -t "$sess:work.2" -x "$avatar_w" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_collapsed" 2>/dev/null || true
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
  require_three_panes || return 1
  if [ "$(layout_mode)" = "avatar-max" ]; then
    # Leave avatar-max without restoring chat yet — we collapse chat again below.
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  # Widen the files column before mc starts — mc in a 3-col pane makes tmux drop neighbors.
  apply_files_max_sizes
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/mc-pane.sh"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  apply_files_max_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' Files · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  set_layout_mode files-max
  tmux select-pane -t "$sess:work.0"
  save_layout
  signal_panes
}

# Avatar takes remaining width; chat → bar; files stay collapsed.
enter_avatar_max() {
  require_three_panes || return 1
  if [ "$(layout_mode)" = "files-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  collapse_sidebar
  apply_avatar_max_sizes
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_avatar_max_sizes
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  set_layout_mode avatar-max
  tmux select-pane -t "$sess:work.2"
  save_layout
  signal_panes
}

enter_chat_max() {
  require_three_panes || return 1
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  fi
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_chat_max_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  set_layout_mode chat-max
  tmux select-pane -t "$sess:work.1"
  save_layout
  signal_panes
}

apply_chat_max_sizes() {
  collapse_sidebar
  local win_w chat_w
  win_w="$(window_width)"
  chat_w=$((win_w - sidebar_collapsed - min_avatar - 2))
  [ "$chat_w" -lt 20 ] && chat_w=20
  tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$chat_w" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
}


# Put the avatar pane back on the right without killing OpenCode chat.
# OpenCode's info sidebar is internal (not a tmux pane) and can hide work.2
# when chat goes wide; this splits avatar back out.
restore_avatar_pane() {
  local count
  count="$(tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${count:-0}" -lt 3 ]; then
    tmux split-window -h -t "$sess:work.1" -l "$min_avatar" "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" || {
      echo "could not split avatar pane (need a wider window)" >&2
      return 1
    }
  fi
  c2="$(pane_start_cmd 2)"
  if [[ "$c2" != *avatar-pane* ]]; then
    tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  fi
  mark_avatar_pane
  set_layout_mode normal
  tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_agent_keys 2>/dev/null || true
  [ -x "$ROOT/scripts/poke-avatar.sh" ] && "$ROOT/scripts/poke-avatar.sh" >/dev/null 2>&1 || true
}

toggle_chat_max() {
  if [ "$(layout_mode)" = "chat-max" ]; then
    restore_normal_layout
  else
    enter_chat_max
  fi
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
  if [ "$(layout_mode)" = "chat-max" ]; then
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
    apply_files_max_sizes
    return 0
  fi
  if [ "$(layout_mode)" = "avatar-max" ]; then
    apply_avatar_max_sizes
    return 0
  fi
  if [ "$(layout_mode)" = "chat-max" ]; then
    apply_chat_max_sizes
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

install_layout_keys() {
  local table="$1"
  tmux bind-key -T "$table" C-f run-shell "$layout_run enter-files-max" 2>/dev/null || true
  tmux bind-key -T "$table" C-a run-shell "$layout_run enter-avatar-max" 2>/dev/null || true
  tmux bind-key -T "$table" C-g run-shell "$layout_run show-avatar" 2>/dev/null || true
  tmux bind-key -T "$table" C-b run-shell "$layout_run enter-chat-max" 2>/dev/null || true
  tmux bind-key -T "$table" M-f run-shell "$layout_run enter-files-max" 2>/dev/null || true
  tmux bind-key -T "$table" M-a run-shell "$layout_run enter-avatar-max" 2>/dev/null || true
  tmux bind-key -T "$table" M-g run-shell "$layout_run show-avatar" 2>/dev/null || true
  tmux bind-key -T "$table" M-b run-shell "$layout_run enter-chat-max" 2>/dev/null || true
}

install_agent_keys() {
  [ "${GOTCHIBOT_TAB_TMUX:-1}" = "1" ] || return 0
  local hook="$ROOT/scripts/tmux-chat-focus-hook.sh"
  local layout="$ROOT/scripts/orchestrator-layout.sh"
  local layout_run="cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess' '$layout'"
  chmod +x "$hook" "$layout" "$ROOT/scripts/chat-bar-pane.sh" 2>/dev/null || true
  # Free Ctrl+b for chat-max in mc/files/avatar panes; tmux prefix → Ctrl+Space in this session.
  tmux set-option -t "$sess" prefix C-Space 2>/dev/null || true
  tmux bind-key -T prefix C-Space send-prefix 2>/dev/null || true
  # Tab in the chat pane cycles gotchi → plan → build → ask (respawns OpenCode with persisted agent).
  tmux bind-key -T gotchi-chat Tab run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --restart" 2>/dev/null || true
  tmux bind-key -T gotchi-chat S-Tab run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --reverse --restart" 2>/dev/null || true
  tmux bind-key -T gotchi-chat F2 run-shell "cd \"$ROOT\" && node \"$ROOT/scripts/agent-mode.mjs\" cycle --restart" 2>/dev/null || true
  # Layout — Ctrl+F files · Ctrl+A avatar-max · Ctrl+G show avatar · Ctrl+B chat
  # Fallback: Alt+F/A/G/B · F6 show avatar · F7 avatar-max · prefix: Ctrl+Space then f/a/b
  install_layout_keys root
  install_layout_keys gotchi-chat
  install_layout_keys gotchi-files
  install_layout_keys gotchi-avatar
  # Pagination clicks on avatar; wheel unbound there (orch face stays pinned).
  install_avatar_mouse
  # Orchestrator focus — F3 / prefix o / Option+O
  tmux bind-key -T gotchi-chat F3 run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T prefix o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T root M-o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  # Prefix / fn-key toggles (Ctrl+b f/a/b)
  tmux bind-key -T gotchi-chat F4 run-shell "$layout_run files-max" 2>/dev/null || true
  tmux bind-key f run-shell "$layout_run files-max" 2>/dev/null || true
  tmux bind-key -T prefix C-f run-shell "$layout_run files-max" 2>/dev/null || true
  tmux bind-key -T prefix f run-shell "$layout_run files-max" 2>/dev/null || true
  tmux bind-key -T gotchi-chat F6 run-shell "$layout_run show-avatar" 2>/dev/null || true
  tmux bind-key -T gotchi-chat F7 run-shell "$layout_run avatar-max" 2>/dev/null || true
  tmux bind-key a run-shell "$layout_run avatar-max" 2>/dev/null || true
  tmux bind-key -T prefix C-a run-shell "$layout_run avatar-max" 2>/dev/null || true
  tmux bind-key -T prefix a run-shell "$layout_run avatar-max" 2>/dev/null || true
  tmux bind-key -T gotchi-chat F5 run-shell "$layout_run enter-chat-max" 2>/dev/null || true
  tmux bind-key -T prefix b run-shell "$layout_run enter-chat-max" 2>/dev/null || true
  tmux set-hook -t "$sess" pane-focus-in "run-shell '$hook'" 2>/dev/null || true
  "$hook" 2>/dev/null || true
}

install_ui_theme() {
  # Mouse ON so prev/next on the unfocused avatar pane are clickable.
  # Wheel over avatar is a no-op (no copy-mode, no send-keys);
  # chat/files keep default (OpenCode / send-keys -M).
  tmux set-option -g mouse on 2>/dev/null || true
  tmux set-option -t "$sess" mouse on 2>/dev/null || true
  tmux set-option -t "$sess" set-clipboard on 2>/dev/null || true
  # Let OSC 52 from OpenClaw TUI (/copy) reach Terminal/iTerm pasteboard.
  tmux set-option -g allow-passthrough on 2>/dev/null || true
  tmux set-option -t "$sess" allow-passthrough on 2>/dev/null || true
  install_avatar_mouse
  # Truecolor for Gotchi message backgrounds (chalk bgHex needs Tc in tmux).
  tmux set-option -g terminal-overrides ",tmux-256color:Tc" 2>/dev/null || true
  tmux set-option -g terminal-overrides ",xterm-256color:Tc" 2>/dev/null || true
  install_agent_keys
  tmux set-option -t "$sess" pane-border-lines heavy 2>/dev/null || true
  tmux set-option -t "$sess" pane-border-style 'fg=colour53' 2>/dev/null || true
  tmux set-option -t "$sess" pane-active-border-style 'fg=colour213' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' Avatar ' 2>/dev/null || true
  tmux set-option -t "$sess" status-style 'bg=colour53,fg=colour255' 2>/dev/null || true
  tmux set-option -t "$sess" status-left-length 14 2>/dev/null || true
  tmux set-option -t "$sess" status-right-length 480 2>/dev/null || true
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
    if [ "$(layout_mode)" != "files-max" ] && [ "$(layout_mode)" != "avatar-max" ] && [ "$(layout_mode)" != "chat-max" ]; then
      tmux select-pane -t "$sess:work.1"
    fi
    ;;
  files-max|explorer)
    toggle_files_max
    ;;
  enter-files-max)
    enter_files_max
    ;;
  avatar-max)
    toggle_avatar_max
    ;;
  show-avatar|avatar)
    restore_avatar_pane
    ;;
  enter-avatar-max)
    enter_avatar_max
    ;;
  chat-max|chat)
    toggle_chat_max
    ;;
  enter-chat-max)
    enter_chat_max
    ;;
  fit)
    fit_window
    install_ui_theme
    ;;
  install-mouse)
    install_avatar_mouse
    ;;
  *)
    echo "usage: orchestrator-layout.sh [ensure|refresh|refresh-soft|fit-quiet|sidebar|files-max|enter-files-max|show-avatar|avatar-max|enter-avatar-max|chat-max|enter-chat-max|fit|install-mouse]" >&2
    exit 2
    ;;
esac
