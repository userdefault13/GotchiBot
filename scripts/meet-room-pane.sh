#!/usr/bin/env bash
# Meet room — Zoom carousel + OpenCode-style prompter (no OpenCode chat).
# Room is persistent. /end stops recording only (prompter stays up).
# /chat or Ctrl+C leaves the UI; room stays open for /meet say.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESS="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
LEAVE="$ROOT/sessions/.meet-leave"

restore_orch_desk() {
  local dest="${1:-leave-meet-gallery}"
  # Run leave on the files pane (work.0) in the background so this pane can die cleanly.
  if [ -n "${TMUX:-}" ] && tmux has-session -t "$SESS" 2>/dev/null; then
    tmux run-shell -b -t "$SESS:work.0" \
      "sleep 0.2; cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION=\"$SESS\" \"$ROOT/scripts/orchestrator-layout.sh\" \"$dest\"" \
      2>/dev/null || \
    tmux run-shell -b \
      "sleep 0.2; cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION=\"$SESS\" \"$ROOT/scripts/orchestrator-layout.sh\" \"$dest\"" \
      2>/dev/null || true
  else
    GOTCHIBOT_TMUX_SESSION="$SESS" "$ROOT/scripts/orchestrator-layout.sh" "$dest" 2>/dev/null || true
  fi
}

while true; do
  rm -f "$LEAVE"
  node "$ROOT/scripts/meet-room-prompter.mjs" || true
  intent=""
  if [ -f "$LEAVE" ]; then
    intent="$(tr -d '[:space:]' < "$LEAVE" || true)"
    rm -f "$LEAVE"
  fi
  case "$intent" in
    end)
      # Legacy: prompter used to leave+end. Now /end stays in-room; treat as leave UI only.
      # Recording stop is handled inside the prompter via gotchi-meet end.
      restore_orch_desk leave-meet-gallery
      sleep 8
      ;;
    chat)
      # Leave room UI → OpenCode chat + avatar; room stays open for /meet say / open.
      restore_orch_desk leave-meet-gallery
      sleep 8
      ;;
    cockpit)
      # Leave room UI → cockpit menu (same room stays open).
      restore_orch_desk leave-meet-cockpit
      sleep 8
      ;;
    *)
      sleep 0.3
      ;;
  esac
done
