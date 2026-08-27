#!/usr/bin/env bash
# Compact status for tmux — pin/active + wallet gotchi / cAavegotchi counts.
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
    "") printf '' ;;
    nim|pro|local|free|flash) printf '%s' "$m" ;;
    */*) printf '%s' "${m##*/}" ;;
    *) printf '%s' "$m" ;;
  esac
}

roster() {
  # Soft timeout — never block tmux redraw on a slow subgraph call.
  if command -v node >/dev/null; then
    node "$ROOT/scripts/roster-count.mjs" 2>/dev/null || echo "gotchis:? cAave:?"
  else
    echo "gotchis:? cAave:?"
  fi
}

append_roster() {
  local base="$1"
  local r
  r="$(roster)"
  printf '%s  %s' "$base" "$r"
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
      model="$(short_model "$(field model "$(dirname "$d")")")"
      if [ -n "$model" ]; then
        append_roster "$(printf 'status: running  active: %s (%s)' "$id" "$model")"
      else
        append_roster "$(printf 'status: running  active: %s' "$id")"
      fi
      exit 0
    done
  fi
  append_roster "$(printf 'status: multitask  %s running' "$running")"
  exit 0
fi

if [ -f "$PIN" ]; then
  k="$(tr -d '[:space:]' < "$PIN")"
  case "$k" in
    s*)
      if [ -f "$SESSIONS/$k/state.env" ]; then
        st="$(field status "$SESSIONS/$k")"
        append_roster "$(printf 'status: %s  pinned: %s' "${st:-?}" "$k")"
        exit 0
      fi
      ;;
  esac
  append_roster "$(printf 'status: pinned  pin: %s' "$k")"
  exit 0
fi

append_roster "$(printf 'status: %s' "$st")"
