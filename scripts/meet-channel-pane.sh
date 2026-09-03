#!/usr/bin/env bash
# iMessage-style meet channel — long-lived smooth scroller (node --live).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
SCROLL_FILE="$SESSIONS/.meet-channel-scroll"

mkdir -p "$SESSIONS"
printf '%s\n' 0 > "$SCROLL_FILE"

mark_self() {
  [ -n "${TMUX:-}" ] || return 0
  local tgt="${TMUX_PANE:-}"
  [ -n "$tgt" ] || return 0
  tmux set-option -p -t "$tgt" @gotchibot-meet-channel 1 2>/dev/null || true
  tmux set-option -p -t "$tgt" pane-border-format ' # meet ' 2>/dev/null || true
  tmux set-option -p -t "$tgt" history-limit 0 2>/dev/null || true
  tmux set-option -p -t "$tgt" pane-scrollbars off 2>/dev/null || true
}

mark_self
# One long-lived process: warm thumb cache, scroll = re-slice only (no spawn storm).
exec node "$ROOT/scripts/meet-channel.mjs" --live
