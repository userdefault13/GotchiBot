#!/usr/bin/env bash
# Thin vertical label when the Gotchi chat pane is collapsed for files-max mode.
set -euo pipefail

safe_clear() {
  clear 2>/dev/null || printf '\033[2J\033[H'
}

render_collapsed() {
  safe_clear
  printf '\033[38;5;245m›\033[0m\n'
  printf '\033[38;5;39mG\033[0m\n'
  printf '\033[38;5;39mo\033[0m\n'
  printf '\033[38;5;39mt\033[0m\n'
  printf '\033[38;5;39mc\033[0m\n'
  printf '\033[38;5;39mh\033[0m\n'
  printf '\033[38;5;39mi\033[0m\n'
}

case "${1:-watch}" in
  watch)
    trap 'render_collapsed' WINCH
    render_collapsed
    while true; do sleep 86400; done
    ;;
  *)
    render_collapsed
    ;;
esac
