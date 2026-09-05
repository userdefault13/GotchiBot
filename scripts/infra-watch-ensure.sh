#!/bin/bash
# infra-watch-ensure.sh — keep YFI's infra watcher alive in a real terminal.
#
# The watcher shells out to the Claude CLI, and the CLI reads its OAuth
# credentials from the login keychain. A process started over `ssh host 'cmd'`
# cannot read that keychain and gets "Not logged in · Please run /login", so the
# watcher has to live inside the tmux server owned by the console session.
#
# This script is idempotent: it starts the window only if it is missing, so a
# LaunchAgent can run it on a short interval as a supervisor.
set -u

TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
ROOT="${GOTCHIBOT_ROOT:-$HOME/Dev/GotchiBot}"
SESSION="${INFRA_WATCH_TMUX_SESSION:-gotchibot}"
WINDOW="${INFRA_WATCH_TMUX_WINDOW:-infrawatch}"
INTERVAL="${INFRA_WATCH_INTERVAL:-60}"
VERIFY_EVERY="${INFRA_WATCH_VERIFY_EVERY:-30}"

[ -x "$TMUX_BIN" ] || TMUX_BIN="$(command -v tmux || echo /usr/local/bin/tmux)"

# No tmux server yet (fresh boot, before the console session opens one) — start
# a detached session so the watcher still comes up.
if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  "$TMUX_BIN" new-session -d -s "$SESSION" -n work || exit 1
fi

if "$TMUX_BIN" list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$WINDOW"; then
  echo "[infra-watch-ensure] $SESSION:$WINDOW already running"
  exit 0
fi

"$TMUX_BIN" new-window -d -t "$SESSION" -n "$WINDOW" \
  "cd '$ROOT' && exec '$NODE_BIN' scripts/infra-watch.mjs run --interval $INTERVAL --verify-every $VERIFY_EVERY"
echo "[infra-watch-ensure] started $SESSION:$WINDOW"
