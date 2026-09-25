#!/bin/bash
# infra-desktop-terminal.sh — put the Claude verifier on the actual desktop.
#
# The verifier runs in tmux because tmux is what makes it drivable: send-keys
# and capture-pane give reliable input and output, and the session survives a
# closed window. But a tmux window has no desktop presence — you only see it if
# something attaches to it, so from the iMac's screen the verifier was invisible.
#
# This opens (or focuses) a real Terminal.app window attached to that tmux
# session, so the session stays scriptable while being visible. Closing the
# window detaches the client and leaves the verifier running; rerun this to get
# the window back.
#
#   scripts/infra-desktop-terminal.sh          # open or focus
#   scripts/infra-desktop-terminal.sh --status # report, change nothing
#
# Requires a logged-in console user; it is a no-op over SSH with nobody logged in.
set -u

TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
SESSION="${INFRA_CLAUDE_TMUX_SESSION:-gotchibot}"
WINDOW="${INFRA_CLAUDE_TMUX_WINDOW:-claude-verify}"
COLS="${INFRA_DESKTOP_COLS:-200}"
ROWS="${INFRA_DESKTOP_ROWS:-50}"

[ -x "$TMUX_BIN" ] || TMUX_BIN="$(command -v tmux || echo /usr/local/bin/tmux)"

# Skip Terminal.app on Linux or over SSH (would pop a window on the remote Mac),
# unless the caller explicitly targets the Mac's screen (GOTCHIBOT_MAC_GUI=1 /
# GOTCHIBOT_ON_IMAC=1, as desk-terminals --host imac does).
_gb_gui_forced=0
{ [ "${GOTCHIBOT_MAC_GUI:-}" = "1" ] || [ "${GOTCHIBOT_ON_IMAC:-}" = "1" ]; } && _gb_gui_forced=1
if [ "$(uname -s)" != "Darwin" ] || { [ "$_gb_gui_forced" = 0 ] && { [ -n "${SSH_TTY:-}" ] || [ -n "${SSH_CONNECTION:-}" ]; }; }; then
  if [ "${1:-}" != "--status" ]; then
    echo "gotchibot: Terminal.app window skipped (macOS only / over SSH) — attach with: tmux attach -t ${SESSION}" >&2
    exit 0
  fi
fi

attached_clients() {
  "$TMUX_BIN" list-clients -t "$SESSION" 2>/dev/null | grep -c . || true
}

if [ "${1:-}" = "--status" ]; then
  echo "session:  $SESSION"
  echo "window:   $WINDOW"
  echo "clients:  $(attached_clients)"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "console:  $(stat -f '%Su' /dev/console 2>/dev/null || echo n/a)"
  else
    echo "console:  n/a (non-macOS)"
  fi
  exit 0
fi

if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  echo "[desktop-terminal] no tmux session '$SESSION' yet — nothing to show" >&2
  exit 1
fi

# Nobody at the console means no desktop to draw on. Say so rather than
# failing obscurely inside osascript.
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
  echo "[desktop-terminal] already attached — focused Terminal"
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
    set custom title of front window to "GotchiBot infra verifier"
  end try
end tell
OSA

echo "[desktop-terminal] opened Terminal window attached to ${SESSION}:${WINDOW}"
