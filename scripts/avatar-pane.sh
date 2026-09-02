#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$ROOT/scripts/terminal-color-env.sh" ] && source "$ROOT/scripts/terminal-color-env.sh"
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

PAGE=0
NPAGES=1
CTRL_ROW=-1
CTRL_COLS=0
PAGE_FILE="$SESSIONS/.avatar-roster-page"
PAGE_ENV="$SESSIONS/.avatar-page.env"
AVATAR_PID="$SESSIONS/.avatar-pane.pid"

load_page() {
  PAGE=0
  if [ -f "$PAGE_FILE" ]; then
    PAGE="$(tr -d '[:space:]' < "$PAGE_FILE" 2>/dev/null || echo 0)"
  fi
  case "$PAGE" in
    ''|*[!0-9]*) PAGE=0 ;;
  esac
}

save_page() {
  mkdir -p "$SESSIONS"
  printf '%s\n' "${PAGE:-0}" > "$PAGE_FILE"
}

load_page_env() {
  NPAGES=1
  CTRL_ROW=-1
  CTRL_COLS=0
  if [ -f "$PAGE_ENV" ]; then
    # shellcheck disable=SC1090
    . "$PAGE_ENV" 2>/dev/null || true
  fi
  case "${NPAGES:-}" in ''|*[!0-9]*) NPAGES=1 ;; esac
  case "${CTRL_ROW:-}" in ''|-*|*[!0-9]*) ;; esac
  case "${CTRL_COLS:-}" in ''|*[!0-9]*) CTRL_COLS=0 ;; esac
}

save_page_env() {
  cat > "$PAGE_ENV" <<EOF
NPAGES=${NPAGES:-1}
CTRL_ROW=${CTRL_ROW:--1}
CTRL_COLS=${CTRL_COLS:-0}
EOF
}

clamp_page() {
  local max=0
  if [ "${NPAGES:-1}" -gt 1 ]; then
    max=$((NPAGES - 1))
  fi
  case "${PAGE:-}" in ''|*[!0-9]*) PAGE=0 ;; esac
  if [ "$PAGE" -lt 0 ]; then
    PAGE=0
  fi
  if [ "$PAGE" -gt "$max" ]; then
    PAGE="$max"
  fi
}

page_prev() {
  load_page
  load_page_env
  PAGE=$((PAGE - 1))
  clamp_page
  save_page
}

page_next() {
  load_page
  load_page_env
  PAGE=$((PAGE + 1))
  clamp_page
  save_page
}

page_home() {
  PAGE=0
  save_page
}

page_end() {
  load_page_env
  if [ "${NPAGES:-1}" -gt 1 ]; then
    PAGE=$((NPAGES - 1))
  else
    PAGE=0
  fi
  save_page
}

# tmux #{mouse_x}/#{mouse_y} are 0-based. Control row: left third = prev, right third = next.
apply_page_click() {
  local mx="${1:-0}" my="${2:-0}" origin="${3:-tmux}"
  case "$mx" in ''|*[!0-9]*) return 1 ;; esac
  case "$my" in ''|*[!0-9]*) return 1 ;; esac
  load_page
  load_page_env
  case "${CTRL_ROW:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$CTRL_ROW" -ge 0 ] || return 1
  local y="$my" x="$mx"
  if [ "$origin" = "sgr" ]; then
    y=$((my - 1))
    x=$((mx - 1))
  fi
  # Control row + the row below (1–2 row hitbox).
  # Full 3-col pane width: left third = prev, right third = next. Not per-thumb.
  if [ "$y" -lt "$CTRL_ROW" ] || [ "$y" -gt $((CTRL_ROW + 1)) ]; then
    return 1
  fi
  local w="${CTRL_COLS:-0}"
  [ "$w" -gt 0 ] || w=40
  local left_end=$((w / 3))
  local right_start=$((w - w / 3))
  if [ "$x" -lt "$left_end" ]; then
    PAGE=$((PAGE - 1))
  elif [ "$x" -ge "$right_start" ]; then
    PAGE=$((PAGE + 1))
  else
    return 1
  fi
  clamp_page
  save_page
  return 0
}

write_avatar_pid() {
  mkdir -p "$SESSIONS"
  printf '%s\n' "$$" > "$AVATAR_PID"
}

# Pane-only mark. Never set @gotchibot-avatar on the window (cockpit would match).
mark_self_avatar() {
  [ -n "${TMUX:-}" ] || return 0
  local tgt="${TMUX_PANE:-}"
  [ -n "$tgt" ] || return 0
  tmux set-option -u -w @gotchibot-avatar 2>/dev/null || true
  tmux set-option -p -t "$tgt" @gotchibot-avatar 1 2>/dev/null || true
  tmux set-option -p -t "$tgt" history-limit 0 2>/dev/null || true
  write_avatar_pid
}

# Alt screen keeps orch face + caption pinned: tmux/Terminal cannot
# history-scroll the primary buffer (no smcup was the whole-pane-slide bug).
alt_screen_enter() { printf '\033[?1049h\033[?7l\033[?25l'; }
alt_screen_leave() { printf '\033[?25h\033[?7h\033[?1049l'; }

# Clicks go through tmux MouseDown1 → sb-click. No in-pane SGR/wheel.
mouse_enable() { :; }
mouse_disable() { :; }

pin_avatar_history() {
  mark_self_avatar
}

watch_enter() {
  alt_screen_enter
  pin_avatar_history
}

watch_leave() {
  alt_screen_leave
}

# Follow-up bytes after ESC (bash 3.2: timeout must be integer seconds).
read_seq_char() {
  local ch=""
  if ! read -rsn1 -t 1 ch; then
    return 1
  fi
  REPLY="$ch"
}

# Drain mouse sequences so they never leak as keys. Wheel is a no-op.
handle_sgr_mouse() {
  local ch=""
  while true; do
    if ! read -rsn1 -t 1 ch; then
      break
    fi
    case "$ch" in
      M|m) break ;;
    esac
  done
  return 1
}

handle_x10_mouse() {
  read_seq_char || return 1
  read_seq_char || return 1
  read_seq_char || return 1
  return 1
}

handle_esc() {
  local ch="" acc=""
  if ! read_seq_char; then
    return 1
  fi
  ch="$REPLY"
  if [ "$ch" = "[" ]; then
    if ! read_seq_char; then
      return 1
    fi
    ch="$REPLY"
    if [ "$ch" = "<" ]; then
      handle_sgr_mouse
      return $?
    fi
    if [ "$ch" = "M" ]; then
      handle_x10_mouse
      return $?
    fi
    acc="$ch"
    while ! [[ "$acc" =~ [A-Za-z~] ]]; do
      if ! read_seq_char; then
        break
      fi
      acc="${acc}${REPLY}"
    done
    case "$acc" in
      A|*A|D|*D) page_prev; return 0 ;;
      B|*B|C|*C) page_next; return 0 ;;
      H|*H) page_home; return 0 ;;
      F|*F) page_end; return 0 ;;
      1~|7~) page_home; return 0 ;;
      4~|8~) page_end; return 0 ;;
    esac
    return 1
  fi
  if [ "$ch" = "O" ]; then
    if ! read_seq_char; then
      return 1
    fi
    case "$REPLY" in
      A|D) page_prev; return 0 ;;
      B|C) page_next; return 0 ;;
      H) page_home; return 0 ;;
      F) page_end; return 0 ;;
    esac
    return 1
  fi
  return 1
}

# Returns 0 if PAGE changed and we should redraw now.
handle_key() {
  local key="$1"
  case "$key" in
    j|l|']') page_next; return 0 ;;
    k|h|'[') page_prev; return 0 ;;
    g) page_home; return 0 ;;
    G) page_end; return 0 ;;
    $'\033') handle_esc; return $? ;;
  esac
  return 1
}

pin() { printf '%s\n' "$1" > "$PIN"; }

# Gallery / tile mode: GOTCHIBOT_AVATAR_HERO pins this pane to one hero.
gallery_hero() {
  local h="${GOTCHIBOT_AVATAR_HERO:-}"
  [ -n "$h" ] || return 0
  printf '%s\n' "$h"
}

active_status() {
  local k
  k="$(gallery_hero)"
  if [ -z "$k" ] && [ -f "$PIN" ]; then
    k="$(tr -d '[:space:]' < "$PIN")"
  fi
  if [ -n "$k" ]; then
    case "$k" in
      s*) [ -f "$SESSIONS/$k/state.env" ] && grep -oE '^status=[a-z]+' "$SESSIONS/$k/state.env" | cut -d= -f2 && return ;;
    esac
    # Live session for this hero beats a stale "available" cache
    if [[ "$k" != s* ]]; then
      for d in "$SESSIONS"/s*/state.env; do
        [ -f "$d" ] || continue
        grep -q "^hero=${k}$" "$d" 2>/dev/null || continue
        grep -q '^status=running' "$d" 2>/dev/null || continue
        echo "working"
        return
      done
    fi
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
    if [ -n "$(gallery_hero)" ]; then
      echo "idle"
      return
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
    local h tgt="${TMUX_PANE:-}"
    if [ -n "$tgt" ]; then
      h="$(tmux display -p -t "$tgt" '#{pane_height}' 2>/dev/null || true)"
    else
      h="$(tmux display -p '#{pane_height}' 2>/dev/null || true)"
    fi
    if [ -n "$h" ] && [ "$h" -gt 0 ]; then
      echo "$h"
      return
    fi
  fi
  stty size 2>/dev/null | awk '{print $1}' || tput lines 2>/dev/null || echo 24
}

pane_width() {
  if [ -n "${TMUX:-}" ]; then
    local w tgt="${TMUX_PANE:-}"
    if [ -n "$tgt" ]; then
      w="$(tmux display -p -t "$tgt" '#{pane_width}' 2>/dev/null || true)"
    else
      w="$(tmux display -p '#{pane_width}' 2>/dev/null || true)"
    fi
    if [ -n "$w" ] && [ "$w" -gt 0 ]; then
      echo "$w"
      return
    fi
  fi
  tput cols 2>/dev/null || echo 40
}

put_line() {
  local row="$1" text="$2"
  printf '\033[%d;1H\033[K' "$((row + 1))"
  printf '%s' "$text"
}

role_label() {
  if [ -n "$(gallery_hero)" ]; then
    echo "${GOTCHIBOT_AVATAR_LABEL:-gallery}"
    return
  fi
  if [ -f "$FOCUS" ] && grep -q '"mode": "sub"' "$FOCUS" 2>/dev/null; then
    echo "sub-agent"
  else
    echo "orchestrator"
  fi
}

orch_id() {
  node -e '
    const fs=require("fs");
    try {
      const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if (o.orchestratorHeroId) console.log(o.orchestratorHeroId);
    } catch {}
  ' "$SESSIONS/.onboarding.json" 2>/dev/null || true
}

focus_hero() {
  local g
  g="$(gallery_hero)"
  if [ -n "$g" ]; then
    printf '%s\n' "$g"
    return
  fi
  [ -f "$FOCUS" ] || return 0
  node -e '
    const fs=require("fs");
    try {
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if (j.mode==="sub" && j.heroId) console.log(j.heroId);
    } catch {}
  ' "$FOCUS" 2>/dev/null || true
}

refresh_roster() {
  # Fast path: refresh from cache / local sessions without abra.
  local old new
  old="$(cat "$ROSTER_CACHE" 2>/dev/null || true)"
  node "$ROOT/scripts/avatar-roster.mjs" --json >/dev/null 2>&1 || true
  new="$(cat "$ROSTER_CACHE" 2>/dev/null || true)"
  if [ "$old" != "$new" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true
  fi
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

# Resolve spirit + haunt when roster collateral is empty (owned-N → wallet/wbtc).
resolve_thumb_collateral() {
  local id="${1:-}" roster_col="${2:-}" roster_haunt="${3:-}"
  local spirit haunt resolved
  spirit="$roster_col"
  haunt="$roster_haunt"
  if [ -z "$spirit" ] && [ -n "$id" ]; then
    case "$id" in
      owned-*) spirit="wbtc"; haunt="${haunt:-2}" ;;
      starter-*)
        spirit="$(printf '%s' "$id" | sed -n 's/^starter-\([a-z0-9]*\)-h.*/\1/p')"
        haunt="$(printf '%s' "$id" | sed -n 's/^starter-[a-z0-9]*-h\([0-9]\).*/\1/p')"
        haunt="${haunt:-1}"
        ;;
    esac
  fi
  if command -v node >/dev/null && [ -f "$ROOT/scripts/collateral-resolve.mjs" ]; then
    resolved="$(node "$ROOT/scripts/collateral-resolve.mjs" --hero "${id:-}" ${spirit:+--collateral "$spirit"} ${haunt:+--haunt "$haunt"} 2>/dev/null)" || resolved=""
    if [ -n "$resolved" ]; then
      spirit="$(printf '%s' "$resolved" | awk -F'\t' '{print $1}')"
      haunt="$(printf '%s' "$resolved" | awk -F'\t' '{print $2}')"
    fi
  fi
  printf '%s\t%s\n' "${spirit:-}" "${haunt:-}"
}

# Roster thumbnail — same AarcadeGh-t collateral JSON path as orchestrator art.
thumb_art() {
  local collateral="${1:-}" id="${2:-}" haunt="${3:-}"
  local art="" resolved spirit
  if [ -z "$collateral" ] && [ -n "$id" ]; then
    resolved="$(resolve_thumb_collateral "$id" "$collateral" "$haunt")"
    spirit="$(printf '%s' "$resolved" | awk -F'\t' '{print $1}')"
    haunt="$(printf '%s' "$resolved" | awk -F'\t' '{print $2}')"
    [ -n "$spirit" ] && collateral="$spirit"
  elif [ -n "$id" ] && command -v node >/dev/null && [ -f "$ROOT/scripts/collateral-resolve.mjs" ]; then
    # Overlay wallet/persisted collateral so a stale "dai" on owned-N cannot stick.
    resolved="$(node "$ROOT/scripts/collateral-resolve.mjs" --hero "$id" ${collateral:+--collateral "$collateral"} ${haunt:+--haunt "$haunt"} 2>/dev/null)" || resolved=""
    if [ -n "$resolved" ]; then
      spirit="$(printf '%s' "$resolved" | awk -F'\t' '{print $1}')"
      haunt="$(printf '%s' "$resolved" | awk -F'\t' '{print $2}')"
      [ -n "$spirit" ] && collateral="$spirit"
    fi
  fi
  if command -v node >/dev/null && [ -f "$ROOT/scripts/gotchi-art.mjs" ]; then
    if [ -n "$collateral" ]; then
      if [ -n "$haunt" ]; then
        art="$(node "$ROOT/scripts/gotchi-art.mjs" --thumb --collateral "$collateral" --haunt "$haunt" --color 2>/dev/null)" || art=""
      else
        art="$(node "$ROOT/scripts/gotchi-art.mjs" --thumb --collateral "$collateral" --color 2>/dev/null)" || art=""
      fi
    fi
    if [ -z "$art" ] && [ -n "$id" ]; then
      art="$(node "$ROOT/scripts/gotchi-art.mjs" --thumb --hero "$id" --color 2>/dev/null)" || art=""
    fi
  fi
  if [ -z "$art" ] && [ -f "$ASCII_THUMB" ]; then
    art="$(cat "$ASCII_THUMB")"
  fi
  printf '%s\n' "$art"
}


# Visible width: strip CSI/SGR ANSI, then character length.
vislen() {
  local stripped
  stripped="$(printf '%s' "${1:-}" | sed $'s/\033\\[[0-9;?]*[a-zA-Z]//g')"
  printf '%s' "${#stripped}"
}

# Center $1 in $2 columns. left pad = floor((width - vislen) / 2). Wider than width → as-is.
center_pad() {
  local text="${1:-}" width="${2:-0}" vis lp
  vis="$(vislen "$text")"
  if [ "$width" -le 0 ] || [ "$vis" -ge "$width" ]; then
    printf '%s' "$text"
    return 0
  fi
  lp=$(( (width - vis) / 2 ))
  printf '%*s%s%*s' "$lp" '' "$text" "$((width - vis - lp))" ''
}

# Pad one line of a framed block: SAME left pad on every line, then right-pad to
# pane cols using ANSI-stripped vis. Never clips (wider than cols → as-is).
block_pad_line() {
  local text="${1:-}" width="${2:-0}" lp="${3:-0}" vis
  vis="$(vislen "$text")"
  [ "$lp" -ge 0 ] || lp=0
  if [ "$width" -le 0 ] || [ "$vis" -ge "$width" ]; then
    printf '%s' "$text"
    return 0
  fi
  if [ $((vis + lp)) -ge "$width" ]; then
    printf '%*s%s' "$lp" '' "$text"
    return 0
  fi
  printf '%*s%s%*s' "$lp" '' "$text" "$((width - vis - lp))" ''
}

# Right-pad $1 to $2 columns so 3-col concat stays even. Wider → as-is.
pad_cell_line() {
  local text="${1:-}" width="${2:-0}" vis
  vis="$(vislen "$text")"
  if [ "$width" -le 0 ] || [ "$vis" -ge "$width" ]; then
    printf '%s' "$text"
    return 0
  fi
  printf '%s%*s' "$text" "$((width - vis))" ''
}

# Join up to 3 cell blocks on one row (left / mid / right). Empty args stay empty slots.
pair_blocks() {
  local left="$1" mid="$2" right="$3" gap="${4:-2}"
  local gap_s i max=0
  gap_s="$(printf '%*s' "$gap" '')"
  local -a La Ma Ra
  if [ -n "$left" ]; then
    while IFS= read -r line || [ -n "$line" ]; do La+=("$line"); done < <(printf '%s\n' "$left")
  fi
  if [ -n "$mid" ]; then
    while IFS= read -r line || [ -n "$line" ]; do Ma+=("$line"); done < <(printf '%s\n' "$mid")
  fi
  if [ -n "$right" ]; then
    while IFS= read -r line || [ -n "$line" ]; do Ra+=("$line"); done < <(printf '%s\n' "$right")
  fi
  max=${#La[@]}
  [ "${#Ma[@]}" -gt "$max" ] && max=${#Ma[@]}
  [ "${#Ra[@]}" -gt "$max" ] && max=${#Ra[@]}
  for ((i = 0; i < max; i++)); do
    printf '%s%s%s%s%s\n' "${La[i]:-}" "$gap_s" "${Ma[i]:-}" "$gap_s" "${Ra[i]:-}"
  done
}

blank_block() {
  local w="$1" n="$2" i s
  [ "$n" -gt 0 ] || n=1
  [ "$w" -gt 0 ] || w=10
  s="$(printf '%*s' "$w" '')"
  for ((i = 0; i < n; i++)); do
    printf '%s\n' "$s"
  done
}

cell_block() {
  local id="$1" status="$2" svg="$3" cell_w="$4" cell_h="$5" collateral="${6:-}" haunt="${7:-}"
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
      status_color=$'\033[38;5;184m'
      label="idle"
      ;;
    watching)
      status_color=$'\033[38;5;141m'
      label="watching"
      ;;
    assigned)
      status_color=$'\033[38;5;220m'
      label="assigned"
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
    art="$(thumb_art "$collateral" "$id" "$haunt")"
  fi
  local line id_show
  if [ -n "${art:-}" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s\n' "$(pad_cell_line "$line" "$cell_w")"
    done < <(printf '%s' "$art")
  fi
  printf '%b%s%b\n' "$status_color" "$(center_pad "$label" "$cell_w")" $'\033[0m'
  id_show="${id:0:$cell_w}"
  printf '\033[38;5;245m%s\033[0m\n' "$(center_pad "$id_show" "$cell_w")"
}

render_main_art() {
  local status="$1" cols="$2" max_rows="$3"
  local body="" hero_id="" svg_path=""
  local use_static=0
  hero_id="$(focus_hero)"
  [ -z "$hero_id" ] && [ -f "$PIN" ] && hero_id="$(tr -d '[:space:]' < "$PIN")"
  [ -z "$hero_id" ] && hero_id="$(orch_id)"
  [ -n "$hero_id" ] && svg_path="$SESSIONS/.avatars/${hero_id}.svg"

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
        ART_CACHE_STATUS="svg:$hero_id"
      fi
    fi
  fi

  if [ -z "$body" ]; then
    local art_hero="" art_coll=""
    art_hero="$(focus_hero)"
    [ -z "$art_hero" ] && [ -n "$hero_id" ] && art_hero="$hero_id"
    [ -z "$art_hero" ] && art_hero="$(orch_id)"
    if [ -n "$art_hero" ] && command -v node >/dev/null && [ -f "$ROOT/scripts/collateral-resolve.mjs" ]; then
      art_coll="$(node "$ROOT/scripts/collateral-resolve.mjs" --hero "$art_hero" 2>/dev/null | awk -F'\t' '{print $1}')" || art_coll=""
    fi
    local art_key="ascii:hero:${art_hero:-pin}:${art_coll:-}"
    if [ -n "$art_hero" ] && [ "$ART_CACHE_STATUS" = "$art_key" ] && [ -n "$ART_CACHE" ]; then
      body="$ART_CACHE"
    elif [ -f "$ROOT/scripts/gotchi-art.mjs" ] && command -v node >/dev/null; then
      [ -z "$art_hero" ] && art_hero="$hero_id"
      if [ -n "$art_hero" ]; then
        body="$(node "$ROOT/scripts/gotchi-art.mjs" --color --no-rarity --hero "$art_hero" 2>/dev/null)" || body=""
      else
        body="$(node "$ROOT/scripts/gotchi-art.mjs" --color --no-rarity 2>/dev/null)" || body=""
      fi
      if [ -n "$body" ]; then
        ART_CACHE="$body"
        ART_CACHE_STATUS="$art_key"
      fi
    fi
    if [ -z "$body" ]; then
      [ -f "$ASCII_IDLE" ] && body="$(cat "$ASCII_IDLE")"
      [ -z "$body" ] && [ -f "$ASCII_ACTIVE" ] && body="$(cat "$ASCII_ACTIVE")"
      [ -z "$body" ] && [ -f "$ASCII_FALLBACK" ] && body="$(cat "$ASCII_FALLBACK")"
      ART_CACHE="$body"
      ART_CACHE_STATUS="ascii:fallback:${hero_id:-}"
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

  printf '\033[H\033[J'
  for ((line = 0; line < pane_h; line++)); do
    put_line "$line" ""
  done

  if [ "$cols" -lt 20 ]; then
    put_line 0 "narrow"
    return
  fi

  local role roster_raw
  role="$(role_label)"
  local gallery=0
  [ -n "$(gallery_hero)" ] && gallery=1

  local grid_budget=14
  [ "$pane_h" -lt 28 ] && grid_budget=10
  [ "$pane_h" -gt 40 ] && grid_budget=18
  local main_budget=$((pane_h - grid_budget - 3))
  [ "$main_budget" -lt 10 ] && main_budget=10
  # Meet-gallery tiles: face + caption only (no roster strip).
  if [ "$gallery" = 1 ]; then
    main_budget=$((pane_h - 2))
    [ "$main_budget" -lt 6 ] && main_budget=6
    grid_budget=0
  fi

  # Pinned header from row 0 — orch face never moves. Pagination swaps the 3-col row.
  # (main art + ── orchestrator ── caption + "other cAavegotchis" label)
  local main
  main="$(render_main_art "$status" "$cols" "$main_budget")"

  # Framed orch (art + caption) as one block: max vis width → same left_pad
  # on every line so the box stays aligned. Do not clip the face.
  local -a ART_LINES=()
  local vis max_vis=0 block_lp=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    ART_LINES+=("$line")
    vis="$(vislen "$line")"
    [ "$vis" -gt "$max_vis" ] && max_vis=$vis
  done < <(printf '%s\n' "$main")

  local role_color=$'\033[38;5;39m'
  [ "$role" = "sub-agent" ] && role_color=$'\033[38;5;213m'
  [ "$gallery" = 1 ] && role_color=$'\033[38;5;51m'
  local status_color=$'\033[38;5;250m'
  case "$status" in
    working|running|occupied) status_color=$'\033[38;5;208m' ;;
    active|pinned) status_color=$'\033[38;5;39m' ;;
    watching) status_color=$'\033[38;5;141m' ;;
    assigned) status_color=$'\033[38;5;220m' ;;
    idle) status_color=$'\033[38;5;184m' ;;
    available) status_color=$'\033[38;5;40m' ;;
  esac
  local pin_id=""
  pin_id="$(focus_hero)"
  [ -z "$pin_id" ] && [ -f "$PIN" ] && pin_id="$(tr -d '[:space:]' < "$PIN")"
  [ -z "$pin_id" ] && pin_id="$(orch_id)"
  local caption
  caption="$(printf '%b── %s ──%b  %b%s%b  %s' "$role_color" "$role" $'\033[0m' "$status_color" "$status" $'\033[0m' "${pin_id}")"
  vis="$(vislen "$caption")"
  [ "$vis" -gt "$max_vis" ] && max_vis=$vis
  if [ "$cols" -gt 0 ] && [ "$max_vis" -lt "$cols" ]; then
    block_lp=$(( (cols - max_vis) / 2 ))
  fi

  local art_i art_n=${#ART_LINES[@]}
  for ((art_i = 0; art_i < art_n; art_i++)); do
    put_line "$row" "$(block_pad_line "${ART_LINES[art_i]}" "$cols" "$block_lp")"
    row=$((row + 1))
    [ "$row" -ge "$main_budget" ] && break
  done
  put_line "$row" "$(block_pad_line "$caption" "$cols" "$block_lp")"
  row=$((row + 1))

  if [ "$gallery" = 1 ]; then
    printf '\033[1;1H'
    return
  fi

  put_line "$row" ""
  row=$((row + 1))

  put_line "$row" $'\033[38;5;245mother cAavegotchis\033[0m'
  row=$((row + 1))

  roster_raw="$(load_roster_json)"

  local ids
  ids="$(printf '%s' "$roster_raw" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(d);
        for (const o of (j.others||[])) {
          console.log([o.id, o.status, o.svg||"", o.collateral||"", o.hauntId||""].join("\t"));
        }
      } catch {}
    });
  ')"

  if [ -z "$(printf '%s' "$ids" | tr -d '[:space:]')" ]; then
    put_line "$row" $'\033[38;5;240m(none else on cartridge)\033[0m'
    printf '\033[1;1H'
    return
  fi

  local gap=2
  local gaps=$((gap * 2))
  local cell_w=$(( (cols - gaps) / 3 ))
  [ "$cell_w" -lt 10 ] && cell_w=10
  [ "$cell_w" -gt 36 ] && cell_w=36
  # Thumb ASCII is ~10 rows; keep cells compact unless pane is very wide.
  local cell_h=10
  [ "$cols" -ge 90 ] && cell_h=12

  local -a ID_ARR ST_ARR SVG_ARR COL_ARR HAUNT_ARR
  while IFS=$'\t' read -r iid ist isvg icol ihaunt; do
    [ -z "$iid" ] && continue
    ID_ARR+=("$iid")
    ST_ARR+=("$ist")
    SVG_ARR+=("$isvg")
    COL_ARR+=("$icol")
    HAUNT_ARR+=("$ihaunt")
  done < <(printf '%s\n' "$ids")

  load_page
  local n_ids="${#ID_ARR[@]}"
  local page_size=3
  NPAGES=$(( (n_ids + page_size - 1) / page_size ))
  [ "$NPAGES" -lt 1 ] && NPAGES=1
  clamp_page
  save_page

  local i left mid right pair nlines
  i=$((PAGE * page_size))
  left=""
  mid=""
  right=""
  if [ "$i" -lt "$n_ids" ]; then
    left="$(cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cell_w" "$cell_h" "${COL_ARR[i]}" "${HAUNT_ARR[i]}")"
  fi
  if [ $((i + 1)) -lt "$n_ids" ]; then
    mid="$(cell_block "${ID_ARR[i+1]}" "${ST_ARR[i+1]}" "${SVG_ARR[i+1]}" "$cell_w" "$cell_h" "${COL_ARR[i+1]}" "${HAUNT_ARR[i+1]}")"
  fi
  if [ $((i + 2)) -lt "$n_ids" ]; then
    right="$(cell_block "${ID_ARR[i+2]}" "${ST_ARR[i+2]}" "${SVG_ARR[i+2]}" "$cell_w" "$cell_h" "${COL_ARR[i+2]}" "${HAUNT_ARR[i+2]}")"
  fi
  nlines=$(printf '%s\n' "${left:-${mid:-$right}}" | wc -l | tr -d ' ')
  [ -z "$nlines" ] && nlines=1
  [ -z "$left" ] && left="$(blank_block "$cell_w" "$nlines")"
  [ -z "$mid" ] && mid="$(blank_block "$cell_w" "$nlines")"
  [ -z "$right" ] && right="$(blank_block "$cell_w" "$nlines")"
  pair="$(pair_blocks "$left" "$mid" "$right" "$gap")"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    put_line "$row" "$line"
    row=$((row + 1))
    [ "$row" -ge "$pane_h" ] && break
  done < <(printf '%s\n' "$pair")

  # Button row under the 3-col row: [ ◀ prev ]  n / N  [ next ▶ ]
  if [ "$row" -lt "$pane_h" ]; then
    put_line "$row" ""
    row=$((row + 1))
  fi
  CTRL_ROW="$row"
  CTRL_COLS="$cols"
  save_page_env

  local dim=$'\033[38;5;240m' lit=$'\033[38;5;213m' num=$'\033[38;5;245m' rst=$'\033[0m'
  local prev_s next_s mid_s vis_s pad ctrl
  if [ "$PAGE" -le 0 ]; then
    prev_s="${dim}[ ◀ prev ]${rst}"
  else
    prev_s="${lit}[ ◀ prev ]${rst}"
  fi
  if [ "$PAGE" -ge $((NPAGES - 1)) ]; then
    next_s="${dim}[ next ▶ ]${rst}"
  else
    next_s="${lit}[ next ▶ ]${rst}"
  fi
  mid_s="$(printf '%s%d / %d%s' "$num" "$((PAGE + 1))" "$NPAGES" "$rst")"
  vis_s="$(printf '[ ◀ prev ]     %d / %d     [ next ▶ ]' "$((PAGE + 1))" "$NPAGES")"
  pad=$(( (cols - ${#vis_s}) / 2 ))
  [ "$pad" -lt 0 ] && pad=0
  ctrl="$(printf '%*s' "$pad" '')${prev_s}     ${mid_s}     ${next_s}"
  if [ "$row" -lt "$pane_h" ]; then
    put_line "$row" "$ctrl"
  fi

  printf '\033[1;1H'
}



rerender() {
  refresh_roster
  render "$(active_status)"
}

sb_click_wake() {
  local pid="${1:-}"
  if [ -z "$pid" ] && [ -f "$AVATAR_PID" ]; then
    pid="$(tr -d '[:space:]' < "$AVATAR_PID")"
  fi
  if [ -z "$pid" ] && [ -n "${TMUX:-}" ]; then
    local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
    pid="$(tmux list-panes -t "$sess:work" -F '#{pane_pid} #{@gotchibot-avatar}' 2>/dev/null | awk '$2==1{print $1; exit}')"
  fi
  if [ -n "${pid:-}" ]; then
    kill -USR1 "$pid" 2>/dev/null || true
  fi
}

RENDERING=0

safe_render() {
  # Nested USR1/WINCH during a node thumb draw blanks the pane; skip.
  [ "${RENDERING:-0}" = 1 ] && return 0
  RENDERING=1
  render "$(active_status)" || true
  RENDERING=0
}

on_usr1() {
  # Page click already wrote PAGE; poke already wrote the roster cache.
  safe_render
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
  sb-click)
    mkdir -p "$SESSIONS"
    apply_page_click "${2:-0}" "${3:-0}" tmux || true
    sb_click_wake "${4:-}"
    ;;
  watch)
    trap 'watch_leave' EXIT
    trap on_usr1 USR1
    trap safe_render WINCH
    last=""
    last_cols=""
    last_role=""
    last_stamp=""
    read_t="${INTERVAL%%.*}"
    [ -n "$read_t" ] || read_t=8
    watch_enter
    refresh_roster
    render "$(active_status)" || true
    refresh_roster_async
    while true; do
      key=""
      if read -rsn1 -t "$read_t" key; then
        if handle_key "$key"; then
          render "$(active_status)" || true
          continue
        fi
        continue
      fi
      # Timeout (or signal): keep existing roster refresh logic.
      refresh_roster
      sig="$(active_status)"
      cols="$(pane_width)"
      role="$(role_label)"
      stamp="$(cat "$SESSIONS/.avatar-roster.stamp" 2>/dev/null || true)"
      if [ "$sig" != "$last" ] || [ "$cols" != "$last_cols" ] || [ "$role" != "$last_role" ] || [ "$stamp" != "$last_stamp" ]; then
        render "$sig" || true
        last="$sig"
        last_cols="$cols"
        last_role="$role"
        last_stamp="$stamp"
      fi
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|once|pin <agentId>|sb-click <x> <y> [pid]]" >&2
    exit 2
    ;;
esac
