#!/usr/bin/env bash
# Non-destructive layout self-check for GotchiBot tmux.
#   ./scripts/layout-smoke.sh [check|desk|meet]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESS="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
CMD="${1:-check}"

die() { echo "layout-smoke: $*" >&2; exit 1; }
ok() { echo "layout-smoke: $*"; }

if ! command -v tmux >/dev/null; then
  die "tmux missing"
fi
if ! tmux has-session -t "$SESS" 2>/dev/null; then
  die "no session '$SESS' — start with: ./scripts/gotchibot tmux"
fi

mode="$(tr -d '[:space:]' < "$ROOT/sessions/.layout-mode" 2>/dev/null || echo normal)"
count="$(tmux list-panes -t "$SESS:work" 2>/dev/null | wc -l | tr -d ' ')"
c0="$(tmux display -p -t "$SESS:work.0" '#{pane_start_command}' 2>/dev/null || true)"
c1="$(tmux display -p -t "$SESS:work.1" '#{pane_start_command}' 2>/dev/null || true)"
c2="$(tmux display -p -t "$SESS:work.2" '#{pane_start_command}' 2>/dev/null || true)"

echo "session=$SESS mode=$mode panes=$count"
echo "  0: ${c0:-—}"
echo "  1: ${c1:-—}"
echo "  2: ${c2:-—}"

[ "${count:-0}" -eq 3 ] || die "expected 3 panes, got ${count:-0}"
[[ "$c0" == *sidebar-pane* ]] || die "work.0 should be sidebar-pane (got: ${c0:-empty})"

case "$CMD" in
  check)
    ok "3 panes + sidebar ok (mode=$mode)"
    ;;
  desk)
    [[ "$mode" == "meet-gallery" ]] && die "mode is meet-gallery — use: layout-smoke.sh meet"
    [[ "$c1" == *chat-pane* ]] || die "work.1 should be chat-pane"
    [[ "$c2" == *avatar-pane* ]] || die "work.2 should be avatar-pane"
    ok "desk layout ok (Files | Gotchi | Avatar)"
    ;;
  meet)
    [ "$mode" = "meet-gallery" ] || die "mode=$mode (want meet-gallery)"
    [[ "$c1" == *meet-room* ]] || die "work.1 should be meet-room"
    [[ "$c2" == *meet-channel* ]] || die "work.2 should be meet-channel"
    ok "meet gallery ok (Files | Meet · room | # meet)"
    ;;
  *)
    die "usage: layout-smoke.sh [check|desk|meet]"
    ;;
esac
