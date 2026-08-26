#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
PIN="$SESSIONS/.pin"
ASCII_IDLE="$ROOT/assets/gotchi-framed.ascii"
ASCII_ACTIVE="$ROOT/assets/gotchi-inverted.ascii"
ASCII_FALLBACK="$ROOT/assets/gotchi.ascii"
INTERVAL="${GOTCHIBOT_AVATAR_INTERVAL:-5}"
mkdir -p "$SESSIONS"

pin() { printf '%s\n' "$1" > "$PIN"; }

active_status() {
  if [ -f "$PIN" ]; then
    local k
    k="$(tr -d '[:space:]' < "$PIN")"
    case "$k" in
      s*) [ -f "$SESSIONS/$k/state.env" ] && grep -oE '^status=[a-z]+' "$SESSIONS/$k/state.env" | cut -d= -f2 && return ;;
    esac
    echo "pinned"
    return
  fi
  for d in "$SESSIONS"/s*/state.env; do
    grep -q '^status=running' "$d" 2>/dev/null || continue
    echo "running"
    return
  done
  echo "idle"
}

footer() {
  if [ -f "$PIN" ]; then
    echo "pinned: $(cat "$PIN")"
  else
    for d in "$SESSIONS"/s*/state.env; do
      grep -q '^status=running' "$d" 2>/dev/null || continue
      local hero
      hero="$(grep -oE '^hero=.*' "$d" | cut -d= -f2-)"
      echo "active: $(basename "$(dirname "$d")") ($(grep '^model=' "$d" | cut -d= -f2-)${hero:+ · $hero})"
      return
    done
  fi
}

render() {
  local status="$1"
  clear
  if [ -f "$ROOT/scripts/gotchi-art.mjs" ] && command -v node >/dev/null; then
    node "$ROOT/scripts/gotchi-art.mjs" "$status" 2>/dev/null || cat "$ASCII_FALLBACK"
  elif [ -f "$ASCII_FALLBACK" ]; then
    cat "$ASCII_FALLBACK"
  fi
  echo
  echo "status: $status"
  footer
}

case "${1:-watch}" in
  pin|avatar)
    [ $# -ge 2 ] || { echo "usage: avatar-pane.sh pin <agentId>" >&2; exit 2; }
    pin "$2"
    ;;
  watch)
    last=""
    while true; do
      sig="$(active_status)"
      if [ "$sig" != "$last" ]; then
        render "$sig"
        last="$sig"
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|pin <agentId>]" >&2
    exit 2
    ;;
esac
