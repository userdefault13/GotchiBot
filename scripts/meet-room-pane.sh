#!/usr/bin/env bash
# Meet room — Zoom carousel + OpenCode-style prompter (no OpenCode chat).
# On /end or /chat the prompter exits cleanly, then we restore layout from
# another pane so we never respawn ourselves mid-flight.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESS="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
LEAVE="$ROOT/sessions/.meet-leave"

restore_orch_desk() {
  # Run leave on the files pane (work.0) in the background so this pane can die cleanly.
  if [ -n "${TMUX:-}" ] && tmux has-session -t "$SESS" 2>/dev/null; then
    tmux run-shell -b -t "$SESS:work.0" \
      "sleep 0.2; cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION=\"$SESS\" \"$ROOT/scripts/orchestrator-layout.sh\" leave-meet-gallery" \
      2>/dev/null || \
    tmux run-shell -b \
      "sleep 0.2; cd \"$ROOT\" && GOTCHIBOT_TMUX_SESSION=\"$SESS\" \"$ROOT/scripts/orchestrator-layout.sh\" leave-meet-gallery" \
      2>/dev/null || true
  else
    GOTCHIBOT_TMUX_SESSION="$SESS" "$ROOT/scripts/orchestrator-layout.sh" leave-meet-gallery 2>/dev/null || true
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
      # End meeting state first (no layout leave — we do that next).
      node "$ROOT/scripts/gotchi-meet.mjs" end --keep-layout >/dev/null 2>&1 || true
      restore_orch_desk
      # Stay alive briefly until respawn replaces this pane.
      sleep 8
      ;;
    chat)
      # Leave room UI → OpenCode chat + avatar; meeting may stay open for /meet open.
      restore_orch_desk
      sleep 8
      ;;
    *)
      sleep 0.3
      ;;
  esac
done
