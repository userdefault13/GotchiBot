#!/usr/bin/env bash
# Vertical label for a collapsed desk pane (Factory, Dossier, Meeting, …).
#   label-bar-pane.sh Factory
set -euo pipefail

word="${1:-Pane}"

safe_clear() {
  clear 2>/dev/null || printf '\033[2J\033[H'
}

render_collapsed() {
  local i ch
  safe_clear
  printf '\033[38;5;245m›\033[0m\n'
  for ((i = 0; i < ${#word}; i++)); do
    ch="${word:i:1}"
    printf '\033[38;5;39m%s\033[0m\n' "$ch"
  done
}

trap 'render_collapsed' WINCH
render_collapsed
while true; do sleep 86400; done
