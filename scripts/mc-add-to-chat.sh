#!/usr/bin/env bash
# Inject selected path(s) into the Gotchi OpenCode chat as @mentions.
# Used by Midnight Commander user menu (F2 → Add to Gotchi chat).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESS="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"

if [ $# -lt 1 ]; then
  echo "usage: mc-add-to-chat.sh <path> [path…]" >&2
  exit 2
fi

# If chat is collapsed (files-max / avatar-max), restore so OpenCode can receive keys.
mode="$(tr -d '[:space:]' < "$ROOT/sessions/.layout-mode" 2>/dev/null || echo normal)"
if [ "$mode" = "files-max" ] || [ "$mode" = "avatar-max" ]; then
  # Via tmux server — never run layout as a child of the files/chat pane.
  tmux run-shell -t "$SESS:work.0" \
    "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$SESS\" \"$ROOT/scripts/orchestrator-layout.sh\" $mode" \
    >/dev/null 2>&1 || true
fi

tmux has-session -t "$SESS" 2>/dev/null || {
  echo "no tmux session '$SESS' — start with: ./scripts/gotchibot tmux" >&2
  exit 1
}

# Ensure OpenCode chat pane is focused and can accept input.
tmux select-pane -t "$SESS:work.1" 2>/dev/null || true

mentions=()
for raw in "$@"; do
  [ -z "$raw" ] && continue
  # mc may pass "dir/file" already; normalize
  if [ -e "$raw" ]; then
    abs="$(cd "$(dirname "$raw")" && pwd)/$(basename "$raw")"
  else
    abs="$raw"
  fi
  case "$abs" in
    "$ROOT"/*) rel="${abs#"$ROOT"/}" ;;
    *) rel="$abs" ;;
  esac
  mentions+=("@${rel}")
done

[ ${#mentions[@]} -gt 0 ] || exit 0

# Type into OpenCode prompt (literal, no interpretation of - etc.)
payload="$(printf '%s ' "${mentions[@]}")"
tmux send-keys -t "$SESS:work.1" -l -- "$payload"

# Brief flash in status so user sees it happened
tmux display-message -t "$SESS" "added to chat: ${payload}" 2>/dev/null || true
