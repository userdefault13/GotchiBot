#!/usr/bin/env bash
# Adjust # meet channel scroll offset and wake the pane.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
SCROLL_FILE="$SESSIONS/.meet-channel-scroll"
STEP="${GOTCHIBOT_MEET_CHANNEL_SCROLL_STEP:-3}"
ACTION="${1:-up}"

mkdir -p "$SESSIONS"
cd "$ROOT"

load_scroll() {
  if [ -f "$SCROLL_FILE" ]; then
    tr -d '[:space:]' < "$SCROLL_FILE"
  else
    echo 0
  fi
}

save_scroll() {
  printf '%s\n' "${1:-0}" > "$SCROLL_FILE"
}

pane_dims() {
  local sess_name="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  sess_name="${sess_name#=}"
  local sess="=${sess_name}"
  if [ -n "${TMUX:-}" ] && tmux display -p -t "${sess}:work.2" '#{pane_width}x#{pane_height}' 2>/dev/null | grep -q 'x'; then
    tmux display -p -t "${sess}:work.2" '#{pane_width}x#{pane_height}' 2>/dev/null
    return
  fi
  # Mouse-wheel run-shell: prefer the pane under the cursor.
  if [ -n "${TMUX:-}" ]; then
    local d
    d="$(tmux display -p -t '{mouse}' '#{pane_width}x#{pane_height}' 2>/dev/null || true)"
    if echo "$d" | grep -q 'x'; then
      echo "$d"
      return
    fi
  fi
  echo "52x30"
}

max_scroll() {
  local dims cols rows
  dims="$(pane_dims)"
  cols="${dims%x*}"
  rows="${dims#*x}"
  cols="${cols:-52}"
  rows="${rows:-30}"
  node --input-type=module -e "
    import { maxScrollFromBottom } from './scripts/meet-channel.mjs';
    process.stdout.write(String(maxScrollFromBottom({ cols: ${cols}, rows: ${rows} })));
  " 2>/dev/null || echo 0
}

clamp_scroll() {
  local s="$1" max
  max="$(max_scroll)"
  case "$max" in ''|*[!0-9]*) max=0 ;; esac
  case "$s" in ''|*[!0-9-]*) s=0 ;; esac
  [ "$s" -lt 0 ] && s=0
  [ "$s" -gt "$max" ] && s="$max"
  echo "$s"
}

cur="$(load_scroll)"
case "$cur" in ''|*[!0-9]*) cur=0 ;; esac

case "$ACTION" in
  up|older)
    cur=$((cur + STEP))
    save_scroll "$(clamp_scroll "$cur")"
    ;;
  down|newer)
    cur=$((cur - STEP))
    [ "$cur" -lt 0 ] && cur=0
    save_scroll "$cur"
    ;;
  bottom|end|latest)
    save_scroll 0
    ;;
  top|home|oldest)
    save_scroll "$(clamp_scroll "$(max_scroll)")"
    ;;
  page-up)
    cur=$((cur + STEP * 3))
    save_scroll "$(clamp_scroll "$cur")"
    ;;
  page-down)
    cur=$((cur - STEP * 3))
    [ "$cur" -lt 0 ] && cur=0
    save_scroll "$cur"
    ;;
  *)
    echo "usage: meet-channel-scroll.sh up|down|bottom|top|page-up|page-down" >&2
    exit 1
    ;;
esac

date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.meet-channel.stamp" 2>/dev/null || true
# Quiet by default: live pane watches the scroll file. USR1 only if forced.
if [ "${GOTCHIBOT_SCROLL_POKE:-0}" = "1" ] && command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'meet-channel.mjs --live' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done
  pgrep -f 'meet-channel-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done
fi
