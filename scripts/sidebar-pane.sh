#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

safe_clear() {
  clear 2>/dev/null || printf '\033[2J\033[H'
}

render_collapsed() {
  safe_clear
  printf '\033[38;5;245m›\033[0m\n'
  printf '\033[38;5;39mF\033[0m\n'
  printf '\033[38;5;39mi\033[0m\n'
  printf '\033[38;5;39ml\033[0m\n'
  printf '\033[38;5;39me\033[0m\n'
  printf '\033[38;5;39ms\033[0m\n'
}

case "${1:-watch}" in
  watch)
    trap 'render_collapsed' WINCH
    render_collapsed
    # Static label — no redraw loop (was clear every 2s and caused tmux lag).
    while true; do sleep 86400; done
    ;;
  *)
    render_collapsed
    ;;
esac
