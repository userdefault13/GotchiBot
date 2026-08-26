#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
PIN="$SESSIONS/.pin"
ASCII_IDLE="$ROOT/assets/gotchi-framed.ascii"
ASCII_ACTIVE="$ROOT/assets/gotchi-inverted.ascii"
ASCII_FALLBACK="$ROOT/assets/gotchi.ascii"
INTERVAL="${GOTCHIBOT_AVATAR_INTERVAL:-15}"
mkdir -p "$SESSIONS"

ART_CACHE=""
ART_CACHE_STATUS=""

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

pane_height() {
  if [ -n "${TMUX:-}" ]; then
    local h
    h="$(tmux display -p '#{pane_height}' 2>/dev/null || true)"
    if [ -n "$h" ] && [ "$h" -gt 0 ]; then
      echo "$h"
      return
    fi
  fi
  stty size 2>/dev/null | awk '{print $1}' || tput lines 2>/dev/null || echo 24
}

put_line() {
  local row="$1" text="$2"
  printf '\033[%d;1H\033[K' "$((row + 1))"
  printf '%s' "$text"
}

render() {
  local status="$1"
  local cols pane_h row=0 line
  cols=$(tput cols 2>/dev/null || echo 80)
  pane_h="$(pane_height)"

  local body=""
  if [ "$ART_CACHE_STATUS" = "$status" ] && [ -n "$ART_CACHE" ]; then
    body="$ART_CACHE"
  elif [ -n "${TMUX:-}" ] && [ "${GOTCHIBOT_AVATAR_STATIC:-1}" != 0 ]; then
    case "$status" in
      running|pinned) [ -f "$ASCII_ACTIVE" ] && body="$(cat "$ASCII_ACTIVE")" ;;
    esac
    [ -z "$body" ] && [ -f "$ASCII_IDLE" ] && body="$(cat "$ASCII_IDLE")"
    [ -z "$body" ] && [ -f "$ASCII_FALLBACK" ] && body="$(cat "$ASCII_FALLBACK")"
    ART_CACHE="$body"
    ART_CACHE_STATUS="$status"
  elif [ -f "$ROOT/scripts/gotchi-art.mjs" ] && command -v node >/dev/null; then
    body="$(node "$ROOT/scripts/gotchi-art.mjs" --no-rarity --no-color "$status" 2>/dev/null)" || body="$(cat "$ASCII_FALLBACK")"
    ART_CACHE="$body"
    ART_CACHE_STATUS="$status"
  elif [ -f "$ASCII_FALLBACK" ]; then
    body="$(cat "$ASCII_FALLBACK")"
  fi

  for ((line = 0; line < pane_h; line++)); do
    put_line "$line" ""
  done

  if [ "$cols" -lt 38 ]; then
    put_line 0 "pane too narrow (${cols} cols; need 38+)" 
    return
  fi

  if [ -n "$body" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      put_line "$row" "$line"
      row=$((row + 1))
    done < <(printf '%s\n' "$body" | sed '/^$/d')
  fi

  printf '\033[1;1H'
}

rerender() {
  render "$(active_status)"
}

case "${1:-watch}" in
  pin|avatar)
    [ $# -ge 2 ] || { echo "usage: avatar-pane.sh pin <agentId>" >&2; exit 2; }
    pin "$2"
    ;;
  once)
    render "$(active_status)"
    ;;
  watch)
    trap rerender USR1
    last=""
    last_cols=""
    render "$(active_status)"
    while true; do
      sig="$(active_status)"
      cols="$(tput cols 2>/dev/null || echo 0)"
      if [ "$sig" != "$last" ] || [ "$cols" != "$last_cols" ]; then
        render "$sig"
        last="$sig"
        last_cols="$cols"
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|once|pin <agentId>]" >&2
    exit 2
    ;;
esac
