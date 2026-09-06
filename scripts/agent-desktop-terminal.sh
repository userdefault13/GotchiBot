#!/bin/bash
# agent-desktop-terminal.sh — put a driven Claude session on the actual desktop.
#
# Agent Claude sessions run in tmux because tmux is what makes them drivable:
# send-keys and capture-pane give reliable input and output, and the session
# survives a closed window. But a tmux window has no desktop presence — you only
# see it if something attaches to it, so from the iMac's screen a driven session
# is invisible.
#
# This opens (or focuses) a real Terminal.app window attached to that tmux
# session, so it stays scriptable while being visible. Closing the window
# detaches the client and leaves the session running; rerun this to get it back.
#
#   scripts/agent-desktop-terminal.sh --window claude-verify --title "GotchiBot infra verifier"
#   scripts/agent-desktop-terminal.sh --window link-verify --status
#
# Requires a logged-in console user; it is a no-op over SSH with nobody logged in.
set -u

TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
SESSION="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
WINDOW=""
TITLE=""
COLS=200
ROWS=50
STATUS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --window) WINDOW="${2:-}"; shift 2 ;;
    --title)  TITLE="${2:-}";  shift 2 ;;
    --cols)   COLS="${2:-200}"; shift 2 ;;
    --rows)   ROWS="${2:-50}";  shift 2 ;;
    --session) SESSION="${2:-}"; shift 2 ;;
    --status) STATUS=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$WINDOW" ] || { echo "usage: agent-desktop-terminal.sh --window <name> [--title T] [--cols N] [--rows N]" >&2; exit 2; }
[ -n "$TITLE" ] || TITLE="GotchiBot $WINDOW"
[ -x "$TMUX_BIN" ] || TMUX_BIN="$(command -v tmux || echo /usr/local/bin/tmux)"

attached_clients() {
  "$TMUX_BIN" list-clients -t "$SESSION" 2>/dev/null | grep -c . || true
}

if [ "$STATUS" = "1" ]; then
  echo "session:  $SESSION"
  echo "window:   $WINDOW"
  echo "clients:  $(attached_clients)"
  echo "console:  $(stat -f '%Su' /dev/console)"
  exit 0
fi

if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  echo "[desktop-terminal] no tmux session '$SESSION' yet — nothing to show" >&2
  exit 1
fi

# Nobody at the console means no desktop to draw on. Say so rather than failing
# obscurely inside osascript.
CONSOLE_USER="$(stat -f '%Su' /dev/console)"
if [ "$CONSOLE_USER" = "root" ] || [ -z "$CONSOLE_USER" ]; then
  echo "[desktop-terminal] no console user logged in — cannot open a desktop window" >&2
  exit 1
fi

# Select the target window BEFORE attaching. Doing it here rather than as
# `tmux attach \; select-window` keeps the AppleScript string free of the
# backslash-semicolon that bash and AppleScript would each want to eat.
"$TMUX_BIN" select-window -t "${SESSION}:${WINDOW}" 2>/dev/null || true

if [ "$(attached_clients)" -gt 0 ]; then
  osascript -e 'tell application "Terminal" to activate' >/dev/null 2>&1
  echo "[desktop-terminal] already attached — focused Terminal on ${SESSION}:${WINDOW}"
  exit 0
fi

osascript >/dev/null <<OSA
tell application "Terminal"
  activate
  do script "exec ${TMUX_BIN} attach -t ${SESSION}"
  delay 1
  try
    -- A wide window keeps Claude's answer lines from wrapping, which is what
    -- the verifier's parser reads.
    set number of columns of front window to ${COLS}
    set number of rows of front window to ${ROWS}
    set custom title of front window to "${TITLE}"
  end try
end tell
OSA

echo "[desktop-terminal] opened Terminal window attached to ${SESSION}:${WINDOW}"
