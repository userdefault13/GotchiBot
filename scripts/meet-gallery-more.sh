#!/usr/bin/env bash
# Overflow tile for meet-gallery when >4 participants.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MSG="${GOTCHIBOT_MEET_MORE:-}"
IDS="${GOTCHIBOT_MEET_MORE_IDS:-}"

if [ -z "$MSG" ] && [ $# -ge 1 ]; then
  MSG="$*"
fi
if [ -z "$MSG" ]; then
  MSG="+ more (invite overflow)"
fi

alt_enter() { printf '\033[?1049h\033[?25l'; }
alt_leave() { printf '\033[?25h\033[?1049l'; }
trap 'alt_leave' EXIT

alt_enter
while true; do
  cols="$(tput cols 2>/dev/null || echo 40)"
  rows="$(tput lines 2>/dev/null || echo 12)"
  printf '\033[H\033[J'
  mid=$((rows / 2))
  [ "$mid" -lt 2 ] && mid=2
  printf '\033[%d;1H' "$mid"
  printf '  \033[38;5;213m%s\033[0m\n' "$MSG"
  if [ -n "$IDS" ]; then
    printf '\033[%d;1H' "$((mid + 2))"
    # wrap long id list
    printf '  \033[38;5;245m%s\033[0m\n' "$IDS" | fold -s -w "$((cols > 4 ? cols - 2 : 20))"
  fi
  sleep 8
done
