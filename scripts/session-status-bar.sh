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

for d in "$SESSIONS"/s*/state.env; do
  [ -f "$d" ] || continue
  grep -q '^status=running' "$d" 2>/dev/null || continue
  id="$(basename "$(dirname "$d")")"
  st="running"
  printf 'status: %s  active: %s (%s)' "$st" "$id" "$(short_model "$(field model "$d")")"
  exit 0
done

printf 'status: %s' "$st"
