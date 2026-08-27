#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BG=$'\033[48;5;235m'
FG=$'\033[38;5;252m'
FG_MUTED=$'\033[38;5;245m'
RESET=$'\033[0m'

safe_clear() {
  clear 2>/dev/null || printf '\033[2J\033[H'
}

draw_header() {
  local cols
  cols=$(tput cols 2>/dev/null || echo 80)
  printf '%b%-*s%b\n' "$BG$FG" "$cols" "  Ask the gotchi" "$RESET"
  printf '%b%-*s%b\n' "$BG$FG_MUTED" "$cols" "  gotchibot new · handoff · sidebar" "$RESET"
  printf '\n'
}

run_prompt() {
  cd "$ROOT"
  draw_header
  while true; do
    printf '\033[38;5;39mgotchi\033[0m › '
    if ! IFS= read -r line; then
      break
    fi
    [ -z "$line" ] && continue
    history -s "$line" 2>/dev/null || true
    bash -lc "$line" || true
    printf '\n'
  done
}

case "${1:-watch}" in
  watch)
    run_prompt
    ;;
  *)
    draw_header
    ;;
esac
