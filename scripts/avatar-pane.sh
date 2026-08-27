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
  local hero_id="" svg_path=""
  local use_static=0
  if [ -f "$PIN" ]; then
    hero_id="$(tr -d '[:space:]' < "$PIN")"
    svg_path="$SESSIONS/.avatars/${hero_id}.svg"
  fi

  # tmux defaults to framed ASCII (recolored); chafa SVG only when explicitly enabled.
  if [ -n "${TMUX:-}" ] && [ "${GOTCHIBOT_AVATAR_STATIC:-1}" != 0 ]; then
    use_static=1
  fi

  if [ "$use_static" = 0 ] && [ -n "$hero_id" ] && command -v chafa >/dev/null && command -v node >/dev/null; then
    if [ ! -f "$svg_path" ] || [ "${GOTCHIBOT_AVATAR_REFRESH:-0}" = "1" ]; then
      node "$ROOT/scripts/gotchi-svg.mjs" --refresh "$hero_id" >/dev/null 2>&1 || true
    fi
    if [ -f "$svg_path" ]; then
      local chafa_h="${GOTCHIBOT_AVATAR_ROWS:-26}"
      local chafa_w="${GOTCHIBOT_AVATAR_COLS:-38}"
      body="$(chafa --size "${chafa_w}x${chafa_h}" --symbols block --animate off "$svg_path" 2>/dev/null \
        | sed -e 's/\x1b\[[?][0-9;]*[hl]//g')" || body=""
      if [ -n "$body" ]; then
        ART_CACHE="$body"
        ART_CACHE_STATUS="svg:$hero_id:$status"
      fi
    fi
  fi

  if [ -z "$body" ]; then
    if [ "$ART_CACHE_STATUS" = "ascii:$status" ] && [ -n "$ART_CACHE" ]; then
      body="$ART_CACHE"
    elif [ -f "$ROOT/scripts/gotchi-art.mjs" ] && command -v node >/dev/null; then
      # Collateral primary/secondary recolor from AarcadeGh-t JSON lib
      body="$(node "$ROOT/scripts/gotchi-art.mjs" --color --no-rarity "$status" 2>/dev/null)" || body=""
      if [ -n "$body" ]; then
        ART_CACHE="$body"
        ART_CACHE_STATUS="ascii:$status"
      fi
    fi
    if [ -z "$body" ]; then
      [ -f "$ASCII_IDLE" ] && body="$(cat "$ASCII_IDLE")"
      [ -z "$body" ] && [ -f "$ASCII_ACTIVE" ] && body="$(cat "$ASCII_ACTIVE")"
      [ -z "$body" ] && [ -f "$ASCII_FALLBACK" ] && body="$(cat "$ASCII_FALLBACK")"
      ART_CACHE="$body"
      ART_CACHE_STATUS="ascii:$status"
    fi
  fi

  for ((line = 0; line < pane_h; line++)); do
    put_line "$line" ""
  done

  if [ "$cols" -lt 24 ]; then
    put_line 0 "pane too narrow (${cols} cols; need 24+)" 
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
