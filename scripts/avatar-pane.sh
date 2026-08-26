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

render() {
  local f="$1"
  clear
  chafa --format symbols --symbols block+border-solid -s "$(tput cols)x$(($(tput lines) - 3))" "$f"
  echo
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
      if f="$(target_svg)" && [ -n "${f:-}" ] && [ -f "$f" ]; then
        sig="${f}:$(stat -f '%m' "$f")"
        if [ "$sig" != "$last" ]; then
          render "$f"
          last="$sig"
        fi
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|pin <agentId|tokenId>]" >&2
    exit 2
    ;;
esac
