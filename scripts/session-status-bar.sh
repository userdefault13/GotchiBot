#!/usr/bin/env bash
# Compact status for tmux — live chat model + real running sessions (pid must be alive).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
PIN="$SESSIONS/.pin"
CHAT_MODEL_FILE="$SESSIONS/.chat-model"

field() {
  grep -E "^${1}=" "$2/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true
}

short_model() {
  local m="$1"
  case "$m" in
    "") printf '' ;;
    nim|pro|local|free|flash|auto) printf '%s' "$m" ;;
    */*) printf '%s' "${m##*/}" ;;
    *) printf '%s' "$m" ;;
  esac
}

chat_model() {
  if [ -n "${GOTCHIBOT_OPENCODE_MODEL:-}" ]; then
    short_model "$GOTCHIBOT_OPENCODE_MODEL"
    return
  fi
  if [ -f "$CHAT_MODEL_FILE" ]; then
    short_model "$(tr -d '[:space:]' < "$CHAT_MODEL_FILE")"
    return
  fi
  if [ -f "$SESSIONS/.model-auto.json" ] && command -v node >/dev/null; then
    node -e "try{const j=require(process.argv[1]); process.stdout.write(String(j.pick||''))}catch{}" "$SESSIONS/.model-auto.json" 2>/dev/null
  fi
}

roster() {
  if command -v node >/dev/null; then
    node "$ROOT/scripts/roster-count.mjs" 2>/dev/null || echo "gotchis:? cAave:?"
  else
    echo "gotchis:? cAave:?"
  fi
}

imac_hub() {
  if command -v node >/dev/null; then
    node "$ROOT/scripts/imac-status.mjs" 2>/dev/null || echo "iMac: ?"
  else
    echo "iMac: ?"
  fi
}

append_roster() {
  local base="$1"
  local r im
  r="$(roster)"
  im="$(imac_hub)"
  printf '%s  %s  %s' "$base" "$r" "$im"
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

reap_dead() {
  local dir pid
  for d in "$SESSIONS"/s*/state.env; do
    [ -f "$d" ] || continue
    grep -q '^status=running' "$d" 2>/dev/null || continue
    dir="$(dirname "$d")"
    pid="$(field pid "$dir")"
    if ! pid_alive "$pid"; then
      tmp="$dir/.state.tmp.$$"
      { grep -vE '^status=' "$d" || true; echo "status=failed"; } > "$tmp"
      mv "$tmp" "$d"
    fi
  done
}

reap_dead

chat="$(chat_model)"
running=0
live_id=""
live_model=""
for d in "$SESSIONS"/s*/state.env; do
  [ -f "$d" ] || continue
  grep -q '^status=running' "$d" 2>/dev/null || continue
  dir="$(dirname "$d")"
  pid="$(field pid "$dir")"
  pid_alive "$pid" || continue
  running=$((running + 1))
  if [ -z "$live_id" ]; then
    live_id="$(basename "$dir")"
    live_model="$(short_model "$(field model "$dir")")"
  fi
done

if [ "$running" -gt 1 ]; then
  if [ -n "$chat" ]; then
    append_roster "$(printf 'status: multitask  %s running  chat: %s' "$running" "$chat")"
  else
    append_roster "$(printf 'status: multitask  %s running' "$running")"
  fi
  exit 0
fi

if [ "$running" -eq 1 ]; then
  if [ -n "$chat" ]; then
    append_roster "$(printf 'status: running  chat: %s  spawn: %s (%s)' "$chat" "$live_id" "${live_model:-?}")"
  elif [ -n "$live_model" ]; then
    append_roster "$(printf 'status: running  active: %s (%s)' "$live_id" "$live_model")"
  else
    append_roster "$(printf 'status: running  active: %s' "$live_id")"
  fi
  exit 0
fi

if [ -n "$chat" ]; then
  append_roster "$(printf 'status: chat  %s' "$chat")"
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

append_roster "status: idle"
