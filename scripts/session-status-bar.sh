#!/usr/bin/env bash
# Compact status for tmux — pin/active only (no session table; use gotchibot list).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
PIN="$SESSIONS/.pin"

field() {
  grep -E "^${1}=" "$2/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true
}

short_model() {
  local m="$1"
  case "$m" in
    nim|pro|local|free|flash) printf '%s' "$m" ;;
    */*) printf '%s' "${m##*/}" ;;
    *) printf '%s' "$m" ;;
  esac
}

st="idle"
running=0
for d in "$SESSIONS"/s*/state.env; do
  [ -f "$d" ] || continue
  grep -q '^status=running' "$d" 2>/dev/null || continue
  running=$((running + 1))
done

if [ "$running" -gt 0 ]; then
  if [ "$running" -eq 1 ]; then
    for d in "$SESSIONS"/s*/state.env; do
      [ -f "$d" ] || continue
      grep -q '^status=running' "$d" 2>/dev/null || continue
      id="$(basename "$(dirname "$d")")"
      printf 'status: running  active: %s (%s)' "$id" "$(short_model "$(field model "$d")")"
      exit 0
    done
  fi
  printf 'status: multitask  %s running' "$running"
  exit 0
fi

if [ -f "$PIN" ]; then
  k="$(tr -d '[:space:]' < "$PIN")"
  case "$k" in
    s*)
      if [ -f "$SESSIONS/$k/state.env" ]; then
        st="$(field status "$SESSIONS/$k")"
        printf 'status: %s  pinned: %s' "${st:-?}" "$k"
        exit 0
      fi
      ;;
  esac
  printf 'status: pinned  pin: %s' "$k"
  exit 0
fi

printf 'status: %s' "$st"
