#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
PIN="$SESSIONS/.pin"
FOCUS="$SESSIONS/.focus.json"
ROSTER_CACHE="$SESSIONS/.avatar-roster.json"
ASCII_IDLE="$ROOT/assets/gotchi-framed.ascii"
ASCII_ACTIVE="$ROOT/assets/gotchi-inverted.ascii"
ASCII_FALLBACK="$ROOT/assets/gotchi.ascii"
ASCII_THUMB="$ROOT/assets/gotchi-thumb.ascii"
INTERVAL="${GOTCHIBOT_AVATAR_INTERVAL:-8}"
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
    # Hero pin — prefer cartridge / cache agentStatus over bare "pinned"
    if [ -f "$SESSIONS/.hero-agent-state.json" ] && command -v node >/dev/null; then
      local st
      st="$(node -e '
        const fs=require("fs");
        const id=process.argv[1];
        const p=process.argv[2];
        try {
          const j=JSON.parse(fs.readFileSync(p,"utf8"));
          const s=j[id]?.status;
          if (s) { console.log(s); process.exit(0); }
        } catch {}
      ' "$k" "$SESSIONS/.hero-agent-state.json" 2>/dev/null || true)"
      if [ -n "${st:-}" ]; then
        echo "$st"
        return
      fi
    fi
  fi
  for d in "$SESSIONS"/s*/state.env; do
    [ -f "$d" ] || continue
    grep -q '^status=running' "$d" 2>/dev/null || continue
    echo "running"
    return
  done
  # Live OpenCode gotchi TUI (orchestrator chat) → working
  if pgrep -f 'opencode.*--agent gotchi|opencode --agent gotchi' >/dev/null 2>&1; then
    echo "working"
    return
  fi
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

pane_width() {
  tput cols 2>/dev/null || echo 40
}

put_line() {
  local row="$1" text="$2"
  printf '\033[%d;1H\033[K' "$((row + 1))"
  printf '%s' "$text"
}

role_label() {
  if [ -f "$FOCUS" ] && grep -q '"mode": "sub"' "$FOCUS" 2>/dev/null; then
    echo "sub-agent"
  else
    echo "orchestrator"
  fi
}

refresh_roster() {
  # Fast path: refresh from cache / local sessions without abra.
  node "$ROOT/scripts/avatar-roster.mjs" --json >/dev/null 2>&1 || true
}

refresh_roster_async() {
  (
    if command -v abra >/dev/null 2>&1; then
      abra run gotchibot -- node "$ROOT/scripts/hero-agent-state.mjs" sync >/dev/null 2>&1 || true
      abra run gotchibot -- node "$ROOT/scripts/avatar-roster.mjs" --json --refresh >/dev/null 2>&1 || true
    else
      node "$ROOT/scripts/hero-agent-state.mjs" sync >/dev/null 2>&1 || true
      node "$ROOT/scripts/avatar-roster.mjs" --json --refresh >/dev/null 2>&1 || true
    fi
    # Stamp so the watch loop redraws without USR1 storms.
    date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true
  ) &
}

load_roster_json() {
  [ -f "$ROSTER_CACHE" ] || refresh_roster
  [ -f "$ROSTER_CACHE" ] && cat "$ROSTER_CACHE" || echo '{"role":"orchestrator","others":[]}'
}

mini_chafa() {
  local svg="$1" w="$2" h="$3"
  if [ -f "$svg" ] && command -v chafa >/dev/null; then
    chafa --size "${w}x${h}" --symbols block --animate off "$svg" 2>/dev/null \
      | sed -e 's/\x1b\[[?][0-9;]*[hl]//g' || true
  fi
}

# Roster thumbnail — same AarcadeGh-t collateral JSON path as orchestrator art.
thumb_art() {
  local collateral="${1:-}" id="${2:-}"
  local art=""
  if command -v node >/dev/null && [ -f "$ROOT/scripts/gotchi-art.mjs" ]; then
    if [ -n "$collateral" ]; then
      art="$(node "$ROOT/scripts/gotchi-art.mjs" --thumb --collateral "$collateral" --color 2>/dev/null)" || art=""
    fi
    if [ -z "$art" ] && [ -n "$id" ]; then
      art="$(node "$ROOT/scripts/gotchi-art.mjs" --thumb "$id" --color 2>/dev/null)" || art=""
    fi
  fi
  if [ -z "$art" ] && [ -f "$ASCII_THUMB" ]; then
    art="$(cat "$ASCII_THUMB")"
  fi
  printf '%s\n' "$art"
}

pair_blocks() {
  local left="$1" right="$2" gap="${3:-2}"
  local gap_s i max=0
  gap_s="$(printf '%*s' "$gap" '')"
  local -a La Ra
  while IFS= read -r line || [ -n "$line" ]; do La+=("$line"); done < <(printf '%s\n' "$left")
  while IFS= read -r line || [ -n "$line" ]; do Ra+=("$line"); done < <(printf '%s\n' "$right")
  max=${#La[@]}
  [ "${#Ra[@]}" -gt "$max" ] && max=${#Ra[@]}
  for ((i = 0; i < max; i++)); do
    printf '%s%s%s\n' "${La[i]:-}" "$gap_s" "${Ra[i]:-}"
  done
}

cell_block() {
  local id="$1" status="$2" svg="$3" cell_w="$4" cell_h="$5" collateral="${6:-}"
  local art label status_color
  case "$status" in
    working)
      status_color=$'\033[38;5;208m'
      label="working"
      ;;
    active)
      status_color=$'\033[38;5;39m'
      label="active"
      ;;
    idle)
      status_color=$'\033[38;5;250m'
      label="idle"
      ;;
    watching)
      status_color=$'\033[38;5;141m'
      label="watching"
      ;;
    occupied)
      # legacy alias → working
      status_color=$'\033[38;5;208m'
      label="working"
      ;;
    *)
      status_color=$'\033[38;5;40m'
      label="available"
      ;;
  esac
  # Prefer the shared thumb ASCII; optional SVG only when explicitly enabled.
  if [ "${GOTCHIBOT_THUMB_CHAFA:-0}" = "1" ]; then
    art="$(mini_chafa "$svg" "$cell_w" "$cell_h")"
  fi
  if [ -z "${art:-}" ]; then
    art="$(thumb_art "$collateral" "$id")"
  fi
  printf '%s\n' "$art"
  printf '%b%s%b\n' "$status_color" "$label" $'\033[0m'
  printf '\033[38;5;245m%s\033[0m\n' "${id:0:$cell_w}"
}

render_main_art() {
  local status="$1" cols="$2" max_rows="$3"
  local body="" hero_id="" svg_path=""
  local use_static=0
  if [ -f "$PIN" ]; then
    hero_id="$(tr -d '[:space:]' < "$PIN")"
    svg_path="$SESSIONS/.avatars/${hero_id}.svg"
  fi

  if [ -n "${TMUX:-}" ] && [ "${GOTCHIBOT_AVATAR_STATIC:-1}" != 0 ]; then
    use_static=1
  fi

  local chafa_h chafa_w
  chafa_h="$max_rows"
  chafa_w=$((cols - 2))
  [ "$chafa_w" -gt 72 ] && chafa_w=72
  [ "$chafa_h" -lt 8 ] && chafa_h=8

  if [ "$use_static" = 0 ] && [ -n "$hero_id" ] && command -v chafa >/dev/null && command -v node >/dev/null; then
    if [ ! -f "$svg_path" ] || [ "${GOTCHIBOT_AVATAR_REFRESH:-0}" = "1" ]; then
      node "$ROOT/scripts/gotchi-svg.mjs" --refresh "$hero_id" >/dev/null 2>&1 || true
    fi
    if [ -f "$svg_path" ]; then
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

  if [ -n "$body" ]; then
    # Avoid SIGPIPE under `set -o pipefail` when head closes early.
    printf '%s\n' "$body" | sed '/^$/d' | { head -n "$max_rows" || true; }
  fi
}

render() {
  local status="$1"
  local cols pane_h row=0 line
  cols="$(pane_width)"
  pane_h="$(pane_height)"

  for ((line = 0; line < pane_h; line++)); do
    put_line "$line" ""
  done

  if [ "$cols" -lt 20 ]; then
    put_line 0 "narrow"
    return
  fi

  local role roster_raw
  role="$(role_label)"
  roster_raw="$(load_roster_json)"

  local grid_budget=14
  [ "$pane_h" -lt 28 ] && grid_budget=10
  [ "$pane_h" -gt 40 ] && grid_budget=18
  local main_budget=$((pane_h - grid_budget - 3))
  [ "$main_budget" -lt 10 ] && main_budget=10

  local main
  main="$(render_main_art "$status" "$cols" "$main_budget")"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    put_line "$row" "$line"
    row=$((row + 1))
    [ "$row" -ge "$main_budget" ] && break
  done < <(printf '%s\n' "$main")

  local role_color=$'\033[38;5;39m'
  [ "$role" = "sub-agent" ] && role_color=$'\033[38;5;213m'
  local status_color=$'\033[38;5;250m'
  case "$status" in
    working|running|occupied) status_color=$'\033[38;5;208m' ;;
    active|pinned) status_color=$'\033[38;5;39m' ;;
    watching) status_color=$'\033[38;5;141m' ;;
    available) status_color=$'\033[38;5;40m' ;;
  esac
  local pin_id=""
  [ -f "$PIN" ] && pin_id="$(tr -d '[:space:]' < "$PIN")"
  put_line "$row" "$(printf '%b── %s ──%b  %b%s%b  %s' "$role_color" "$role" $'\033[0m' "$status_color" "$status" $'\033[0m' "${pin_id}")"
  row=$((row + 1))
  put_line "$row" ""
  row=$((row + 1))

  put_line "$row" $'\033[38;5;245mother cAavegotchis\033[0m'
  row=$((row + 1))

  local ids
  ids="$(printf '%s' "$roster_raw" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(d);
        for (const o of (j.others||[])) {
          console.log([o.id, o.status, o.svg||"", o.collateral||""].join("\t"));
        }
      } catch {}
    });
  ')"

  if [ -z "$(printf '%s' "$ids" | tr -d '[:space:]')" ]; then
    put_line "$row" $'\033[38;5;240m(none else on cartridge)\033[0m'
    printf '\033[1;1H'
    return
  fi

  local cell_w=$(( (cols - 3) / 2 ))
  [ "$cell_w" -lt 12 ] && cell_w=12
  [ "$cell_w" -gt 36 ] && cell_w=36
  # Thumb ASCII is ~10 rows; keep cells compact unless pane is very wide.
  local cell_h=10
  [ "$cols" -ge 90 ] && cell_h=12

  local -a ID_ARR ST_ARR SVG_ARR COL_ARR
  while IFS=$'\t' read -r iid ist isvg icol; do
    [ -z "$iid" ] && continue
    ID_ARR+=("$iid")
    ST_ARR+=("$ist")
    SVG_ARR+=("$isvg")
    COL_ARR+=("$icol")
  done < <(printf '%s\n' "$ids")

  local i left right
  for ((i = 0; i < ${#ID_ARR[@]}; i += 2)); do
    left="$(cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cell_w" "$cell_h" "${COL_ARR[i]}")"
    if [ $((i + 1)) -lt ${#ID_ARR[@]} ]; then
      right="$(cell_block "${ID_ARR[i+1]}" "${ST_ARR[i+1]}" "${SVG_ARR[i+1]}" "$cell_w" "$cell_h" "${COL_ARR[i+1]}")"
    else
      right=""
    fi
    while IFS= read -r line || [ -n "$line" ]; do
      [ "$row" -ge "$pane_h" ] && break
      put_line "$row" "$line"
      row=$((row + 1))
    done < <(pair_blocks "$left" "$right" 2)
    [ "$row" -ge "$pane_h" ] && break
  done

  printf '\033[1;1H'
}

rerender() {
  refresh_roster
  render "$(active_status)"
}

case "${1:-watch}" in
  pin|avatar)
    [ $# -ge 2 ] || { echo "usage: avatar-pane.sh pin <agentId>" >&2; exit 2; }
    pin "$2"
    ;;
  once)
    refresh_roster
    refresh_roster_async
    render "$(active_status)"
    ;;
  watch)
    trap rerender USR1
    trap 'render "$(active_status)"' WINCH
    last=""
    last_cols=""
    last_role=""
    last_stamp=""
    refresh_roster
    render "$(active_status)"
    refresh_roster_async
    while true; do
      sig="$(active_status)"
      cols="$(pane_width)"
      role="$(role_label)"
      stamp="$(cat "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true)"
      if [ "$sig" != "$last" ] || [ "$cols" != "$last_cols" ] || [ "$role" != "$last_role" ] || [ "$stamp" != "$last_stamp" ]; then
        render "$sig"
        last="$sig"
        last_cols="$cols"
        last_role="$role"
        last_stamp="$stamp"
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|once|pin <agentId>]" >&2
    exit 2
    ;;
esac
