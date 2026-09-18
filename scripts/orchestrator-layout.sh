#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Bare session name for set-option / pane targets (tmux 3.7c rejects -t =name for set-option).
# Use =name only in session_exists — plain "gotchibot" prefix-matches "gotchibot-hubmon".
sess_name="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess_name="${sess_name#=}"
sess="$sess_name"
min_right="${GOTCHIBOT_TMUX_RIGHT_WIDTH:-47}"
min_avatar="${GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH:-41}"
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

session_exists() {
  tmux has-session -t "=$sess_name" 2>/dev/null
}

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

# Destructive rebuild must not run as a subprocess of work.1/work.2 — kill-pane -a
# would abort the script mid-flight and leave only the Files sidebar.
layout_caller_is_side_pane() {
  local side
  [ -n "${TMUX_PANE:-}" ] || return 1
  side="$(tmux display -p -t "$sess:work.0" '#{pane_id}' 2>/dev/null || true)"
  [ -n "$side" ] || return 1
  [ "$TMUX_PANE" != "$side" ]
}

# Re-enter via tmux run-shell so kill/respawn cannot abort a pane-child mid-flight.
# GOTCHIBOT_LAYOUT_SAFE=1 breaks re-dispatch loops when run-shell still sets TMUX_PANE.
# Must return 0 on "continue in-process" paths — this script uses set -e.
layout_safe_reexec() {
  local c="$1"
  [ "${GOTCHIBOT_LAYOUT_SAFE:-}" = "1" ] && return 0
  layout_caller_is_side_pane || return 0
  case "$c" in
    # Soft / idempotent — safe to run in-pane (no kill-pane -a).
    fit|install-mouse) return 0 ;;
  esac
  tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess_name\" \"$ROOT/scripts/orchestrator-layout.sh\" $c"
  exit 0
}

require_three_panes() {
  tmux resize-pane -Z -t "$sess:work" 2>/dev/null || true
  layout_ready && return 0
  if layout_caller_is_side_pane && [ "${GOTCHIBOT_LAYOUT_SAFE:-}" != "1" ]; then
    tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess_name\" \"$ROOT/scripts/orchestrator-layout.sh\" require-three"
    layout_ready || return 1
    return 0
  fi
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

meet_gallery_correct() {
  layout_ready || return 1
  # Exactly three panes: Files | Meet · room | # meet. A collapsed 2-pane
  # desk with channel on work.1 used to pass soft checks and stay broken.
  [ "$(pane_count)" -eq 3 ] || return 1
  local c0 c1 c2
  c0="$(pane_start_cmd 0)"
  c1="$(pane_start_cmd 1)"
  c2="$(pane_start_cmd 2)"
  [[ "$c0" == *sidebar-pane* ]] && [[ "$c1" == *meet-room* ]] && [[ "$c2" == *meet-channel* ]]
}

# pstack dossier: sidebar | pstack-window (center) | avatar (right).
pstack_dossier_correct() {
  layout_ready || return 1
  local c0 c1 c2
  c0="$(pane_start_cmd 0)"
  c1="$(pane_start_cmd 1)"
  c2="$(pane_start_cmd 2)"
  [[ "$c0" == *sidebar-pane* ]] && [[ "$c1" == *pstack-window* ]] && [[ "$c2" == *avatar-pane* ]]
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
  # Splits reuse the surviving pane as center — respawn all three so work.1 is always chat.
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  mark_avatar_pane
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
  if ! session_exists; then
    echo "orchestrator layout: tmux session '$sess_name' not found" >&2
    return 1
  fi
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
# Meet gallery: wheel on # meet scrolls transcript.
install_meet_gallery_mouse() {
  local ch_if='#{==:#{@gotchibot-meet-channel},1}'
  local av_if='#{==:#{@gotchibot-avatar},1}'
  local scroll_up="cd '$ROOT' && GOTCHIBOT_TMUX_SESSION='$sess_name' '$ROOT/scripts/meet-channel-scroll.sh' up"
  local scroll_down="cd '$ROOT' && GOTCHIBOT_TMUX_SESSION='$sess_name' '$ROOT/scripts/meet-channel-scroll.sh' down"
  local def_drag='if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'

  tmux set-option -g mouse on 2>/dev/null || true
  tmux set-option -t "$sess" mouse on 2>/dev/null || true

  tmux unbind-key -n WheelUpPane 2>/dev/null || true
  tmux unbind-key -n WheelDownPane 2>/dev/null || true
  tmux unbind-key -n MouseDown1Pane 2>/dev/null || true
  tmux unbind-key -n MouseDrag1Pane 2>/dev/null || true

  # Wheel over # meet: the live pane (meet-channel.mjs --live) reads SGR wheel
  # itself, so pass the event straight through — no run-shell, no node spawn
  # per tick (that was ~90ms each and the source of the scroll lag). The
  # run-shell scroll script is only the fallback when the live process is gone.
  # Avatar wheel stays a no-op; other panes keep the tmux default.
  local pass_if='#{&&:#{!=:#{@gotchibot-avatar},1},#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}}'
  local plain_if='#{&&:#{!=:#{@gotchibot-avatar},1},#{!=:#{@gotchibot-meet-channel},1}}'
  local plain_wheel="if-shell -F \"$plain_if\" \"copy-mode -e\""
  local plain_wheel_q="${plain_wheel//\"/\\\"}"
  tmux bind-key -n WheelUpPane \
    if-shell -F "$pass_if" "send-keys -M" \
    "if-shell -F \"$ch_if\" \"run-shell '$scroll_up'\" \"$plain_wheel_q\"" 2>/dev/null || true
  tmux bind-key -n WheelDownPane \
    if-shell -F "$pass_if" "send-keys -M" \
    "if-shell -F \"$ch_if\" \"run-shell '$scroll_down'\" \"$plain_wheel_q\"" 2>/dev/null || true
  tmux bind-key -n MouseDown1Pane \
    if-shell -F "$av_if" "run-shell '$ROOT/scripts/avatar-pane.sh sb-click #{mouse_x} #{mouse_y} #{pane_pid}'" \
    'select-pane -t = ; send-keys -M' 2>/dev/null || true
  tmux bind-key -n MouseDrag1Pane \
    if-shell -F "#{&&:#{!=:#{@gotchibot-meet-channel},1},#{!=:#{@gotchibot-avatar},1}}" "$def_drag" 2>/dev/null || true

  # Ensure channel pane is tagged for the wheel if-shell.
  tmux set-option -p -t "$sess:work.2" @gotchibot-meet-channel 1 2>/dev/null || true
}

# Chat/files/cockpit/pstack keep default (OpenCode / app mouse / send-keys -M).
# NEVER send-keys -t #{pane_id} — that format is empty and errors in the status bar.
# Match avatar ONLY via @gotchibot-avatar=1 (never pane_index).
install_avatar_mouse() {
  # Avatar: wheel / ← / → page gotchi roster. Else OpenCode / pstack get native keys.
  # Keep commands free of nested single-quotes — tmux if-shell "run-shell '…'" breaks them.
  local ru="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-wheel up #{pane_pid}"
  local rd="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-wheel down #{pane_pid}"
  local rc="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-click #{mouse_x} #{mouse_y} #{pane_pid}"
  local def_wheel='if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -e"'
  local def_drag='if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'
  local av_if='#{==:#{@gotchibot-avatar},1}'
  local focus_hook="$ROOT/scripts/tmux-chat-focus-hook.sh"

  tmux set-option -g mouse on 2>/dev/null || true
  tmux set-option -t "$sess" mouse on 2>/dev/null || true
  mark_avatar_pane

  tmux unbind-key -n WheelUpPane 2>/dev/null || true
  tmux unbind-key -n WheelDownPane 2>/dev/null || true
  tmux unbind-key -n MouseDown1Pane 2>/dev/null || true
  tmux unbind-key -n MouseDrag1Pane 2>/dev/null || true
  # CRITICAL: do NOT bind -n Left/Right globally. The old "pass CSI via send-keys
  # Escape [D" path broke arrows in chat/pstack whenever focus left the avatar.
  tmux unbind-key -n Left 2>/dev/null || true
  tmux unbind-key -n Right 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar Left 2>/dev/null || true
  tmux unbind-key -T gotchi-avatar Right 2>/dev/null || true

  tmux bind-key -n WheelUpPane \
    if-shell -F "$av_if" "run-shell \"$ru\"" \
    "$def_wheel" 2>/dev/null || true
  tmux bind-key -n WheelDownPane \
    if-shell -F "$av_if" "run-shell \"$rd\"" \
    "$def_wheel" 2>/dev/null || true

  # Click: focus avatar, switch key-table, then page hitbox. ←/→ only work while
  # the gotchi-avatar table is active (other panes keep native arrows).
  tmux bind-key -n MouseDown1Pane \
    if-shell -F "$av_if" "select-pane -t = ; run-shell \"GOTCHIBOT_TMUX_SESSION=$sess_name $focus_hook\" ; run-shell \"$rc\"" \
    'select-pane -t = ; send-keys -M' 2>/dev/null || true
  tmux bind-key -n MouseDrag1Pane \
    if-shell -F "#{!=:#{@gotchibot-avatar},1}" "$def_drag" 2>/dev/null || true

  # ← / → ONLY in gotchi-avatar key-table (focus hook). Never root -n.
  tmux bind-key -T gotchi-avatar Left "run-shell \"$ru\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Right "run-shell \"$rd\"" 2>/dev/null || true
}

start_pane_commands() {
  require_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.0" C-c Enter "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" Enter
  # Desk boot always opens the cockpit menu (GOTCHIBOT_COCKPIT=1 → show_cockpit in chat-pane).
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || \
    tmux send-keys -t "$sess:work.1" C-c Enter "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_COCKPIT=1 exec ./scripts/chat-pane.sh" Enter
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
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

guard_special_modes() {
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    tmux display-message -t "$sess" "meet gallery — /meet end (or leave menu) to change layout" 2>/dev/null || true
    return 1
  fi
  if [ "$(layout_mode)" = "pstack-dossier" ]; then
    tmux display-message -t "$sess" "pstack dossier — /pstack leave (or leave-pstack-dossier) to change layout" 2>/dev/null || true
    return 1
  fi
  return 0
}

pane_count() {
  tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' '
}

# Shrink window back to files | chat | one right pane (kill meet tiles).
collapse_to_three_panes() {
  local count
  count="$(pane_count)"
  while [ "${count:-0}" -gt 3 ]; do
    tmux kill-pane -t "$sess:work.$((count - 1))" 2>/dev/null || break
    count="$(pane_count)"
  done
  if [ "${count:-0}" -lt 3 ]; then
    require_three_panes || return 1
  fi
  return 0
}

mark_meet_tile() {
  local target="$1" hero="${2:-}"
  tmux set-option -p -t "$target" @gotchibot-meet-tile 1 2>/dev/null || true
  if [ -n "$hero" ]; then
    tmux set-option -p -t "$target" @gotchibot-hero "$hero" 2>/dev/null || true
  fi
  tmux set-option -p -t "$target" history-limit 0 2>/dev/null || true
  # Allow mouse clicks on avatar tiles (same as main avatar).
  tmux set-option -p -t "$target" @gotchibot-avatar 1 2>/dev/null || true
}

short_border_label() {
  local label="$1"
  label="$(printf '%s' "$label" | tr -d '\n' | cut -c1-12)"
  printf ' %s ' "$label"
}

# Rebuild meet layout: Zoom carousel + prompt (work.1) + iMessage transcript (work.2).
build_meet_gallery_tiles() {
  collapse_to_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  collapse_sidebar
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true

  local channel_w
  channel_w=$(( $(window_width) * 42 / 100 ))
  [ "$channel_w" -lt 44 ] && channel_w=44
  [ "$channel_w" -gt 72 ] && channel_w=72

  # If the room pane died and channel slid onto work.1 (2-pane desk), put a
  # room stub back on .1 before splitting — otherwise we end up with two
  # channel panes and LAYOUT_ONLY would refuse to fix .1.
  local c1_pre
  c1_pre="$(pane_start_cmd 1)"
  if [ "$(pane_count)" -lt 3 ] && [[ "$c1_pre" == *meet-channel* ]]; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/meet-room-pane.sh" 2>/dev/null || true
  fi

  if [ "$(pane_count)" -lt 3 ]; then
    tmux split-window -h -t "$sess:work.1" -l "$channel_w" \
      "cd \"$ROOT\" && exec ./scripts/meet-channel-pane.sh" 2>/dev/null || true
  fi

  # Channel first — respawning work.1 kills the shell that invoked enter-meet-gallery.
  # Only respawn when the pane is wrong; always-respawn looks like an iMessage "crash".
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-avatar 2>/dev/null || true
  local c2
  c2="$(pane_start_cmd 2)"
  if [[ "$c2" != *meet-channel* ]]; then
    tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/meet-channel-pane.sh" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.2" @gotchibot-meet-channel 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }# meet ' 2>/dev/null || true

  local c1
  c1="$(pane_start_cmd 1)"
  if [[ "$c1" != *meet-room* ]]; then
    # GOTCHIBOT_MEET_LAYOUT_ONLY=1 skips a healthy room respawn (keeps the live
    # prompter). It must NEVER skip when work.1 is wrong — that was the
    # channel-on-.1 collapse.
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/meet-room-pane.sh" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.1" @gotchibot-meet-room 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-channel 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Meet · room ' 2>/dev/null || true
  # Drop overflow tiles beyond room + channel.
  while [ "$(pane_count)" -gt 3 ]; do
    tmux kill-pane -t "$sess:work.3" 2>/dev/null || break
  done
  apply_meet_gallery_sizes
  printf '0\n' > "$ROOT/sessions/.meet-channel-scroll" 2>/dev/null || true
  date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/sessions/.meet-room.stamp" 2>/dev/null || true
  date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/sessions/.meet-channel.stamp" 2>/dev/null || true
  install_meet_gallery_mouse 2>/dev/null || true

  # Last line of defense: if we still aren't Files|room|channel, force room+channel.
  if ! meet_gallery_correct; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/meet-room-pane.sh" 2>/dev/null || true
    tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/meet-channel-pane.sh" 2>/dev/null || true
    tmux set-option -p -t "$sess:work.1" @gotchibot-meet-room 1 2>/dev/null || true
    tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-channel 2>/dev/null || true
    tmux set-option -p -t "$sess:work.2" @gotchibot-meet-channel 1 2>/dev/null || true
    tmux set-option -p -t "$sess:work.2" -u @gotchibot-meet-room 2>/dev/null || true
    apply_meet_gallery_sizes
  fi
}

apply_meet_gallery_sizes() {
  local win_w channel_w room_w
  win_w="$(window_width)"
  collapse_sidebar
  channel_w=$(( win_w * 42 / 100 ))
  [ "$channel_w" -lt 44 ] && channel_w=44
  [ "$channel_w" -gt 72 ] && channel_w=72
  room_w=$((win_w - sidebar_collapsed - channel_w - 2))
  [ "$room_w" -lt 40 ] && room_w=40
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.2" -x "$channel_w" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$room_w" 2>/dev/null || true
}

enter_meet_gallery() {
  session_exists || return 1
  apply_window_policy
  # Leave other max modes back to a base 3-pane shell first.
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ] || [ "$(layout_mode)" = "chat-max" ]; then
    set_layout_mode normal
    collapse_to_three_panes || true
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  fi
  if [ "$(layout_mode)" != "meet-gallery" ]; then
    require_three_panes || return 1
  fi
  set_layout_mode meet-gallery
  build_meet_gallery_tiles || return 1
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
}

refresh_meet_gallery() {
  if [ "$(layout_mode)" != "meet-gallery" ]; then
    return 0
  fi
  if ! meet_gallery_correct; then
    build_meet_gallery_tiles || return 1
  else
    apply_meet_gallery_sizes
    install_meet_gallery_mouse 2>/dev/null || true
  fi
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
}

leave_meet_gallery() {
  local to_cockpit=0
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    to_cockpit=1
  fi
  if [ "$(layout_mode)" != "meet-gallery" ]; then
    return 0
  fi
  # Mark normal before respawns so resize hooks don't re-enter meet-gallery.
  set_layout_mode normal
  if [ "$(pane_count)" -lt 3 ]; then
    require_three_panes || true
  fi
  collapse_to_three_panes || true
  # Sidebar + avatar before chat — respawn-pane -k on work.1 may kill the caller.
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  mark_avatar_pane
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_avatar_mouse 2>/dev/null || true
  # boot_cockpit_desk does the single final chat respawn when GOTCHIBOT_BOOT_COCKPIT=1.
  if [ "${GOTCHIBOT_BOOT_COCKPIT:-}" != "1" ]; then
    if [ "$to_cockpit" -eq 1 ]; then
      tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
    else
      tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
    fi
  fi
}

# pstack dossier: sidebar | pstack-window (center, replaces chat) | avatar (right).
# Julius's screenshot: CURRENT STATUS should occupy the center pane; avatar stays on the right.
build_pstack_dossier_tiles() {
  collapse_to_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  collapse_sidebar
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true

  # Center pane = pstack-window (dossier replaces chat). Unmark chat so the
  # pane is not treated as the OpenCode chat pane.
  local c1
  c1="$(pane_start_cmd 1)"
  if [[ "$c1" != *pstack-window* ]]; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/pstack-window.mjs watch" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.1" @gotchibot-pstack-dossier 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }pstack · dossier ' 2>/dev/null || true

  # Right pane = avatar (kept, like a normal desk).
  local c2
  c2="$(pane_start_cmd 2)"
  if [[ "$c2" != *avatar-pane* ]]; then
    tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  mark_avatar_pane

  while [ "$(pane_count)" -gt 3 ]; do
    tmux kill-pane -t "$sess:work.3" 2>/dev/null || break
  done
  apply_pstack_dossier_sizes
  date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/sessions/.pstack-dossier.stamp" 2>/dev/null || true
  # Reinstall avatar wheel/click after enter (mark work.2 + page binds).
  install_avatar_mouse 2>/dev/null || true
}

apply_pstack_dossier_sizes() {
  local win_w dossier_w
  win_w="$(window_width)"
  collapse_sidebar
  # Center pstack window is wide; avatar stays at min_avatar on the right.
  dossier_w=$(( win_w - sidebar_collapsed - min_avatar - 2 ))
  [ "$dossier_w" -lt 44 ] && dossier_w=44
  tmux resize-pane -t "$sess:work.0" -x "$sidebar_collapsed" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.2" -x "$min_avatar" 2>/dev/null || true
  tmux resize-pane -t "$sess:work.1" -x "$dossier_w" 2>/dev/null || true
}

enter_pstack_dossier() {
  session_exists || return 1
  apply_window_policy
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ] || [ "$(layout_mode)" = "chat-max" ]; then
    set_layout_mode normal
    collapse_to_three_panes || true
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  fi
  if [ "$(layout_mode)" != "pstack-dossier" ]; then
    require_three_panes || return 1
  fi
  set_layout_mode pstack-dossier
  build_pstack_dossier_tiles || return 1
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
}

refresh_pstack_dossier() {
  if [ "$(layout_mode)" != "pstack-dossier" ]; then
    return 0
  fi
  if ! pstack_dossier_correct; then
    build_pstack_dossier_tiles || return 1
  else
    apply_pstack_dossier_sizes
  fi
  install_avatar_mouse 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
}

leave_pstack_dossier() {
  local to_cockpit=0
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    to_cockpit=1
  fi
  if [ "$(layout_mode)" != "pstack-dossier" ]; then
    return 0
  fi
  # Mark normal before respawns so resize hooks don't re-enter pstack-dossier.
  set_layout_mode normal
  if [ "$(pane_count)" -lt 3 ]; then
    require_three_panes || true
  fi
  collapse_to_three_panes || true
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  mark_avatar_pane
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_avatar_mouse 2>/dev/null || true
  # Always return to cockpit when leaving pstack (policy). Skip when boot_cockpit_desk
  # will do the single final chat respawn (GOTCHIBOT_BOOT_COCKPIT=1).
  if [ "${GOTCHIBOT_BOOT_COCKPIT:-}" != "1" ]; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  fi
}

# Desk start / reattach: peel special modes and always land in cockpit.
# Mid-session zooms (files-max toggle, agent switches) keep SKIP_COCKPIT via restore_normal_layout.
boot_cockpit_desk() {
  session_exists || return 1
  apply_window_policy

  local mode
  mode="$(layout_mode)"
  case "$mode" in
    meet-gallery)
      # Layout restore only — we do the single chat respawn below.
      GOTCHIBOT_BOOT_COCKPIT=1 leave_meet_gallery
      ;;
    pstack-dossier)
      GOTCHIBOT_BOOT_COCKPIT=1 leave_pstack_dossier
      ;;
    files-max|avatar-max|chat-max)
      set_layout_mode normal
      collapse_to_three_panes || true
      tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
      tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
      mark_avatar_pane
      ;;
  esac

  set_layout_mode normal
  require_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  mark_avatar_pane
  # Single final chat respawn — always cockpit on desk boot / reattach.
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-pstack-dossier 2>/dev/null || true
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_avatar_mouse 2>/dev/null || true
}

# Files take remaining width; chat collapses to a thin Gotchi bar; avatar stays.
enter_files_max() {
  if ! guard_special_modes; then return 1; fi
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
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  apply_files_max_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  set_layout_mode files-max
  tmux select-pane -t "$sess:work.0"
  save_layout
  signal_panes
}

# Avatar takes remaining width; chat → bar; files stay collapsed.
enter_avatar_max() {
  if ! guard_special_modes; then return 1; fi
  require_three_panes || return 1
  if [ "$(layout_mode)" = "files-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  collapse_sidebar
  apply_avatar_max_sizes
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_avatar_max_sizes
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  set_layout_mode avatar-max
  tmux select-pane -t "$sess:work.2"
  save_layout
  signal_panes
}

enter_chat_max() {
  if ! guard_special_modes; then return 1; fi
  require_three_panes || return 1
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  fi
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_chat_max_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi · full ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  if ! guard_special_modes; then return 1; fi
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
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    leave_meet_gallery
    return
  fi
  if [ "$(layout_mode)" = "pstack-dossier" ]; then
    leave_pstack_dossier
    return
  fi
  layout_ready || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh"
  tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    guard_special_modes
    return
  fi
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
  win_w="$(tmux display -p -t "$sess:work" '#{window_width}' 2>/dev/null || true)"
  win_w="${win_w:-0}"
  pw="$(tmux display -p -t "$sess:work.0" '#{pane_width}' 2>/dev/null || true)"
  pw="${pw:-$sidebar_collapsed}"
  if [ "$pw" -lt 12 ]; then
    need=$((sidebar_collapsed + min_center + min_right + 2))
  else
    need=$((min_left + min_center + min_right + 2))
  fi
  if [ "$win_w" -gt 0 ] && [ "$win_w" -lt "$need" ]; then
    tmux resize-window -t "$sess:work" -x "$need" 2>/dev/null || true
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
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    if ! meet_gallery_correct; then
      build_meet_gallery_tiles || true
    else
      apply_meet_gallery_sizes
    fi
    return 0
  fi
  if [ "$(layout_mode)" = "pstack-dossier" ]; then
    if ! pstack_dossier_correct; then
      build_pstack_dossier_tiles || true
    else
      apply_pstack_dossier_sizes
    fi
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
  local hook="$ROOT/scripts/tmux-chat-focus-hook.sh"
  local layout="$ROOT/scripts/orchestrator-layout.sh"
  local layout_run="cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION='$sess_name' '$layout'"
  chmod +x "$hook" "$layout" "$ROOT/scripts/chat-bar-pane.sh" 2>/dev/null || true
  # Free Ctrl+b for chat-max in mc/files/avatar panes; tmux prefix → Ctrl+Space in this session.
  tmux set-option -t "$sess" prefix C-Space 2>/dev/null || true
  tmux bind-key -T prefix C-Space send-prefix 2>/dev/null || true
  # tui-policy (config/tui-policy.json): Tab stays in OpenCode. Never bind -n Tab.
  node "$ROOT/scripts/tui-policy.mjs" apply >/dev/null 2>&1 || true
  tmux unbind-key -n Tab 2>/dev/null || true
  tmux unbind-key -n S-Tab 2>/dev/null || true
  tmux unbind-key -n BTab 2>/dev/null || true
  tmux unbind-key -T gotchi-chat Tab 2>/dev/null || true
  tmux unbind-key -T gotchi-chat S-Tab 2>/dev/null || true
  local cycle="$ROOT/scripts/agent-mode.mjs cycle --restart"
  tmux bind-key -T gotchi-chat F2 run-shell "cd $ROOT && node $cycle >/dev/null" 2>/dev/null || true
  # Layout — Ctrl+F files · Ctrl+A avatar-max · Ctrl+G show avatar · Ctrl+B chat
  # Fallback: Alt+F/A/G/B · F6 show avatar · F7 avatar-max · prefix: Ctrl+Space then f/a/b
  install_layout_keys root
  install_layout_keys gotchi-chat
  install_layout_keys gotchi-files
  install_layout_keys gotchi-avatar
  # Pagination clicks on avatar; wheel unbound there (orch face stays pinned).
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    install_meet_gallery_mouse 2>/dev/null || true
  elif [ "$(layout_mode)" = "pstack-dossier" ]; then
    # Center pane (work.1) is the dossier TUI — keep default wheel/scroll, never chat/avatar.
    tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
    tmux set-option -p -t "$sess:work.1" @gotchibot-pstack-dossier 1 2>/dev/null || true
    # Right pane stays the avatar (normal desk behavior).
    install_avatar_mouse
  else
    install_avatar_mouse
  fi
  # Orchestrator focus — F3 / prefix o / Option+O
  tmux bind-key -T gotchi-chat F3 run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T prefix o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T root M-o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  # Meet gallery (existing meeting only) — F8 / prefix m / Option+M / Option+U
  # Do NOT bind -n C-m: terminals send C-m for Enter.
  tmux bind-key -T gotchi-chat F8 run-shell "cd \"$ROOT\" && ./scripts/gotchi-meet.mjs open" 2>/dev/null || true
  tmux bind-key -T prefix m run-shell "cd \"$ROOT\" && ./scripts/gotchi-meet.mjs open" 2>/dev/null || true
  tmux bind-key -T root M-m run-shell "cd \"$ROOT\" && ./scripts/gotchi-meet.mjs open" 2>/dev/null || true
  tmux bind-key -T root M-u run-shell "cd \"$ROOT\" && ./scripts/gotchi-meet.mjs open" 2>/dev/null || true
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
  # Wheel over avatar pages roster; chat/files keep default (OpenCode / send-keys -M).
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
  # Active pane: bright gotchi-pink border + ● label. Inactive: dim charcoal.
  # Users complained they couldn't tell focus — make the contrast obvious.
  tmux set-option -t "$sess" pane-border-status top 2>/dev/null || true
  tmux set-option -t "$sess" pane-border-lines heavy 2>/dev/null || true
  tmux set-option -t "$sess" pane-border-style 'fg=colour238,bg=default' 2>/dev/null || true
  tmux set-option -t "$sess" pane-active-border-style 'fg=colour213,bg=default,bold' 2>/dev/null || true
  # tmux 3.3+: colour and/or arrows on the active edge
  tmux set-option -t "$sess" pane-border-indicators both 2>/dev/null || true
  apply_pane_border_labels
  tmux set-option -t "$sess" status-style 'bg=colour53,fg=colour255' 2>/dev/null || true
  tmux set-option -t "$sess" status-left-length 14 2>/dev/null || true
  tmux set-option -t "$sess" status-right-length 480 2>/dev/null || true
  tmux set-option -t "$sess" status-interval 30 2>/dev/null || true
  tmux set-option -t "$sess" status-left '#[fg=white,bold] GotchiBot ' 2>/dev/null || true
  tmux set-option -t "$sess" status-right "#[fg=colour252]#($status_bar) #[fg=colour238]|#[default] #[fg=colour250]#S " 2>/dev/null || true
  apply_window_policy
}

# Mode-aware titles; active pane gets a ● so focus is obvious at a glance.
apply_pane_border_labels() {
  local mode label0 label1 label2
  mode="$(layout_mode)"
  label0=' Files '
  label1=' Gotchi '
  label2=' Avatar '
  case "$mode" in
    meet-gallery)
      label1=' Meet · room '
      label2=' # meet '
      ;;
    pstack-dossier)
      label1=' pstack · dossier '
      ;;
    files-max)
      label0=' Files · full '
      ;;
    avatar-max)
      label2=' Avatar · full '
      ;;
    chat-max)
      label1=' Gotchi · full '
      ;;
  esac
  # #{?pane_active,…} is evaluated per pane by tmux.
  tmux set-option -t "$sess:work.0" pane-border-format " #{?pane_active,●, }${label0}" 2>/dev/null || true
  tmux set-option -t "$sess:work.1" pane-border-format " #{?pane_active,●, }${label1}" 2>/dev/null || true
  tmux set-option -t "$sess:work.2" pane-border-format " #{?pane_active,●, }${label2}" 2>/dev/null || true
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
layout_safe_reexec "$cmd"

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
    if [ "$(layout_mode)" = "meet-gallery" ]; then
      refresh_meet_gallery
    elif [ "$(layout_mode)" = "pstack-dossier" ]; then
      refresh_pstack_dossier
    elif ! layout_ready; then
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
    if [ "$(layout_mode)" = "meet-gallery" ] || [ "$(layout_mode)" = "pstack-dossier" ]; then
      boot_cockpit_desk
      exit 0
    fi
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
  enter-meet-gallery|meet-gallery)
    enter_meet_gallery
    ;;
  refresh-meet-gallery)
    refresh_meet_gallery
    ;;
  leave-meet-gallery)
    leave_meet_gallery
    ;;
  leave-meet-cockpit)
    leave_meet_gallery cockpit
    ;;
  enter-pstack-dossier|pstack-dossier)
    enter_pstack_dossier
    ;;
  refresh-pstack-dossier)
    refresh_pstack_dossier
    ;;
  leave-pstack-dossier)
    leave_pstack_dossier
    ;;
  leave-pstack-cockpit)
    leave_pstack_dossier cockpit
    ;;
  enter-cockpit|boot-cockpit)
    boot_cockpit_desk
    ;;
  require-three)
    # Invoked via run-shell from a side pane so rebuild is not aborted mid-flight.
    rebuild_panes || exit 1
    layout_ready || exit 1
    ;;
  fit)
    fit_window
    install_ui_theme
    ;;
  install-mouse)
    install_agent_keys
    if [ "$(layout_mode)" = "meet-gallery" ]; then
      tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
      tmux set-option -p -t "$sess:work.1" @gotchibot-meet-room 1 2>/dev/null || true
    elif [ "$(layout_mode)" = "pstack-dossier" ]; then
      # work.1 is the dossier TUI, not chat.
      tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
      tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
      tmux set-option -p -t "$sess:work.1" @gotchibot-pstack-dossier 1 2>/dev/null || true
    else
      tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
      tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
    fi
    ;;
  *)
    echo "usage: orchestrator-layout.sh [ensure|refresh|refresh-soft|fit-quiet|sidebar|files-max|enter-files-max|show-avatar|avatar-max|enter-avatar-max|chat-max|enter-chat-max|enter-meet-gallery|refresh-meet-gallery|leave-meet-gallery|leave-meet-cockpit|enter-pstack-dossier|refresh-pstack-dossier|leave-pstack-dossier|leave-pstack-cockpit|enter-cockpit|boot-cockpit|require-three|fit|install-mouse]" >&2
    exit 2
    ;;
esac
