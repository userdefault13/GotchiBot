#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
AVATARS="$SESSIONS/.avatars"
PIN="$SESSIONS/.pin"
INTERVAL="${GOTCHIBOT_AVATAR_INTERVAL:-5}"
mkdir -p "$AVATARS"

pin() { printf '%s\n' "$1" > "$PIN"; }

target_svg() {
  local key dir
  if [ -f "$PIN" ]; then
    key="$(tr -d '[:space:]' < "$PIN")"
  else
    for d in "$SESSIONS"/s*/state.env; do
      grep -q '^status=running' "$d" 2>/dev/null || continue
      key="$(basename "$(dirname "$d")")"
      break
    done
    key="${key:-orchestrator}"
  fi

  case "$key" in
    s*) dir="$SESSIONS/$key" ;;
    *)
      dir=""
      if [ -f "$AVATARS/$key.svg" ]; then
        echo "$AVATARS/$key.svg"
        return 0
      fi
      if [ -f "$SESSIONS/.identity.json" ] && command -v node >/dev/null; then
        local hero
        hero="$(python3 -c 'import json;print((json.load(open("'"$SESSIONS"'/.identity.json")).get("activeHeroId")) or "")' 2>/dev/null)"
        if [ -n "$hero" ] && [ -f "$AVATARS/$hero.svg" ]; then
          echo "$AVATARS/$hero.svg"
          return 0
        fi
        if [ -n "$hero" ]; then
          node "$ROOT/scripts/render-avatar.mjs" "$hero" >/dev/null 2>&1 && {
            echo "$AVATARS/$hero.svg"
            return 0
          }
        fi
      fi
      return 1
      ;;
  esac

  local cache="$AVATARS/${key}.svg"
  if [ ! -f "$cache" ]; then
    if [ -n "$dir" ] && [ -f "$dir/avatar.svg" ]; then
      cp "$dir/avatar.svg" "$cache"
    elif [ -n "${GOTCHIBOT_ORCH_TOKEN:-}" ]; then
      node "$ROOT/scripts/fetch-gotchi-svg.mjs" --token "$GOTCHIBOT_ORCH_TOKEN" --out "$cache" >/dev/null 2>&1 || return 1
    else
      return 1
    fi
  fi
  echo "$cache"
}

ASCII_IDLE="$ROOT/assets/gotchi-framed.ascii"
ASCII_ACTIVE="$ROOT/assets/gotchi-inverted.ascii"
ASCII_FALLBACK="$ROOT/assets/gotchi.ascii"

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

render() {
  local f="$1"
  clear
  local status art
  status="$(active_status)"
  case "$status" in
    running) art="$ASCII_ACTIVE" ;;
    *)       art="$ASCII_IDLE" ;;
  esac
  if [ -f "$art" ]; then
    cat "$art"
  elif [ -f "$ASCII_FALLBACK" ]; then
    cat "$ASCII_FALLBACK"
  else
    chafa --format symbols --symbols block+border-solid -s "$(tput cols)x$(($(tput lines) - 3))" "$f"
  fi
  echo
  echo "status: $status"
  if [ -f "$PIN" ]; then
    echo "pinned: $(cat "$PIN")"
  else
    for d in "$SESSIONS"/s*/state.env; do
      grep -q '^status=running' "$d" 2>/dev/null || continue
      echo "active: $(basename "$(dirname "$d")") ($(grep '^model=' "$d" | cut -d= -f2-))"
      break
    done
  fi
}

case "${1:-watch}" in
  pin|avatar)
    [ $# -ge 2 ] || { echo "usage: avatar-pane.sh pin <agentId|tokenId>" >&2; exit 2; }
    pin "$2"
    rm -f "$AVATARS/$2.svg"
    ;;
  watch)
    last=""
    while true; do
      sig="$(active_status)"
      if [ "$sig" != "$last" ]; then
        render ""
        last="$sig"
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|pin <agentId|tokenId>]" >&2
    exit 2
    ;;
esac
