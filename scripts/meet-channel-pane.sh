#!/usr/bin/env bash
# iMessage-style meet channel — scrollable transcript + thumbnail avatars.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
STAMP="$SESSIONS/.meet-channel.stamp"
SCROLL_FILE="$SESSIONS/.meet-channel-scroll"
PENDING_FILE="$SESSIONS/.meet-pending.json"
# macOS /bin/bash 3.2: `read -t` only accepts integers. Fractional timeouts
# error immediately → busy-loop + full channel re-render (pane looks crashed).
POLL="${GOTCHIBOT_MEET_CHANNEL_POLL:-1}"
case "$POLL" in
  ''|*[!0-9]*) POLL=1 ;;
esac
[ "$POLL" -lt 1 ] && POLL=1

alt_enter() { printf '\033[?1049h\033[?7l\033[?25l'; }
alt_leave() { printf '\033[?25h\033[?7h\033[?1049l'; }

mark_self() {
  [ -n "${TMUX:-}" ] || return 0
  local tgt="${TMUX_PANE:-}"
  [ -n "$tgt" ] || return 0
  tmux set-option -p -t "$tgt" @gotchibot-meet-channel 1 2>/dev/null || true
  tmux set-option -p -t "$tgt" pane-border-format ' # meet ' 2>/dev/null || true
  tmux set-option -p -t "$tgt" history-limit 0 2>/dev/null || true
  tmux set-option -p -t "$tgt" pane-scrollbars off 2>/dev/null || true
}

pane_width() {
  if [ -n "${TMUX:-}" ]; then
    local w tgt="${TMUX_PANE:-}"
    w="$(tmux display -p ${tgt:+-t "$tgt"} '#{pane_width}' 2>/dev/null || true)"
    [ -n "$w" ] && [ "$w" -gt 0 ] && echo "$w" && return
  fi
  tput cols 2>/dev/null || echo 52
}

pane_height() {
  if [ -n "${TMUX:-}" ]; then
    local h tgt="${TMUX_PANE:-}"
    h="$(tmux display -p ${tgt:+-t "$tgt"} '#{pane_height}' 2>/dev/null || true)"
    [ -n "$h" ] && [ "$h" -gt 0 ] && echo "$h" && return
  fi
  tput lines 2>/dev/null || echo 24
}

load_scroll() {
  if [ -f "$SCROLL_FILE" ]; then
    tr -d '[:space:]' < "$SCROLL_FILE"
  else
    echo 0
  fi
}

render_once() {
  local cols rows scroll
  cols="$(pane_width)"
  rows="$(pane_height)"
  scroll="$(load_scroll)"
  printf '\033[H\033[J'
  node "$ROOT/scripts/meet-channel.mjs" --render --cols "$cols" --rows "$rows" --scroll "$scroll" 2>/dev/null || true
}

# Drop sticky pending once the user line is already in the transcript (send finished
# but prompter died before clearPending).
clear_stale_pending() {
  [ -f "$PENDING_FILE" ] || return 0
  node -e "
    import { readFileSync, unlinkSync, existsSync } from 'node:fs';
    const root = process.argv[1];
    const pendingPath = root + '/sessions/.meet-pending.json';
    try {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
      if (!pending?.text) { unlinkSync(pendingPath); process.exit(0); }
      const cur = (readFileSync(root + '/sessions/meetings/.current', 'utf8') || '').trim();
      if (!cur) { unlinkSync(pendingPath); process.exit(0); }
      const tr = root + '/sessions/meetings/' + cur + '/transcript.jsonl';
      if (!existsSync(tr)) process.exit(0);
      const lines = readFileSync(tr, 'utf8').split('\\n').filter(Boolean);
      const hit = lines.some((l) => {
        try {
          const o = JSON.parse(l);
          return o.role === 'user' && o.text === pending.text;
        } catch { return false; }
      });
      if (hit) unlinkSync(pendingPath);
    } catch { /* keep pending */ }
  " "$ROOT" 2>/dev/null || true
}

scroll_via_script() {
  "$ROOT/scripts/meet-channel-scroll.sh" "$1" 2>/dev/null || true
  render_once
}

read_seq_char() {
  local ch=""
  if ! read -rsn1 -t 1 ch; then
    return 1
  fi
  REPLY="$ch"
}

handle_esc() {
  local ch="" acc=""
  if ! read_seq_char; then
    return 1
  fi
  ch="$REPLY"
  if [ "$ch" = "[" ]; then
    if ! read_seq_char; then
      return 1
    fi
    ch="$REPLY"
    acc="$ch"
    while ! [[ "$acc" =~ [A-Za-z~] ]]; do
      if ! read_seq_char; then
        break
      fi
      acc="${acc}${REPLY}"
    done
    case "$acc" in
      A|*A) scroll_via_script up; return 0 ;;
      B|*B) scroll_via_script down; return 0 ;;
      5~|*5~) scroll_via_script up; return 0 ;;
      6~|*6~) scroll_via_script down; return 0 ;;
      H|*H|1~|7~) scroll_via_script top; return 0 ;;
      F|*F|4~|8~) scroll_via_script bottom; return 0 ;;
    esac
    return 1
  fi
  if [ "$ch" = "O" ]; then
    if ! read_seq_char; then
      return 1
    fi
    case "$REPLY" in
      A) scroll_via_script up; return 0 ;;
      B) scroll_via_script down; return 0 ;;
      H) scroll_via_script top; return 0 ;;
      F) scroll_via_script bottom; return 0 ;;
    esac
    return 1
  fi
  return 1
}

handle_key() {
  local key="$1"
  case "$key" in
    $'\x1b') handle_esc; return $? ;;
    k|K|h|H|'[') scroll_via_script up; return 0 ;;
    j|J|l|L|']') scroll_via_script down; return 0 ;;
    g|G) scroll_via_script top; return 0 ;;
    $'\x04') scroll_via_script bottom; return 0 ;;
  esac
  return 1
}

rendering=0
on_usr1() {
  # Nested USR1 during node render blanks / storms the pane.
  [ "$rendering" = "1" ] && return 0
  rendering=1
  render_once
  rendering=0
}

trap 'alt_leave' EXIT
trap on_usr1 USR1

alt_enter
mark_self
printf '%s\n' 0 > "$SCROLL_FILE"
clear_stale_pending

rendering=1
render_once
rendering=0
last_stamp="$(cat "$STAMP" 2>/dev/null || true)"
last_pending_draw=0
while true; do
  if [ -f "$PENDING_FILE" ]; then
    clear_stale_pending
  fi
  cur="$(cat "$STAMP" 2>/dev/null || true)"
  need=0
  if [ "$cur" != "$last_stamp" ]; then
    need=1
    last_stamp="$cur"
  elif [ -f "$PENDING_FILE" ]; then
    # Animate "sending…" at ~1Hz — never spin-render while pending.
    now="$(date +%s 2>/dev/null || echo 0)"
    if [ $((now - last_pending_draw)) -ge 1 ]; then
      need=1
      last_pending_draw="$now"
    fi
  fi
  if [ "$need" = "1" ]; then
    rendering=1
    render_once
    rendering=0
  fi
  if read -rsn1 -t "$POLL" key 2>/dev/null; then
    handle_key "$key" || true
  fi
done
