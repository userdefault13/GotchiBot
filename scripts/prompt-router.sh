#!/usr/bin/env bash
# Route chat-pane input: shell commands vs natural-language tasks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

route_prompt() {
  local line="$1"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] || return 0

  if [[ "$line" == '!'* ]]; then
    bash -lc "${line#!}"
    return
  fi

  if [[ "$line" == gotchibot* ]] \
    || [[ "$line" == ./scripts/* ]] \
    || [[ "$line" == /sidebar ]] \
    || [[ "$line" == /files ]] \
    || [[ "$line" == /handoff ]] \
    || [[ "$line" == /list ]] \
    || [[ "$line" == /help ]]; then
    case "$line" in
      /sidebar) line="gotchibot sidebar" ;;
      /files) line="gotchibot files-max" ;;
      /handoff) line="gotchibot handoff" ;;
      /list) line="gotchibot list" ;;
      /help)
        cat <<'EOF'
Natural language — describe a task; the gotchi spawns a sub-agent.
Commands — gotchibot new|list|handoff|sidebar|files-max|…
Shortcuts — /sidebar /files /handoff /list /help
  F4 / Ctrl-b f — Files full · chat bar (Mac: ⌃b then f)
  F6 / Ctrl-b a — Avatar full · chat bar (Mac: ⌃b then a)
Shell     — prefix with ! (e.g. !ls sessions)
EOF
        return
        ;;
    esac
    bash -lc "cd '$ROOT' && $line"
    return
  fi

  "$ROOT/scripts/gotchibot" ask "$line"
}

route_prompt "$1"
