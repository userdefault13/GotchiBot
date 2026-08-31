#!/usr/bin/env bash
# Adjust # meet channel scroll offset and wake the pane.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
SCROLL_FILE="$SESSIONS/.meet-channel-scroll"
STEP="${GOTCHIBOT_MEET_CHANNEL_SCROLL_STEP:-4}"
ACTION="${1:-up}"

mkdir -p "$SESSIONS"

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
  local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  if [ -n "${TMUX:-}" ] && tmux display -p -t "${sess}:work.2" '#{pane_width}x#{pane_height}' 2>/dev/null | grep -q 'x'; then
    tmux display -p -t "${sess}:work.2" '#{pane_width}x#{pane_height}' 2>/dev/null
    return
  fi
  echo "52x30"
}

max_scroll() {
  local dims cols rows
  dims="$(pane_dims)"
  cols="${dims%x*}"
  rows="${dims#*x}"
  node -e "
    import { maxScrollFromBottom } from './scripts/meet-channel.mjs';
    process.stdout.write(String(maxScrollFromBottom({ cols: ${cols:-52}, rows: ${rows:-30} })));
  " 2>/dev/null || echo 0
}

clamp_scroll() {
  local s="$1" max
  max="$(max_scroll)"
  [ "$s" -lt 0 ] && s=0
  [ "$s" -gt "$max" ] && s="$max"
  echo "$s"
}

cur="$(load_scroll)"
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
    save_scroll "$(max_scroll)"
    ;;
  *)
    echo "usage: meet-channel-scroll.sh up|down|bottom|top" >&2
    exit 1
    ;;
esac

date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.meet-channel.stamp" 2>/dev/null || true
if command -v pgrep >/dev/null 2>&1; then
  pgrep -f 'meet-channel-pane.sh' 2>/dev/null | while read -r p; do
    kill -USR1 "$p" 2>/dev/null || true
  done
fi
