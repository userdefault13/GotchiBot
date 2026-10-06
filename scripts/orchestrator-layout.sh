#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Terminal caps (TUI_COLOR / TUI_GLYPHS / TUI_MOUSE) — plain / linux / GOTCHIBOT_TUI_PLAIN=1.
# shellcheck source=scripts/lib/term-caps.sh
. "$ROOT/scripts/lib/term-caps.sh"
gotchibot_term_caps
# Bare session name for set-option / pane targets (tmux 3.7c rejects -t =name for set-option).
# Use =name only in session_exists — plain "gotchibot" prefix-matches "gotchibot-hubmon".
sess_name="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
sess_name="${sess_name#=}"
sess="$sess_name"
min_right="${GOTCHIBOT_TMUX_RIGHT_WIDTH:-47}"
# Desk canvas is 163 columns by 46 rows on a laptop (was 147 by 40: +16 columns, +6 rows). A client whose content area is at least 70 rows grows the window to that height so the avatar can show 3 roster rows; shorter clients stay at 46. 9 panes, 8 separators, content 155 at 163 (139 at 147). Avatar stays 44. Files bar stays 3. Collapsed label bars stay 3: one space, the glyph, one space (they are not shrunk to 1). Kanban is pane 8. Chrome = files 3 + six collapsed bars of 3 = 21, so a focused chat/factory/dossier/inbox/meet/cockpit/kanban pane is 139-21-44 = 74 at 147 and 155-21-44 = 90 at 163 (was 78 and 94 before the kanban bar and its separator). The extra 16 columns still land on that focused pane. Roster cell is floor((44-1-4)/3)=13. The joined row is 43. The extra avatar column is a left pad, not a wider cell. 12-col thumb still fits; names longer than 13 still clip.
min_avatar="${GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH:-24}"
min_left="${GOTCHIBOT_TMUX_LEFT_WIDTH:-30}"
sidebar_collapsed="${GOTCHIBOT_SIDEBAR_COLLAPSED:-3}"
chat_collapsed="${GOTCHIBOT_CHAT_COLLAPSED:-3}"
min_center="${GOTCHIBOT_TMUX_CENTER_WIDTH:-50}"
win_w_default="${GOTCHIBOT_WINDOW_WIDTH:-163}"
win_h_default="${GOTCHIBOT_WINDOW_HEIGHT:-46}"
# Three roster rows need a 70-row pane (portrait budget stays 20). See canvas_height_for_client.
win_h_desktop="${GOTCHIBOT_WINDOW_HEIGHT_DESKTOP:-70}"
resize_hook="$ROOT/scripts/orchestrator-resize.sh"

# Client lines → tmux window rows. The status line is not part of the window.
# Laptop floor is win_h_default (46): one roster row. A desktop is tall enough
# when the content area is at least win_h_desktop (70), which keeps the laptop
# portrait budget (20) and fits 3 roster rows of 12 lines. Shorter clients do
# not get a squeezed 3-row canvas — they stay at 46.
canvas_height_for_client() {
  local client="${1:-0}" avail
  case "$client" in
    ''|*[!0-9]*) client=0 ;;
  esac
  if [ "$client" -gt 1 ]; then
    avail=$((client - 1))
  else
    avail=0
  fi
  if [ "$avail" -ge "$win_h_desktop" ]; then
    printf '%s\n' "$avail"
  else
    printf '%s\n' "$win_h_default"
  fi
}

# Attached client → window rows. No client: leave the caller to skip the resize.
desk_window_height() {
  local client
  client="$(tmux display -p -t "$sess" '#{client_height}' 2>/dev/null || echo 0)"
  case "$client" in
    ''|0|*[!0-9]*) return 1 ;;
  esac
  canvas_height_for_client "$client"
}

apply_window_height() {
  local want cur
  want="$(desk_window_height)" || return 0
  cur="$(tmux display -p -t "$sess:work" '#{window_height}' 2>/dev/null || echo 0)"
  case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
  [ "$want" = "$cur" ] && return 0
  tmux resize-window -t "$sess:work" -y "$want" 2>/dev/null || true
}

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
  [ "$(tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' ')" -ge 3 ]
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
  layout_unlock
  tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess_name\" \"$ROOT/scripts/orchestrator-layout.sh\" $*"
  exit 0
}

require_three_panes() {
  tmux resize-pane -Z -t "$sess:work" 2>/dev/null || true
  # Extra panes (cockpit, factory, pstack, inbox, meet) are permanent. Rebuilding
  # here used to kill them whenever the count was not exactly 3.
  if [ "$(pane_count)" -ge 3 ] && [[ "$(pane_start_cmd 0)" == *sidebar-pane* || "$(pane_start_cmd 0)" == *mc-pane* ]]; then
    return 0
  fi
  layout_ready && return 0
  if layout_caller_is_side_pane && [ "${GOTCHIBOT_LAYOUT_SAFE:-}" != "1" ]; then
    local relock="$LAYOUT_LOCK_HELD"
    layout_unlock
    tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess_name\" \"$ROOT/scripts/orchestrator-layout.sh\" require-three"
    [ "$relock" = 1 ] && layout_lock
    layout_ready || return 1
    return 0
  fi
  rebuild_panes || return 1
  layout_ready || {
    echo "orchestrator layout failed: need 3 panes (sidebar | chat | avatar)" >&2
    return 1
  }
}

# One list-panes per layout pass instead of a display per pane. Only focus_desk
# turns the cache on; every pane mutation inside it reloads or drops it.
PANE_CACHE=""
PANE_CACHE_OK=0
pane_cache_load() {
  PANE_CACHE="$(tmux list-panes -t "$sess:work" -F '#{pane_index}	#{pane_dead}	#{pane_start_command}' 2>/dev/null || true)"
  PANE_CACHE_OK=1
}
pane_cache_drop() {
  PANE_CACHE=""
  PANE_CACHE_OK=0
}
pane_cache_field() {
  local want="$1" field="$2" i d c
  while IFS=$'\t' read -r i d c; do
    [ "$i" = "$want" ] || continue
    if [ "$field" = dead ]; then printf '%s\n' "$d"; else printf '%s\n' "$c"; fi
    return 0
  done <<<"$PANE_CACHE"
  printf '\n'
}

pane_start_cmd() {
  if [ "$PANE_CACHE_OK" = 1 ]; then
    pane_cache_field "$1" cmd
    return 0
  fi
  tmux display -p -t "$sess:work.$1" '#{pane_start_command}' 2>/dev/null || echo ""
}

pane_dead_flag() {
  if [ "$PANE_CACHE_OK" = 1 ]; then
    pane_cache_field "$1" dead
    return 0
  fi
  tmux display -p -t "$sess:work.$1" '#{pane_dead}' 2>/dev/null || echo ""
}

# One layout change at a time. Apps (the meet room on start, panes that exit)
# call this script too; two passes interleaving swaps and index respawns used to
# respawn the wrong pane (avatar became a second cockpit). mkdir is atomic.
LAYOUT_LOCK="$ROOT/sessions/.layout.lock"
LAYOUT_WANT="$ROOT/sessions/.layout.want"
LAYOUT_LOCK_HELD=0
# Waits while the holder is alive (a dead holder's lock is taken over). With
# $1=latest, a newer queued request supersedes this one: the waiter exits so a
# burst of focus keys does the work once, for where you landed.
layout_lock() {
  local mode="${1:-}" tries=0 owner
  mkdir -p "$ROOT/sessions"
  [ "$mode" = latest ] && printf '%s\n' "$$" > "$LAYOUT_WANT"
  while ! mkdir "$LAYOUT_LOCK" 2>/dev/null; do
    owner="$(cat "$LAYOUT_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$LAYOUT_LOCK"
      continue
    fi
    if [ "$mode" = latest ] && [ "$(cat "$LAYOUT_WANT" 2>/dev/null)" != "$$" ]; then
      exit 0
    fi
    tries=$((tries + 1))
    # A holder that never wrote its pid (killed between mkdir and write) is stale after ~3s.
    if [ -z "$owner" ] && [ "$tries" -ge 30 ]; then
      rm -rf "$LAYOUT_LOCK"
      continue
    fi
    # Hard ceiling (~2 min) so a wedged holder cannot block the desk forever.
    [ "$tries" -ge 1200 ] && return 0
    sleep 0.1
  done
  printf '%s\n' "$$" > "$LAYOUT_LOCK/pid"
  LAYOUT_LOCK_HELD=1
  # Superseded while we waited? Release and let the newer request run.
  if [ "$mode" = latest ] && [ "$(cat "$LAYOUT_WANT" 2>/dev/null)" != "$$" ]; then
    layout_unlock
    exit 0
  fi
}
layout_unlock() {
  [ "$LAYOUT_LOCK_HELD" = 1 ] || return 0
  rm -rf "$LAYOUT_LOCK"
  LAYOUT_LOCK_HELD=0
}

# Respawn work.N only when it is dead or runs something else, so a live pane keeps its state.
respawn_unless() {
  local n="$1" want="$2" cmd="$3"
  if [[ "$(pane_start_cmd "$n")" == *"$want"* ]] && [ "$(pane_dead_flag "$n")" = "0" ]; then
    return 0
  fi
  tmux respawn-pane -t "$sess:work.$n" -k "$cmd" 2>/dev/null || true
  [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
  return 0
}

# A chat app is running under the pane: OpenCode, the OpenClaw TUI, or the Hub desk
# chat over SSH. pane_current_command only ever shows chat-pane.sh's bash.
pane_has_chat() {
  local pid
  pid="$(tmux display -p -t "$1" '#{pane_pid}' 2>/dev/null)"
  [ -n "$pid" ] || return 1
  ps -axo pid=,ppid=,args= 2>/dev/null | awk -v root="$pid" '
    { p[$1] = $2; a[$1] = $0 }
    END {
      for (k in a) {
        if (k == root || a[k] !~ /opencode|openclaw|hub-desk\.mjs/) continue
        x = k; d = 0
        while (x != "" && x != root && x > 1 && d < 32) { x = p[x]; d++ }
        if (x == root) exit 0
      }
      exit 1
    }'
}

# Screen order: files, avatar, cockpit, chat, factory, dossier, inbox, meeting.
chat_pane_index() {
  local i cmd n
  n="${DESK_PANE_COUNT:-9}"
  for ((i = 0; i < n; i++)); do
    cmd="$(pane_start_cmd "$i")"
    if [[ "$cmd" == *chat-pane* || "$cmd" == *chat-bar-pane* ]]; then
      echo "$i"
      return 0
    fi
  done
  echo 3
}

chat_live() {
  pane_has_chat "$sess:work.$(chat_pane_index)"
}

# Factory / files-max / avatar-max take over work.1. The live chat waits in a hidden
# session instead of dying, so coming back skips chat-pane.sh's full startup.
# Not "<sess>-park": tmux prefix-matches "gotchibot" onto it when the desk is gone.
park_session() {
  echo "gbpark-$sess_name"
}

park_chat_pane() {
  chat_live || return 0
  local park park_id
  park="$(park_session)"
  tmux kill-session -t "=$park" 2>/dev/null || true
  local chatp
  chatp="$sess:work.$(chat_pane_index)"
  park_id="$(tmux new-session -d -P -F '#{session_id}' -s "$park" -x "$(tmux display -p -t "$chatp" '#{pane_width}')" \
    -y "$(tmux display -p -t "$chatp" '#{pane_height}')" "exec tail -f /dev/null" 2>/dev/null)" || return 1
  # Every target here assumes =$park:0.0. A user tmux.conf (Omarchy's) may set
  # base-index / pane-base-index 1 globally, so pin 0-based numbering on this session only.
  # base-index only applies to new windows, so move-window -r renumbers the one just created.
  # The session id is the exact target: set-option rejects -t =name for session options.
  tmux set-option -t "$park_id" base-index 0 2>/dev/null || true
  tmux move-window -r -t "$park_id" 2>/dev/null || true
  tmux set-option -w -t "$park_id:" pane-base-index 0 2>/dev/null || true
  tmux swap-pane -d -s "$chatp" -t "=$park:0.0" 2>/dev/null || {
    tmux kill-session -t "=$park" 2>/dev/null || true
    return 1
  }
}

unpark_chat_pane() {
  local park old chatp
  park="$(park_session)"
  chatp="$sess:work.$(chat_pane_index)"
  tmux has-session -t "=$park" 2>/dev/null || return 1
  if ! pane_has_chat "=$park:0.0"; then
    tmux kill-session -t "=$park" 2>/dev/null || true
    return 1
  fi
  tmux swap-pane -d -s "=$park:0.0" -t "$chatp" 2>/dev/null || return 1
  # The swapped-out app may be our caller (Factory keys); kill it from the server, last.
  old="$park-old-$$"
  tmux rename-session -t "=$park" "$old" 2>/dev/null || true
  tmux run-shell -b "tmux kill-session -t '=$old'" 2>/dev/null || true
}

layout_correct() {
  [ "$(pane_count)" -ge 3 ] || return 1
  local c0 c1 c2
  c0="$(pane_start_cmd 0)"
  [[ "$c0" == *sidebar-pane* || "$c0" == *mc-pane* ]] || return 1
  # files · avatar · cockpit · chat · factory · dossier · inbox · meeting · kanban
  # 7 still counts: ensure_app_panes grows an older desk to DESK_PANE_COUNT.
  if [ "$(pane_count)" -ge 7 ]; then
    pane_is_kind "$(pane_start_cmd 1)" avatar && pane_is_kind "$(pane_start_cmd 3)" chat
    return
  fi
  c1="$(pane_start_cmd 1)"
  c2="$(pane_start_cmd 2)"
  [[ "$c1" == *chat-pane* || "$c1" == *chat-bar-pane* ]] && [[ "$c2" == *avatar-pane* ]]
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

# The pstack-dossier layout hosts one center app: the dossier (default) or the Factory.
center_app() {
  local app
  app="$(tmux show-options -qv -t "$sess" @gotchibot-center-app 2>/dev/null)"
  [ "$app" = "factory" ] && echo factory || echo pstack
}

center_script() {
  [ "$(center_app)" = "factory" ] && echo factory-window || echo pstack-window
}

center_label() {
  [ "$(center_app)" = "factory" ] && echo 'Factory' || echo 'pstack · dossier'
}

# pstack dossier: sidebar | pstack-window or factory-window (center) | avatar (right).
pstack_dossier_correct() {
  layout_ready || return 1
  local c0 c1 c2
  c0="$(pane_start_cmd 0)"
  c1="$(pane_start_cmd 1)"
  c2="$(pane_start_cmd 2)"
  [[ "$c0" == *sidebar-pane* ]] && [[ "$c1" == *"$(center_script)"* ]] && [[ "$c2" == *avatar-pane* ]]
}

rebuild_panes() {
  local need=$((sidebar_collapsed + min_center + min_right + 2))
  apply_window_height
  tmux resize-window -t "$sess:work" -x "$win_w_default" -y "$(desk_window_height || echo "$win_h_default")" 2>/dev/null || true
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

refresh_desk_borders() {
  [ "${BORDERS_QUEUED:-0}" = 1 ] && return 0
  BORDERS_QUEUED=1
  # Cosmetic, and node starts in ~250ms: never block a pane switch on it.
  ( node "$ROOT/scripts/desk-active.mjs" publish --force >/dev/null 2>&1 || true ) </dev/null >/dev/null 2>&1 &
}

save_layout() {
  layout_ready || return 0
  tmux list-windows -t "$sess:work" -F '#{window_layout}' 2>/dev/null | head -1 > "$LAYOUT_FILE"
  refresh_desk_borders
}

# Every target here assumes work.0 | work.1 | work.2. A user tmux.conf (Omarchy's) may set
# base-index / pane-base-index 1 globally, so pin 0-based numbering on this session only.
# session_exists guards the bare name: set-option rejects -t =name for session options and a
# bare name prefix-matches (gotchibot → gotchibot-cursor) when the exact session is gone.
own_pane_numbering() {
  session_exists || return 0
  tmux set-option -t "$sess" base-index 0 2>/dev/null || true
  tmux set-option -w -t "=$sess_name:work" pane-base-index 0 2>/dev/null || true
}

apply_window_policy() {
  own_pane_numbering
  tmux set-option -t "$sess" window-size manual 2>/dev/null || true
  tmux set-option -t "$sess" aggressive-resize off 2>/dev/null || true
  install_revive_hook
}

# A pane whose app exits (or crashes) used to close, and every slot after it
# shifted left — index-based respawns then hit the wrong pane. Dead panes now
# keep their slot and the pane-died hook revives them (focus_desk respawns any
# dead slot with what belongs there).
install_revive_hook() {
  local revive="cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION='$sess_name' '$ROOT/scripts/orchestrator-layout.sh' revive"
  tmux set-option -w -t "=$sess_name:work" remain-on-exit on 2>/dev/null || true
  tmux set-hook -t "$sess" pane-died "run-shell -b \"$revive\"" 2>/dev/null || true
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

# Mouse off. Wheel must not be forwarded into pane scripts: SGR 64/65
# re-rendered on every tick, lagged, and sometimes crashed a pane.
# Keyboard j/k and arrows still scroll. Avatar roster paging stays on prefix P/N.
install_meet_gallery_mouse() {
  local av_if='#{==:#{@gotchibot-avatar},1}'
  local def_drag='if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'

  tmux set-option -g mouse off 2>/dev/null || true
  tmux set-option -t "$sess" mouse off 2>/dev/null || true

  tmux unbind-key -n WheelUpPane 2>/dev/null || true
  tmux unbind-key -n WheelDownPane 2>/dev/null || true
  tmux unbind-key -n MouseDown1Pane 2>/dev/null || true
  tmux unbind-key -n MouseDrag1Pane 2>/dev/null || true

  tmux bind-key -n MouseDown1Pane \
    if-shell -F "$av_if" "run-shell '$ROOT/scripts/avatar-pane.sh sb-click #{mouse_x} #{mouse_y} #{pane_pid}'" \
    'select-pane -t = ; send-keys -M' 2>/dev/null || true
  tmux bind-key -n MouseDrag1Pane \
    if-shell -F "#{&&:#{!=:#{@gotchibot-meet-channel},1},#{!=:#{@gotchibot-avatar},1}}" "$def_drag" 2>/dev/null || true

  # Ensure channel pane is tagged for the wheel if-shell.
  tmux set-option -p -t "$sess:work.2" @gotchibot-meet-channel 1 2>/dev/null || true
  install_avatar_page_keys
}

# Chat/files/cockpit/pstack do not get a wheel bind (mouse is off).
# NEVER send-keys -t #{pane_id} — that format is empty and errors in the status bar.
# Match avatar ONLY via @gotchibot-avatar=1 (never pane_index).
install_avatar_mouse() {
  # Avatar: expanded focus uses arrows for the sub-agent selector. Wheel is not bound.
  # Keep commands free of nested single-quotes — tmux if-shell "run-shell '…'" breaks them.
  local sl="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow left #{pane_pid}"
  local sr="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow right #{pane_pid}"
  local su="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow up #{pane_pid}"
  local sd="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow down #{pane_pid}"
  local ss="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow space #{pane_pid}"
  local se="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh select-arrow esc #{pane_pid}"
  local rc="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-click #{mouse_x} #{mouse_y} #{pane_pid}"
  local def_drag='if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'
  local av_if='#{==:#{@gotchibot-avatar},1}'
  local focus_hook="$ROOT/scripts/tmux-chat-focus-hook.sh"

  tmux set-option -g mouse off 2>/dev/null || true
  tmux set-option -t "$sess" mouse off 2>/dev/null || true
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


  # Click: focus avatar, switch key-table, then page hitbox. ←/→ only work while
  # the gotchi-avatar table is active (other panes keep native arrows).
  tmux bind-key -n MouseDown1Pane \
    if-shell -F "$av_if" "select-pane -t = ; run-shell \"GOTCHIBOT_TMUX_SESSION=$sess_name $focus_hook\" ; run-shell \"$rc\"" \
    'select-pane -t = ; send-keys -M' 2>/dev/null || true
  tmux bind-key -n MouseDrag1Pane \
    if-shell -F "#{!=:#{@gotchibot-avatar},1}" "$def_drag" 2>/dev/null || true

  # Focused expanded avatar: arrows move the sub-agent selector instead of paging.
  tmux bind-key -T gotchi-avatar Left "run-shell \"$sl\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Right "run-shell \"$sr\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Up "run-shell \"$su\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Down "run-shell \"$sd\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Space "run-shell \"$ss\"" 2>/dev/null || true
  tmux bind-key -T gotchi-avatar Escape "run-shell \"$se\"" 2>/dev/null || true
  install_avatar_page_keys
}

# Avatar roster paging from any pane (no mouse, no avatar focus).
# prefix P/N = Ctrl+Space then Shift+P / Shift+N; Alt+, / Alt+. = same without prefix.
# sb-wheel omits pid — sb_click_wake finds the avatar pane via pid file / @gotchibot-avatar.
install_avatar_page_keys() {
  local rpu="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-wheel up"
  local rpd="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh sb-wheel down"
  local sess_if="#{==:#{session_name},$sess_name}"
  tmux bind-key -r -T prefix P if-shell -F "$sess_if" "run-shell \"$rpu\"" 2>/dev/null || true
  tmux bind-key -r -T prefix N if-shell -F "$sess_if" "run-shell \"$rpd\"" 2>/dev/null || true
  tmux bind-key -n M-, if-shell -F "$sess_if" "run-shell \"$rpu\"" "send-keys M-," 2>/dev/null || true
  tmux bind-key -n M-. if-shell -F "$sess_if" "run-shell \"$rpd\"" "send-keys M-." 2>/dev/null || true
  # Sub-agent selector from any pane: Ctrl+Space then k/j steps up/down the roster
  # (crossing pages; -r so further k/j need no prefix); Ctrl+Space then Enter
  # opens/closes the selected card. Ctrl+Shift arrows never reach tmux in Terminal.
  local rnu="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh roster-nudge up"
  local rnd="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh roster-nudge down"
  local rns="cd $ROOT && GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/avatar-pane.sh roster-nudge enter"
  tmux unbind-key -n C-S-Up 2>/dev/null || true
  tmux unbind-key -n C-S-Down 2>/dev/null || true
  # Ctrl+J / Ctrl+K: same selector steps with no prefix, from any pane. They are
  # taken from the focused app in this session (OpenCode Ctrl+J newline, shell
  # Ctrl+K kill-line); other tmux sessions still get them.
  tmux bind-key -n C-j if-shell -F "$sess_if" "run-shell \"$rnd\"" "send-keys C-j" 2>/dev/null || true
  tmux bind-key -n C-k if-shell -F "$sess_if" "run-shell \"$rnu\"" "send-keys C-k" 2>/dev/null || true
  tmux bind-key -r -T prefix k if-shell -F "$sess_if" "run-shell \"$rnu\"" 2>/dev/null || true
  tmux bind-key -r -T prefix j if-shell -F "$sess_if" "run-shell \"$rnd\"" 2>/dev/null || true
  tmux bind-key -T prefix Enter if-shell -F "$sess_if" "run-shell \"$rns\"" 2>/dev/null || true
  # Cockpit from any pane: Ctrl+Space then Shift+K. The Hub chat runs OpenCode on the
  # hub over SSH, where /cockpit cannot reach this desk's tmux.
  local rck="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh enter-cockpit"
  tmux bind-key -T prefix K if-shell -F "$sess_if" "run-shell -b \"$rck\"" 2>/dev/null || true
  # Factory pane from any pane: Ctrl+Space then Shift+F (again to go back to the cockpit).
  local rfa="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-factory"
  tmux bind-key -T prefix F if-shell -F "$sess_if" "run-shell -b \"$rfa\"" 2>/dev/null || true
  # Inbox pane from any pane: Ctrl+Space then Shift+I (again returns to chat).
  local rin="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-inbox"
  tmux bind-key -T prefix I if-shell -F "$sess_if" "run-shell -b \"$rin\"" 2>/dev/null || true
  # Dossier pane from any pane: Ctrl+Space then Shift+D (again returns to chat).
  local rdo="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-dossier"
  tmux bind-key -T prefix D if-shell -F "$sess_if" "run-shell -b \"$rdo\"" 2>/dev/null || true
  # Meet pane from any pane: Ctrl+Space then Shift+M (again returns to chat).
  # prefix m (lowercase) stays the meet-gallery opener. Shift+M focuses the desk pane.
  local rme="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-meet"
  tmux bind-key -T prefix M if-shell -F "$sess_if" "run-shell -b \"$rme\"" 2>/dev/null || true
  # Kanban pane from any pane: Ctrl+Space then Shift+B (again returns to the cockpit).
  # prefix b (lowercase) stays chat-max. Shift+B is the kanban toggle.
  local rkb="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-kanban"
  tmux bind-key -T prefix B if-shell -F "$sess_if" "run-shell -b \"$rkb\"" 2>/dev/null || true
  # Terminal pane: Ctrl+Space then Shift+T (again returns to chat). Shift+R opens
  # a root shell in it (Touch ID via sudo; scripts/root-shell.sh).
  local rtm="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh toggle-terminal"
  local rrt="cd $ROOT && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=$sess_name $ROOT/scripts/orchestrator-layout.sh root-shell"
  tmux bind-key -T prefix T if-shell -F "$sess_if" "run-shell -b \"$rtm\"" 2>/dev/null || true
  tmux bind-key -T prefix R if-shell -F "$sess_if" "run-shell -b \"$rrt\"" 2>/dev/null || true
}

# The 9-pane desk (files · avatar · cockpit · chat · factory · dossier · inbox ·
# meeting · kanban). The 3-pane rebuild below respawns work.1/work.2 as chat and
# avatar — on this desk that is the avatar and cockpit slots, so callers that
# still ask for refresh/ensure get the current focus re-applied instead.
nine_pane_desk() {
  [ "$(pane_count)" -ge 7 ] || return 1
  pane_is_kind "$(pane_start_cmd 0)" files
}

desk_focus_from_mode() {
  case "$(layout_mode)" in
    chat|avatar|cockpit|factory|pstack|inbox|meet|kanban|terminal) layout_mode ;;
    *) echo chat ;;
  esac
}

start_pane_commands() {
  if nine_pane_desk; then
    focus_desk "$(desk_focus_from_mode)"
    return 0
  fi
  require_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || \
    tmux send-keys -t "$sess:work.0" C-c Enter "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" Enter
  # Chat stays chat. Cockpit, factory, and meeting are their own panes.
  tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || \
    tmux send-keys -t "$sess:work.1" C-c Enter "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" Enter
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

# Drop only overflow tiles past the reserved desk panes.
# 0 files, 1 avatar, 2 cockpit, 3 chat, 4 factory, 5 dossier, 6 inbox, 7 meet.
collapse_to_three_panes() {
  local count
  count="$(pane_count)"
  while [ "${count:-0}" -gt 8 ]; do
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
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true

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
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }# meet ' 2>/dev/null || true

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
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Meet · room ' 2>/dev/null || true
  # Drop overflow tiles beyond room + channel.
  # Overflow past the desk row only. Pane 8 is kanban, not spare.
  while [ "$(pane_count)" -gt "$DESK_PANE_COUNT" ]; do
    tmux kill-pane -t "$sess:work.$(( $(pane_count) - 1 ))" 2>/dev/null || break
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
  focus_desk meet
  return 0
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
  if [ "$(layout_mode)" != "meet" ] && [ "$(layout_mode)" != "meet-gallery" ]; then
    return 0
  fi
  # The meet room asks for this on every start. When focus_desk meet already
  # put it in place, a second full pass only raced the next switch.
  if [ "$(layout_mode)" = "meet" ] && [ "$(pane_count)" -eq "$DESK_PANE_COUNT" ] && \
     [[ "$(pane_start_cmd "$(focus_index meet)")" == *meet-room-pane* ]]; then
    return 0
  fi
  focus_desk meet
  return 0
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
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    focus_desk cockpit
  else
    focus_desk chat
  fi
  return 0
  local to_cockpit=0
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    to_cockpit=1
  fi
  # Always repair the desk. Old early-return when mode!=meet-gallery left a blank
  # center pane after /chat (mode already flipped, meet-room pane still dying).
  local c1
  c1="$(pane_start_cmd 1 2>/dev/null || true)"
  if [ "$(layout_mode)" != "meet-gallery" ] && [[ "$c1" == *chat-pane* ]] && [[ "$c1" != *GOTCHIBOT_COCKPIT=1* ]]; then
    # Already on OpenCode chat — nothing to do.
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
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-channel 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-meet-channel 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_avatar_mouse 2>/dev/null || true
  # boot_cockpit_desk opens the cockpit pane when GOTCHIBOT_BOOT_COCKPIT=1.
  if [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    :
  elif [ "$to_cockpit" -eq 1 ]; then
    enter_cockpit_panes
  else
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  fi
}

# pstack dossier: sidebar | pstack-window (center, replaces chat) | avatar (right).
# UserDefault's screenshot: CURRENT STATUS should occupy the center pane; avatar stays on the right.
build_pstack_dossier_tiles() {
  collapse_to_three_panes || return 1
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  collapse_sidebar
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true

  # Center pane = pstack-window (dossier replaces chat). Unmark chat so the
  # pane is not treated as the OpenCode chat pane.
  local c1 app
  c1="$(pane_start_cmd 1)"
  app="$(center_script)"
  if [[ "$c1" != *"$app"* ]]; then
    local view="" launch="./scripts/$app.mjs"
    if [ "$app" = "factory-window" ]; then
      view="GOTCHIBOT_FACTORY_VIEW='$(tmux show-options -qv -t "$sess" @gotchibot-factory-view 2>/dev/null || echo tree)' "
      launch="./scripts/factory-window-pane.sh"
    fi
    park_chat_pane || true
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && ${view}exec $launch watch" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.1" @gotchibot-pstack-dossier 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format " #{?pane_active,●, }$(center_label) " 2>/dev/null || true

  # Right pane = avatar (kept, like a normal desk).
  local c2
  c2="$(pane_start_cmd 2)"
  if [[ "$c2" != *avatar-pane* ]]; then
    tmux respawn-pane -t "$sess:work.2" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  mark_avatar_pane

  # Overflow past the desk row only. Pane 8 is kanban, not spare.
  while [ "$(pane_count)" -gt "$DESK_PANE_COUNT" ]; do
    tmux kill-pane -t "$sess:work.$(( $(pane_count) - 1 ))" 2>/dev/null || break
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
  focus_desk pstack
  return 0
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
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    focus_desk cockpit
  else
    focus_desk chat
  fi
  return 0
  local to_cockpit=0
  if [ "${1:-}" = "cockpit" ] || [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    to_cockpit=1
  fi
  if [ "$(layout_mode)" != "pstack-dossier" ]; then
    return 0
  fi
  # Mark normal before respawns so resize hooks don't re-enter pstack-dossier.
  set_layout_mode normal
  tmux set-option -t "$sess" -u @gotchibot-center-app 2>/dev/null || true
  if [ "$(pane_count)" -lt 3 ]; then
    require_three_panes || true
  fi
  collapse_to_three_panes || true
  local restored=0
  unpark_chat_pane && restored=1
  respawn_unless 0 sidebar-pane "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  respawn_unless 2 avatar-pane "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  mark_avatar_pane
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-meet-room 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" -u @gotchibot-pstack-dossier 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  tmux select-pane -t "$sess:work.1" 2>/dev/null || true
  save_layout
  signal_panes
  install_avatar_mouse 2>/dev/null || true
  # boot_cockpit_desk opens the cockpit pane when GOTCHIBOT_BOOT_COCKPIT=1.
  if [ "${GOTCHIBOT_BOOT_COCKPIT:-}" = "1" ]; then
    :
  elif [ "$to_cockpit" -eq 1 ]; then
    enter_cockpit_panes
  elif [ "$restored" -eq 0 ]; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  fi
}


# Leave dossier → normal chat (user desk, no cockpit menu).
leave_pstack_user() {
  focus_desk chat
}

# Leave dossier → orch focus + chat (no cockpit menu).
leave_pstack_orch() {
  (cd "$ROOT" && node ./scripts/agent-focus.mjs orch >/dev/null 2>&1) || true
  focus_desk chat
}

# On screen, left to right. Indexes match that order after arrange_visual_order.
# files · avatar · cockpit · chat · factory · dossier · inbox · meeting · kanban
# Avatar stays open. One of cockpit/chat/factory/dossier/inbox/meeting/kanban is the wide pane.
# Kanban is index 8 so factory(4) dossier(5) inbox(6) meet(7) stay put.
DESK_PANE_COUNT=10

focus_index() {
  case "$1" in
    chat) echo 3 ;;
    avatar) echo 1 ;;
    cockpit) echo 2 ;;
    factory) echo 4 ;;
    pstack) echo 5 ;;
    inbox) echo 6 ;;
    meet) echo 7 ;;
    kanban) echo 8 ;;
    terminal) echo 9 ;;
    *) echo 3 ;;
  esac
}

pane_is_kind() {
  local cmd="$1" kind="$2"
  case "$kind" in
    files) [[ "$cmd" == *sidebar-pane* || "$cmd" == *mc-pane* ]] ;;
    avatar) [[ "$cmd" == *avatar-pane* ]] ;;
    cockpit) [[ "$cmd" == *cockpit-pane* || "$cmd" == *"label-bar-pane.sh Cockpit"* ]] ;;
    chat) [[ "$cmd" == *chat-pane* || "$cmd" == *chat-bar-pane* ]] ;;
    factory) [[ "$cmd" == *factory-window* || "$cmd" == *"label-bar-pane.sh Factory"* ]] ;;
    dossier) [[ "$cmd" == *pstack-window* || "$cmd" == *"label-bar-pane.sh Dossier"* ]] ;;
    inbox) [[ "$cmd" == *inbox-pane* || "$cmd" == *"label-bar-pane.sh Inbox"* ]] ;;
    meet) [[ "$cmd" == *meet-room* || "$cmd" == *"label-bar-pane.sh Meeting"* ]] ;;
    kanban) [[ "$cmd" == *kanban-pane* || "$cmd" == *"label-bar-pane.sh Kanban"* ]] ;;
    terminal) [[ "$cmd" == *terminal-pane* || "$cmd" == *"label-bar-pane.sh Terminal"* ]] ;;
    *) return 1 ;;
  esac
}

# tmux apply widths in pane-index order, so the indexes have to be the screen order.
arrange_visual_order() {
  local -a kinds=(files avatar cockpit chat factory dossier inbox meet kanban terminal)
  local i j kind last
  last=$((DESK_PANE_COUNT - 1))
  for ((i = 0; i <= last; i++)); do
    kind="${kinds[$i]}"
    pane_is_kind "$(pane_start_cmd "$i")" "$kind" && continue
    for ((j = i + 1; j <= last; j++)); do
      if pane_is_kind "$(pane_start_cmd "$j")" "$kind"; then
        tmux swap-pane -d -s "$sess:work.$i" -t "$sess:work.$j" 2>/dev/null || true
        [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
        break
      fi
    done
  done
}

ensure_app_panes() {
  require_three_panes || return 1
  while [ "$(pane_count)" -gt "$DESK_PANE_COUNT" ]; do
    tmux kill-pane -t "$sess:work.$(( $(pane_count) - 1 ))" 2>/dev/null || break
  done
  while [ "$(pane_count)" -lt "$DESK_PANE_COUNT" ]; do
    local last need
    last="$(( $(pane_count) - 1 ))"
    # The last pane is a thin bar. Give it room, then peel the next bar off it
    # so pane indexes stay Files, chat, avatar, then the apps.
    need="$(( chat_collapsed * 2 + 2 ))"
    tmux resize-pane -t "$sess:work.$last" -x "$need" 2>/dev/null || true
    tmux split-window -h -d -t "$sess:work.$last" -l "$chat_collapsed" \
      "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch" || return 1
  done
  # Real apps are placed by place_focus_apps. New panes start as bars.
}

collapse_chat_to_bar() {
  local p
  park_chat_pane || true
  p="$(chat_pane_index)"
  if [[ "$(pane_start_cmd "$p")" != *chat-bar-pane* ]] || \
     [ "$(tmux display -p -t "$sess:work.$p" '#{pane_dead}' 2>/dev/null)" = 1 ]; then
    tmux respawn-pane -t "$sess:work.$p" -k "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch" 2>/dev/null || true
  fi
  tmux set-option -p -t "$sess:work.$p" -u @gotchibot-chat 2>/dev/null || true
}

expand_chat() {
  local p
  p="$(chat_pane_index)"
  if [[ "$(pane_start_cmd "$p")" == *chat-pane* ]] && chat_live; then
    tmux set-option -p -t "$sess:work.$p" @gotchibot-chat 1 2>/dev/null || true
    return 0
  fi
  unpark_chat_pane || \
    tmux respawn-pane -t "$sess:work.$p" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh" 2>/dev/null || true
  tmux set-option -p -t "$sess:work.$p" @gotchibot-chat 1 2>/dev/null || true
}

# resize-pane -x on one cell of a flat row steals from the next cell and
# collapses the others back to 1. A layout string sets every width at once.
layout_checksum() {
  local s="$1" i c ch
  c=0
  for ((i = 0; i < ${#s}; i++)); do
    printf -v ch '%d' "'${s:i:1}"
    c=$(( (c >> 1) + ((c & 1) << 15) ))
    c=$(( (c + ch) & 65535 ))
  done
  printf '%04x' "$c"
}

apply_focus_layout() {
  local -a widths=("$@")
  local ww wh x i w id cell body inner sum idx
  local -a ids
  ww="$(tmux display -p -t "$sess:work" '#{window_width}' 2>/dev/null || echo 0)"
  wh="$(tmux display -p -t "$sess:work" '#{window_height}' 2>/dev/null || echo 0)"
  [ "$ww" -gt 0 ] && [ "$wh" -gt 0 ] || return 1
  while IFS= read -r id; do
    ids+=("${id#%}")
  done < <(tmux list-panes -t "$sess:work" -F '#{pane_index} #{pane_id}' | sort -n | awk '{print $2}')
  [ "${#ids[@]}" -eq "$DESK_PANE_COUNT" ] || return 1
  x=0
  body=""
  for ((i = 0; i < ${#widths[@]}; i++)); do
    w="${widths[$i]}"
    id="${ids[$i]}"
    cell="${w}x${wh},${x},0,${id}"
    if [ -n "$body" ]; then body="${body},"; fi
    body="${body}${cell}"
    x=$((x + w + 1))
  done
  inner="${ww}x${wh},0,0{${body}}"
  sum="$(layout_checksum "$inner")"
  tmux select-layout -t "$sess:work" "${sum},${inner}"
}

# Collapsed app bars are three columns. The word is drawn vertically inside.
label_w_cockpit=3
label_w_factory=3
label_w_dossier=3
label_w_inbox=3
label_w_meet=3
label_w_kanban=3
label_w_terminal=3

# Tool apps (cockpit, factory, dossier, inbox, meeting, kanban) are parked, not
# killed, when another app takes focus: the live pane swaps into a hidden
# session and a label bar takes its slot. Focusing it again swaps it back —
# no cold start, and it keeps its scroll and selection. Chat parks the same way.
apps_park_session() {
  echo "gbapps-$sess_name"
}

ensure_apps_park() {
  local park sid
  park="$(apps_park_session)"
  tmux has-session -t "=$park" 2>/dev/null && return 0
  sid="$(tmux new-session -d -P -F '#{session_id}' -s "$park" -n _keep -x 200 -y 50 "exec tail -f /dev/null" 2>/dev/null)" || return 1
  tmux set-option -t "$sid" base-index 0 2>/dev/null || true
  tmux set-option -t "$sid" window-size manual 2>/dev/null || true
  tmux set-option -t "$sid" remain-on-exit off 2>/dev/null || true
}

# Pane id of the parked app for `kind` whose start command contains `match`.
parked_app_pane() {
  local kind="$1" match="$2" park line name id dead cmd
  park="$(apps_park_session)"
  tmux has-session -t "=$park" 2>/dev/null || return 1
  while IFS=$'\t' read -r name id dead cmd; do
    [ "$name" = "$kind" ] || continue
    if [ "$dead" = 0 ] && [[ "$cmd" == *"$match"* ]]; then
      printf '%s\n' "$id"
      return 0
    fi
  done < <(tmux list-panes -s -t "=$park" -F '#{window_name}	#{pane_id}	#{pane_dead}	#{pane_start_command}' 2>/dev/null)
  return 1
}

drop_parked() {
  local kind="$1" park
  park="$(apps_park_session)"
  while tmux kill-window -t "=$park:$kind" 2>/dev/null; do :; done
}

# Slot idx holds the live app: move it into the park, leave a placeholder.
park_slot_app() {
  local idx="$1" kind="$2" park hold w h
  ensure_apps_park || return 1
  park="$(apps_park_session)"
  drop_parked "$kind"
  w="$(tmux display -p -t "$sess:work" '#{window_width}' 2>/dev/null || echo 200)"
  h="$(tmux display -p -t "$sess:work" '#{window_height}' 2>/dev/null || echo 50)"
  tmux resize-window -t "=$park:_keep" -x "$w" -y "$h" 2>/dev/null || true
  hold="$(tmux new-window -d -P -F '#{pane_id}' -t "=$park:" -n "$kind" "exec tail -f /dev/null" 2>/dev/null)" || return 1
  tmux swap-pane -d -s "$sess:work.$idx" -t "$hold" 2>/dev/null || {
    tmux kill-pane -t "$hold" 2>/dev/null || true
    return 1
  }
}

# Bring the parked app back into slot idx. The bar it replaces is killed.
unpark_slot_app() {
  local idx="$1" kind="$2" match="$3" id park
  id="$(parked_app_pane "$kind" "$match")" || return 1
  park="$(apps_park_session)"
  tmux swap-pane -d -s "$id" -t "$sess:work.$idx" 2>/dev/null || return 1
  tmux kill-window -t "=$park:$kind" 2>/dev/null || true
}

# One tool slot: focused → app (unparked if it is waiting), else a label bar.
place_slot() {
  local idx="$1" kind="$2" focused="$3" match="$4" app_cmd="$5" label="$6" cur
  cur="$(pane_start_cmd "$idx")"
  if [ "$focused" = 1 ]; then
    if [[ "$cur" == *"$match"* ]] && [ "$(pane_dead_flag "$idx")" = 0 ]; then
      return 0
    fi
    if unpark_slot_app "$idx" "$kind" "$match"; then
      [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
      return 0
    fi
    tmux respawn-pane -t "$sess:work.$idx" -k "$app_cmd" 2>/dev/null || true
    [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
    return 0
  fi
  if [[ "$cur" == *"$match"* ]] && [ "$(pane_dead_flag "$idx")" = 0 ] && \
     [ "${GOTCHIBOT_PARK_APPS:-1}" != 0 ] && park_slot_app "$idx" "$kind"; then
    [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
  fi
  respawn_unless "$idx" "label-bar-pane.sh $label" "cd \"$ROOT\" && exec ./scripts/label-bar-pane.sh $label"
}

place_focus_apps() {
  local focus="$1" view
  view="$(tmux show-options -qv -t "$sess" @gotchibot-factory-view 2>/dev/null || true)"
  view="${view:-tree}"
  place_slot 2 cockpit "$([ "$focus" = cockpit ] && echo 1 || echo 0)" cockpit-pane "cd \"$ROOT\" && exec ./scripts/cockpit-pane.sh" Cockpit
  # Factory restarts when its view changed; a parked one in another view is dropped.
  if [ "$focus" = factory ]; then
    local fcur
    fcur="$(pane_start_cmd 4)"
    if [[ "$fcur" == *factory-window* ]] && [[ "$fcur" != *"VIEW='$view'"* ]]; then
      tmux respawn-pane -t "$sess:work.4" -k "cd \"$ROOT\" && exec ./scripts/label-bar-pane.sh Factory" 2>/dev/null || true
      [ "$PANE_CACHE_OK" = 1 ] && pane_cache_load
    fi
    parked_app_pane factory "VIEW='$view'" >/dev/null || drop_parked factory
  fi
  place_slot 4 factory "$([ "$focus" = factory ] && echo 1 || echo 0)" "factory-window" \
    "cd \"$ROOT\" && GOTCHIBOT_FACTORY_VIEW='$view' exec ./scripts/factory-window-pane.sh watch" Factory
  place_slot 5 dossier "$([ "$focus" = pstack ] && echo 1 || echo 0)" pstack-window "cd \"$ROOT\" && exec ./scripts/pstack-window.mjs watch" Dossier
  place_slot 6 inbox "$([ "$focus" = inbox ] && echo 1 || echo 0)" inbox-pane "cd \"$ROOT\" && exec ./scripts/inbox-pane.sh" Inbox
  place_slot 7 meet "$([ "$focus" = meet ] && echo 1 || echo 0)" meet-room-pane "cd \"$ROOT\" && exec ./scripts/meet-room-pane.sh" Meeting
  place_slot 8 kanban "$([ "$focus" = kanban ] && echo 1 || echo 0)" kanban-pane "cd \"$ROOT\" && exec ./scripts/kanban-pane.sh" Kanban
  # Parked like the other apps, so the shell (and its history) survives switches.
  place_slot 9 terminal "$([ "$focus" = terminal ] && echo 1 || echo 0)" terminal-pane "cd \"$ROOT\" && exec ./scripts/terminal-pane.sh" Terminal
}

# Pure widths for one focus at a window width. No tmux.
# Echoes: files avatar cockpit chat factory dossier inbox meet kanban
focus_pane_widths() {
  local focus="$1" win="$2"
  local bar sep content
  local w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 used budget
  local name cur progressed guard
  bar="$chat_collapsed"
  sep=$((DESK_PANE_COUNT - 1))
  content=$((win - sep))
  w0="$bar"
  w1="$min_avatar"
  w2="$label_w_cockpit"
  w3="$bar"
  w4="$label_w_factory"
  w5="$label_w_dossier"
  w6="$label_w_inbox"
  w7="$label_w_meet"
  w8="$label_w_kanban"
  w9="$label_w_terminal"
  case "$focus" in
    # Collapsed label bars stay at label_w (3): one space, the glyph, one space.
    # Do not shrink them to 1. Files stays 3. Avatar is not a donor.
    # The window's extra columns (163 vs 147) all go to the focused pane.
    # Kanban's bar (3) plus its separator (1) come out of that focused pane.
    chat) w3=0 ;;
    avatar) w1=0 ;;
    factory) w4=0 ;;
    pstack|dossier) w5=0 ;;
    inbox) w6=0 ;;
    meet) w7=0 ;;
    cockpit) w2=0 ;;
    kanban) w8=0 ;;
    terminal) w9=0 ;;
    *) w3=0 ;;
  esac
  used=$((w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8 + w9))
  budget=$((content - used))
  # Avatar stays open. If the terminal is tight, shrink the label panes first.
  guard=0
  while [ "$budget" -lt 36 ] && [ "$guard" -lt 40 ]; do
    guard=$((guard + 1))
    progressed=0
    for name in w9 w8 w7 w6 w5 w4 w3 w2; do
      cur="${!name}"
      if [ "$cur" -gt "$bar" ]; then
        printf -v "$name" '%s' "$((cur - 1))"
        budget=$((budget + 1))
        progressed=1
        [ "$budget" -ge 36 ] && break
      fi
    done
    [ "$progressed" -eq 1 ] || break
  done
  [ "$budget" -lt 36 ] && budget=36
  case "$focus" in
    chat) w3="$budget" ;;
    avatar) w1="$budget" ;;
    cockpit) w2="$budget" ;;
    factory) w4="$budget" ;;
    pstack|dossier) w5="$budget" ;;
    inbox) w6="$budget" ;;
    meet) w7="$budget" ;;
    kanban) w8="$budget" ;;
    terminal) w9="$budget" ;;
    *) w3="$budget" ;;
  esac
  printf '%s %s %s %s %s %s %s %s %s %s\n' "$w0" "$w1" "$w2" "$w3" "$w4" "$w5" "$w6" "$w7" "$w8" "$w9"
}

apply_focus_sizes() {
  local focus="$1"
  local win client_w
  apply_window_height
  local w0 w1 w2 w3 w4 w5 w6 w7 w8 w9
  client_w="$(tmux display -p -t "$sess" '#{client_width}' 2>/dev/null || true)"
  client_w="${client_w:-0}"
  win="$(window_width)"
  # Fit the terminal both ways. A wider client grows the desk; a narrower one (zoomed-in
  # text, a smaller window) shrinks it so every app bar stays on screen — the focused
  # pane gives up the columns (focus_pane_widths keeps it >= 36). Only below the floor
  # (all bars + the avatar column + separators + a 36-column focus) does the row clip.
  # client-resized → fit-quiet lands here, so this follows every zoom live.
  local floor want
  floor=$((8 * chat_collapsed + min_avatar + DESK_PANE_COUNT - 1 + 36))
  if [ "$client_w" -gt 0 ] && [ "$client_w" -ne "$win" ]; then
    want="$client_w"
    [ "$want" -lt "$floor" ] && want="$floor"
    if [ "$want" -ne "$win" ]; then
      tmux resize-window -t "$sess:work" -x "$want" 2>/dev/null || true
      win="$want"
    fi
  fi
  # shellcheck disable=SC2162
  read -r w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 <<EOF
$(focus_pane_widths "$focus" "$win")
EOF
  apply_focus_layout "$w0" "$w1" "$w2" "$w3" "$w4" "$w5" "$w6" "$w7" "$w8" "$w9" || true
}

label_desk_panes() {
  refresh_desk_borders
}

# Ctrl+Q / Ctrl+E walk the row. A tool pane opens; Files and Avatar only take the cursor.
pane_kind_of() {
  local cmd
  cmd="$(pane_start_cmd "$1")"
  if pane_is_kind "$cmd" files; then echo files; return; fi
  if pane_is_kind "$cmd" avatar; then echo avatar; return; fi
  if pane_is_kind "$cmd" cockpit; then echo cockpit; return; fi
  if pane_is_kind "$cmd" chat; then echo chat; return; fi
  if pane_is_kind "$cmd" factory; then echo factory; return; fi
  if pane_is_kind "$cmd" dossier; then echo dossier; return; fi
  if pane_is_kind "$cmd" inbox; then echo inbox; return; fi
  if pane_is_kind "$cmd" meet; then echo meet; return; fi
  if pane_is_kind "$cmd" kanban; then echo kanban; return; fi
  if pane_is_kind "$cmd" terminal; then echo terminal; return; fi
  echo other
}

pane_step() {
  local dir="$1" i n active_i target_i idx kind line
  local -a rows=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    rows+=("$line")
  done < <(tmux list-panes -t "$sess:work" -F '#{pane_index} #{pane_left} #{pane_active}' | sort -k2 -n)
  n="${#rows[@]}"
  [ "$n" -gt 0 ] || return 1
  active_i=0
  for i in "${!rows[@]}"; do
    set -- ${rows[$i]}
    [ "${3:-0}" = "1" ] && active_i="$i"
  done
  if [ "$dir" = "left" ]; then
    target_i=$(( (active_i + n - 1) % n ))
  else
    target_i=$(( (active_i + 1) % n ))
  fi
  set -- ${rows[$target_i]}
  idx="$1"
  kind="$(pane_kind_of "$idx")"
  case "$kind" in
    files|other) tmux select-pane -t "$sess:work.$idx" 2>/dev/null || true ;;
    avatar) focus_desk avatar ;;
    cockpit) focus_desk cockpit ;;
    chat) focus_desk chat ;;
    factory) focus_desk factory ;;
    dossier) focus_desk pstack ;;
    inbox) focus_desk inbox ;;
    meet) focus_desk meet ;;
    kanban) focus_desk kanban ;;
    terminal) focus_desk terminal ;;
  esac
}

install_pane_step_keys() {
  local table step stamp
  # 33 bind/set calls: skip when this server already has them for this root.
  stamp="steps-v2:$ROOT:$sess_name"
  if [ "${1:-}" != force ] && [ "$(tmux show-options -gqv @gotchibot-step-keys 2>/dev/null)" = "$stamp" ]; then
    return 0
  fi
  tmux set-option -t "$sess" extended-keys always 2>/dev/null || \
    tmux set-option -t "$sess" extended-keys on 2>/dev/null || true
  # Terminal.app does not emit Ctrl+Shift+Arrow unless the profile sends it.
  # These match the CSI the profile (and iTerm/Ghostty) actually write.
  tmux set -s 'user-keys[20]' "$(printf '\033[1;6D')" 2>/dev/null || true
  tmux set -s 'user-keys[21]' "$(printf '\033[1;6C')" 2>/dev/null || true
  step="cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION='$sess_name' '$ROOT/scripts/orchestrator-layout.sh'"
  # Ctrl+Q / Ctrl+E. Terminal.app does not deliver Ctrl+Shift+Arrow.
  tmux bind-key -n C-q run-shell "$step pane-left" 2>/dev/null || true
  tmux bind-key -n C-e run-shell "$step pane-right" 2>/dev/null || true
  tmux bind-key -n C-S-Left run-shell "$step pane-left" 2>/dev/null || true
  tmux bind-key -n C-S-Right run-shell "$step pane-right" 2>/dev/null || true
  tmux bind-key -n User20 run-shell "$step pane-left" 2>/dev/null || true
  tmux bind-key -n User21 run-shell "$step pane-right" 2>/dev/null || true
  for table in root gotchi-chat gotchi-files gotchi-avatar; do
    tmux bind-key -T "$table" C-q run-shell "$step pane-left" 2>/dev/null || true
    tmux bind-key -T "$table" C-e run-shell "$step pane-right" 2>/dev/null || true
    tmux bind-key -T "$table" C-S-Left run-shell "$step pane-left" 2>/dev/null || true
    tmux bind-key -T "$table" C-S-Right run-shell "$step pane-right" 2>/dev/null || true
    tmux bind-key -T "$table" User20 run-shell "$step pane-left" 2>/dev/null || true
    tmux bind-key -T "$table" User21 run-shell "$step pane-right" 2>/dev/null || true
  done
  # A desk booted before the revive hook existed gets it on its first switch.
  install_revive_hook
  tmux set-option -g @gotchibot-step-keys "$stamp" 2>/dev/null || true
}

# Widen one app. The others stay as panes, collapsed to bars. Chat is parked, not killed.
focus_desk() {
  local focus="$1" idx view
  session_exists || return 1
  ensure_app_panes || return 1
  pane_cache_load
  arrange_visual_order
  # Files and avatar have no focus state of their own; bring them back if they died.
  if [ "$(pane_dead_flag 0)" = 1 ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  fi
  if [ "$(pane_dead_flag 1)" = 1 ]; then
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch" 2>/dev/null || true
    tmux set-option -p -t "$sess:work.1" @gotchibot-avatar 1 2>/dev/null || true
    pane_cache_load
  fi
  place_focus_apps "$focus"
  # Chat park/unpark swaps panes outside this cache's bookkeeping.
  pane_cache_drop
  if [ "$focus" = "chat" ]; then
    expand_chat
  else
    collapse_chat_to_bar
  fi
  apply_focus_sizes "$focus"
  label_desk_panes
  set_layout_mode "$focus"
  idx="$(focus_index "$focus")"
  tmux select-pane -t "$sess:work.$idx" 2>/dev/null || true
  install_pane_step_keys
  save_layout
}

apply_cockpit_sizes() {
  apply_focus_sizes cockpit
}

enter_cockpit_panes() {
  focus_desk cockpit
}

leave_cockpit_desk() {
  focus_desk chat
}

boot_cockpit_desk() {
  session_exists || return 1
  apply_window_policy
  focus_desk cockpit
}

# Pane-max keys (Ctrl+B / Ctrl+F / Ctrl+A) step out of the pstack/Factory center
# instead of refusing; the caller respawns work.1, so skip the cockpit respawn.
leave_dossier_for_max() {
  [ "$(layout_mode)" = "pstack-dossier" ] || return 0
  GOTCHIBOT_BOOT_COCKPIT=1 leave_pstack_dossier
}

# Files take remaining width; chat collapses to a thin Gotchi bar; avatar stays.
enter_files_max() {
  leave_dossier_for_max
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
  park_chat_pane || true
  respawn_unless 1 chat-bar-pane "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  apply_files_max_sizes
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files · full ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
  set_layout_mode files-max
  tmux select-pane -t "$sess:work.0"
  save_layout
  signal_panes
}

# Avatar takes remaining width; chat → bar; files stay collapsed.
enter_avatar_max() {
  leave_dossier_for_max
  if ! guard_special_modes; then return 1; fi
  require_three_panes || return 1
  if [ "$(layout_mode)" = "files-max" ]; then
    tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
    collapse_sidebar
  fi
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  collapse_sidebar
  apply_avatar_max_sizes
  park_chat_pane || true
  respawn_unless 1 chat-bar-pane "cd \"$ROOT\" && exec ./scripts/chat-bar-pane.sh watch"
  tmux set-option -p -t "$sess:work.1" -u @gotchibot-chat 2>/dev/null || true
  respawn_unless 2 avatar-pane "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_avatar_max_sizes
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar · full ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  set_layout_mode avatar-max
  tmux select-pane -t "$sess:work.2"
  save_layout
  signal_panes
}

enter_chat_max() {
  leave_dossier_for_max
  if ! guard_special_modes; then return 1; fi
  require_three_panes || return 1
  respawn_unless 0 sidebar-pane "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  unpark_chat_pane || chat_live || \
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh"
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  respawn_unless 2 avatar-pane "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  apply_chat_max_sizes
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi · full ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  if [ "$(layout_mode)" = "cockpit" ]; then
    leave_cockpit_desk
    return
  fi
  if [ "$(layout_mode)" = "meet-gallery" ]; then
    leave_meet_gallery
    return
  fi
  if [ "$(layout_mode)" = "pstack-dossier" ]; then
    leave_pstack_dossier
    return
  fi
  layout_ready || return 1
  respawn_unless 0 sidebar-pane "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch"
  unpark_chat_pane || chat_live || \
    tmux respawn-pane -t "$sess:work.1" -k "cd \"$ROOT\" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 exec ./scripts/chat-pane.sh"
  tmux set-option -p -t "$sess:work.1" @gotchibot-chat 1 2>/dev/null || true
  respawn_unless 2 avatar-pane "cd \"$ROOT\" && exec ./scripts/avatar-pane.sh watch"
  collapse_sidebar
  apply_pane_sizes
  tmux set-option -p -t "$sess:work.0" pane-border-format ' #{?pane_active,●, }Files ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.1" pane-border-format ' #{?pane_active,●, }Gotchi ' 2>/dev/null || true
  tmux set-option -p -t "$sess:work.2" pane-border-format ' #{?pane_active,●, }Avatar ' 2>/dev/null || true
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
  if [ "$(layout_mode)" = "files-max" ] || [ "$(layout_mode)" = "avatar-max" ] || [ "$(layout_mode)" = "cockpit" ]; then
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

# A drag on the chat/avatar border fires client-resized, and re-applying the max
# layout snaps the border back, which fires the hook again. Each pass queues
# dozens of tmux commands, so a few drags stall the server and the desk freezes.
# On a resize, only fix a pane that collapsed; leave a width the user dragged.
fit_max_keep_drag() {
  local side="$1" floor="$2" w
  w="$(tmux display -p -t "$sess:work.$side" '#{pane_width}' 2>/dev/null || echo 0)"
  [ "$w" -ge "$floor" ] && return 0
  case "$(layout_mode)" in
    files-max) apply_files_max_sizes ;;
    avatar-max) apply_avatar_max_sizes ;;
    cockpit) apply_cockpit_sizes ;;
    chat-max) apply_chat_max_sizes ;;
  esac
}

fit_quiet() {
  case "$(layout_mode)" in
    cockpit|factory|pstack|meet|chat|inbox|kanban|avatar)
      apply_focus_sizes "$(layout_mode)"
      return 0
      ;;
  esac
  if [ "$(layout_mode)" = "files-max" ]; then
    fit_max_keep_drag 0 20
    return 0
  fi
  if [ "$(layout_mode)" = "avatar-max" ] || [ "$(layout_mode)" = "cockpit" ]; then
    fit_max_keep_drag 2 40
    return 0
  fi
  if [ "$(layout_mode)" = "chat-max" ]; then
    fit_max_keep_drag 1 20
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
  apply_window_height
  tmux resize-window -t "$sess" -x "$win_w_default" -y "$(desk_window_height || echo "$win_h_default")" 2>/dev/null || true
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
  # Ctrl+A / Ctrl+B / Ctrl+W used to enter avatar-max, chat-max, and the factory
  # toggle. Those resize the old 3-pane layout and break the 9-pane desk.
  # Leave them unbound so the focused pane receives them. Prefix stays Ctrl+Space.
  # Alt+A/B/W and prefix a/b still reach the old maximizers.
  tmux unbind-key -T "$table" C-a 2>/dev/null || true
  tmux unbind-key -T "$table" C-b 2>/dev/null || true
  tmux unbind-key -T "$table" C-w 2>/dev/null || true
  tmux bind-key -T "$table" C-f run-shell "$layout_run enter-files-max" 2>/dev/null || true
  tmux bind-key -T "$table" C-g run-shell "$layout_run show-avatar" 2>/dev/null || true
  tmux bind-key -T "$table" M-w run-shell -b "$layout_run toggle-factory" 2>/dev/null || true
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
  # Prefix is Ctrl+Space, not Ctrl+B. No second prefix, so a tmux.conf prefix2 of
  # Ctrl+A cannot eat Ctrl+A. Ctrl+A/B/W are unbound in install_layout_keys.
  tmux set-option -t "$sess" prefix C-Space 2>/dev/null || true
  tmux set-option -t "$sess" -u prefix2 2>/dev/null || true
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
  # Layout — Ctrl+F files · Ctrl+G show avatar. Ctrl+A/B/W are not bound (they
  # broke the 9-pane row). Fallback: Alt+F/A/G/B/W · F6 show avatar · F7 avatar-max
  # · prefix Ctrl+Space then f/a/b. Dossier/inbox/meet: Ctrl+Space then Shift+D/I/M.
  # Avatar roster page (any pane): Ctrl+Space then P/N · Alt+, / Alt+.
  install_layout_keys root
  install_layout_keys gotchi-chat
  install_layout_keys gotchi-files
  install_layout_keys gotchi-avatar
  install_pane_step_keys force
  # Mouse off. Keyboard still pages the avatar roster.
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
  # Keyboard avatar paging (also installed from install_*_mouse for relayout).
  install_avatar_page_keys
  # Orchestrator focus — F3 / prefix o / Option+O
  tmux bind-key -T gotchi-chat F3 run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T prefix o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  tmux bind-key -T root M-o run-shell "cd \"$ROOT\" && ./scripts/gotchibot orch" 2>/dev/null || true
  # Ctrl+C → confirm, then quit whole desk (back to terminal). Session-scoped so
  # other tmux sessions still get a normal interrupt. Intercepts before OpenCode
  # sees C-c; a reflex Ctrl+C on a slow agent turn must not kill the desk.
  local quit_sh="$ROOT/scripts/desk-quit.sh"
  chmod +x "$quit_sh" 2>/dev/null || true
  local quit_run="GOTCHIBOT_TMUX_SESSION='$sess_name' '$quit_sh'"
  local quit_confirm="confirm-before -p 'Quit GotchiBot desk? (y/n)' \"run-shell \\\"$quit_run\\\"\""
  tmux bind-key -n C-c if-shell -F "#{==:#{session_name},$sess_name}" "$quit_confirm" "send-keys C-c" 2>/dev/null || true
  for _qt in root gotchi-chat gotchi-files gotchi-avatar; do
    tmux bind-key -T "$_qt" C-c if-shell -F "#{==:#{session_name},$sess_name}" "$quit_confirm" "send-keys C-c" 2>/dev/null || true
  done
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
  # Mouse off for the desk. Wheel scroll flooded pane scripts and crashed panes.
  # Keyboard j/k and arrows still scroll. This file turns tmux mouse off.
  tmux set-option -g mouse off 2>/dev/null || true
  tmux set-option -t "$sess" mouse off 2>/dev/null || true
  tmux set-option -t "$sess" set-clipboard on 2>/dev/null || true
  # Let OSC 52 from OpenClaw TUI (/copy) reach Terminal/iTerm pasteboard.
  tmux set-option -g allow-passthrough on 2>/dev/null || true
  tmux set-option -t "$sess" allow-passthrough on 2>/dev/null || true
  # Apple Terminal drops OSC 52: route tmux copies through pbcopy on a local Mac.
  if [ "$(uname -s)" = "Darwin" ] && [ -z "${SSH_CONNECTION:-}" ] && [ -x /usr/bin/pbcopy ]; then
    tmux set-option -s copy-command /usr/bin/pbcopy 2>/dev/null || true
    nohup "$ROOT/scripts/tmux-clipboard-bridge.sh" "$sess" >/dev/null 2>&1 &
  fi
  install_avatar_mouse
  # Truecolor for Gotchi message backgrounds (chalk bgHex needs Tc/RGB in tmux).
  # Append idempotently — bare set-option -g terminal-overrides replaces the whole list.
  install_truecolor_terminal
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

# Idempotent truecolor: terminal-features RGB (tmux >= 3.2) + terminal-overrides Tc fallback.
# Do NOT add linux / vt* / screen* / blanket *:RGB — Linux console cannot do truecolor.
install_truecolor_terminal() {
  local tf to pat ver major minor
  ver="$(tmux -V 2>/dev/null | tr -cd '0-9.' || true)"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac

  if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 2 ]; }; then
    tf="$(tmux show-options -s terminal-features 2>/dev/null || true)"
    for pat in xterm-256color tmux-256color '*-direct' xterm-kitty alacritty 'foot*' xterm-ghostty wezterm; do
      case "$tf" in
        *"${pat}:RGB"*) ;;
        *)
          tmux set-option -sa terminal-features ",${pat}:RGB" 2>/dev/null || true
          tf="$(tmux show-options -s terminal-features 2>/dev/null || true)"
          ;;
      esac
    done
  fi

  to="$(tmux show-options -g terminal-overrides 2>/dev/null || true)"
  for pat in xterm-256color tmux-256color; do
    case "$to" in
      *"${pat}:Tc"*) ;;
      *)
        tmux set-option -ga terminal-overrides ",${pat}:Tc" 2>/dev/null || true
        to="$(tmux show-options -g terminal-overrides 2>/dev/null || true)"
        ;;
    esac
  done
}

# Mode-aware titles from sessions/.desk-active.line so every pane names the
# same gotchi and workflow. Active pane gets a ●.
apply_pane_border_labels() {
  refresh_desk_borders
}

install_resize_hook() {
  [ "${GOTCHIBOT_RESIZE_HOOK:-0}" = 1 ] || return 0
  tmux set-hook -t "$sess" client-resized "run-shell '$resize_hook'"
}

disable_resize_hook() {
  tmux set-hook -t "$sess" client-resized "" 2>/dev/null || true
}

finish_ensure() {
  signal_panes
  # Always boot with Files collapsed to a bar, then the full row.
  tmux respawn-pane -t "$sess:work.0" -k "cd \"$ROOT\" && exec ./scripts/sidebar-pane.sh watch" 2>/dev/null || true
  collapse_sidebar
  install_ui_theme
  install_resize_hook
  focus_desk cockpit
}

cmd="${1:-ensure}"
# Width math only. Must not touch tmux (no session lookup, no resize).
if [ "$cmd" = "sizes" ]; then
  win="${2:-}"
  focus="${3:-chat}"
  case "$win" in
    ''|*[!0-9]*) echo "usage: orchestrator-layout.sh sizes <width> [focus]" >&2; exit 2 ;;
  esac
  # shellcheck disable=SC2162
  read -r w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 <<EOF
$(focus_pane_widths "$focus" "$win")
EOF
  sum=$((w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8 + w9))
  printf 'files=%s avatar=%s cockpit=%s chat=%s factory=%s dossier=%s inbox=%s meet=%s kanban=%s terminal=%s sum=%s\n' \
    "$w0" "$w1" "$w2" "$w3" "$w4" "$w5" "$w6" "$w7" "$w8" "$w9" "$sum"
  exit 0
fi
# Client lines → window rows. No tmux.
if [ "$cmd" = "canvas-height" ]; then
  client="${2:-}"
  case "$client" in
    ''|*[!0-9]*) echo "usage: orchestrator-layout.sh canvas-height <client-lines>" >&2; exit 2 ;;
  esac
  canvas_height_for_client "$client"
  exit 0
fi
# Before any work.N lookup: the side-pane check below and paths that never reach
# apply_window_policy (refresh-soft, sidebar, enter-*-max, fit, …) all resolve indices.
own_pane_numbering
layout_safe_reexec "$cmd" ${2:+"$2"}
trap layout_unlock EXIT
# Absolute focus requests coalesce (latest wins); everything else queues in order.
case "$cmd" in
  enter-cockpit|boot-cockpit|enter-inbox|inbox|enter-kanban|kanban|enter-terminal|terminal|toggle-*|enter-factory|factory|enter-pstack-dossier|pstack-dossier|leave-*)
    layout_lock latest ;;
  *)
    layout_lock ;;
esac

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
    if nine_pane_desk; then
      focus_desk "$(desk_focus_from_mode)"
    elif [ "$(layout_mode)" = "meet-gallery" ]; then
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
    if nine_pane_desk; then
      focus_desk "$(desk_focus_from_mode)"
      exit 0
    fi
    if [ "$(layout_mode)" = "meet-gallery" ] || [ "$(layout_mode)" = "pstack-dossier" ] || [ "$(layout_mode)" = "cockpit" ]; then
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
  focus-avatar)
    focus_desk avatar
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
    tmux set-option -t "$sess" -u @gotchibot-center-app 2>/dev/null || true
    enter_pstack_dossier
    ;;
  enter-factory|factory)
    # Optional view: tree (default) | factory (bots) | hub | infra | graph (agent handoffs).
    tmux set-option -t "$sess" @gotchibot-center-app factory 2>/dev/null || true
    tmux set-option -t "$sess" @gotchibot-factory-view "${2:-tree}" 2>/dev/null || true
    focus_desk factory
    ;;
  toggle-factory)
    if [ "$(layout_mode)" = "factory" ]; then
      focus_desk chat
    else
      tmux set-option -t "$sess" @gotchibot-center-app factory 2>/dev/null || true
      tmux set-option -t "$sess" @gotchibot-factory-view tree 2>/dev/null || true
      focus_desk factory
    fi
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
  leave-pstack-user)
    leave_pstack_user
    ;;
  leave-pstack-orch)
    leave_pstack_orch
    ;;
  enter-cockpit|boot-cockpit)
    boot_cockpit_desk
    ;;
  enter-inbox|inbox)
    focus_desk inbox
    ;;
  toggle-inbox)
    if [ "$(layout_mode)" = "inbox" ]; then
      focus_desk chat
    else
      focus_desk inbox
    fi
    ;;
  toggle-dossier)
    if [ "$(layout_mode)" = "pstack" ]; then
      focus_desk chat
    else
      focus_desk pstack
    fi
    ;;
  toggle-meet)
    if [ "$(layout_mode)" = "meet" ]; then
      focus_desk chat
    else
      focus_desk meet
    fi
    ;;
  leave-inbox)
    focus_desk chat
    ;;
  enter-kanban|kanban)
    focus_desk kanban
    ;;
  enter-terminal|terminal)
    focus_desk terminal
    ;;
  toggle-terminal)
    if [ "$(layout_mode)" = "terminal" ]; then
      focus_desk chat
    else
      focus_desk terminal
    fi
    ;;
  root-shell)
    # Ctrl+Space R: focus the Terminal and start scripts/root-shell.sh in it.
    focus_desk terminal
    tmux send-keys -t "$sess:work.$(focus_index terminal)" C-u "./scripts/root-shell.sh" Enter 2>/dev/null || true
    ;;
  toggle-kanban)
    if [ "$(layout_mode)" = "kanban" ]; then
      focus_desk cockpit
    else
      focus_desk kanban
    fi
    ;;
  leave-kanban)
    focus_desk cockpit
    ;;
  leave-kanban-chat)
    focus_desk chat
    ;;
  pane-left)
    pane_step left
    ;;
  pane-right)
    pane_step right
    ;;
  leave-cockpit)
    leave_cockpit_desk
    ;;
  revive)
    # pane-died hook. Re-apply the current focus (respawns dead slots) and put
    # the cursor back where it was. At most once per 5s so a crash loop idles.
    nine_pane_desk || exit 0
    now="$(date +%s)"
    last="$(cat "$ROOT/sessions/.layout-revive" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    [ $((now - last)) -lt 5 ] && exit 0
    printf '%s\n' "$now" > "$ROOT/sessions/.layout-revive"
    was="$(tmux display -p -t "$sess:work" '#{pane_id}' 2>/dev/null || true)"
    focus_desk "$(desk_focus_from_mode)"
    [ -n "$was" ] && tmux select-pane -t "$was" 2>/dev/null || true
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
    echo "usage: orchestrator-layout.sh [ensure|refresh|refresh-soft|fit-quiet|sidebar|files-max|enter-files-max|show-avatar|avatar-max|enter-avatar-max|chat-max|enter-chat-max|enter-meet-gallery|refresh-meet-gallery|leave-meet-gallery|leave-meet-cockpit|enter-pstack-dossier|enter-factory [tree|factory|hub|infra]|toggle-factory|refresh-pstack-dossier|leave-pstack-dossier|leave-pstack-cockpit|leave-pstack-user|leave-pstack-orch|enter-cockpit|boot-cockpit|enter-inbox|toggle-inbox|leave-inbox|toggle-dossier|toggle-meet|enter-kanban|toggle-kanban|leave-kanban|leave-kanban-chat|require-three|fit|install-mouse|sizes <width> [focus]]" >&2
    exit 2
    ;;
esac
