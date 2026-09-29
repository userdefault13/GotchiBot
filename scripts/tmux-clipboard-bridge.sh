#!/usr/bin/env bash
# Mirror new tmux paste buffers into the macOS clipboard.
#
# Apple Terminal ignores OSC 52, so copies that land in a tmux buffer (OpenCode /
# OpenClaw selections over ssh, OSC 52 from any pane) never reach Cmd+V. tmux has
# no hook for buffers set by OSC 52, so poll the newest buffer and pbcopy on change.
# copy-mode selections use `copy-command pbcopy` instead (set by orchestrator-layout).
#
#   tmux-clipboard-bridge.sh <tmux-session>     # exits when the session goes away
set -u

sess="${1:-gotchibot}"
[ "$(uname -s)" = "Darwin" ] || exit 0
[ -x /usr/bin/pbcopy ] || exit 0

lock="${TMPDIR:-/tmp}/gotchibot-clipboard-bridge.pid"
if [ -f "$lock" ] && kill -0 "$(cat "$lock" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
echo $$ > "$lock"
trap 'rm -f "$lock"' EXIT

newest() {
  tmux list-buffers -F '#{buffer_name} #{buffer_created} #{buffer_size}' 2>/dev/null | head -1
}

last="$(newest)"
while tmux has-session -t "$sess" 2>/dev/null; do
  sleep 0.4
  cur="$(newest)"
  [ -z "$cur" ] || [ "$cur" = "$last" ] && continue
  last="$cur"
  tmux save-buffer -b "${cur%% *}" - 2>/dev/null | /usr/bin/pbcopy
done
