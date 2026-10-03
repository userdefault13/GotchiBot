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

# Terminal color/glyph step-down (pure bash). Children get explicit --color-mode /
# --ascii so they do not re-probe tmux.
# shellcheck source=scripts/lib/term-caps.sh
. "$ROOT/scripts/lib/term-caps.sh"
gotchibot_term_caps

# Pane chrome: keep 38;5 for truecolor/256; map to basic 16 SGR; empty for none.
case "${TUI_COLOR}" in
  none)
    AV_DIM=""
    AV_LIT=""
    AV_NUM=""
    AV_ROSTER=""
    AV_MUTED=""
    AV_ST_WORKING=""
    AV_ST_ACTIVE=""
    AV_ST_IDLE=""
    AV_ST_WATCH=""
    AV_ST_ASSIGN=""
    AV_ST_AVAIL=""
    AV_ST_DEFAULT=""
    AV_ROLE_ORCH=""
    AV_ROLE_SUB=""
    AV_ROLE_GAL=""
    AV_RST=$'\033[0m'
    ;;
  16)
    AV_DIM=$'\033[90m'
    AV_LIT=$'\033[95m'
    AV_NUM=$'\033[37m'
    AV_ROSTER=$'\033[90m'
    AV_MUTED=$'\033[90m'
    AV_ST_WORKING=$'\033[91m'
    AV_ST_ACTIVE=$'\033[94m'
    AV_ST_IDLE=$'\033[93m'
    AV_ST_WATCH=$'\033[95m'
    AV_ST_ASSIGN=$'\033[93m'
    AV_ST_AVAIL=$'\033[92m'
    AV_ST_DEFAULT=$'\033[37m'
    AV_ROLE_ORCH=$'\033[94m'
    AV_ROLE_SUB=$'\033[95m'
    AV_ROLE_GAL=$'\033[96m'
    AV_RST=$'\033[0m'
    ;;
  *)
    AV_DIM=$'\033[38;5;240m'
    AV_LIT=$'\033[38;5;213m'
    AV_NUM=$'\033[38;5;245m'
    AV_ROSTER=$'\033[38;5;245m'
    AV_MUTED=$'\033[38;5;240m'
    AV_ST_WORKING=$'\033[38;5;208m'
    AV_ST_ACTIVE=$'\033[38;5;39m'
    AV_ST_IDLE=$'\033[38;5;184m'
    AV_ST_WATCH=$'\033[38;5;141m'
    AV_ST_ASSIGN=$'\033[38;5;220m'
    AV_ST_AVAIL=$'\033[38;5;40m'
    AV_ST_DEFAULT=$'\033[38;5;250m'
    AV_ROLE_ORCH=$'\033[38;5;39m'
    AV_ROLE_SUB=$'\033[38;5;213m'
    AV_ROLE_GAL=$'\033[38;5;51m'
    AV_RST=$'\033[0m'
    ;;
esac

if [ "${TUI_GLYPHS}" = "ascii" ]; then
  AV_ARROW_L="<"
  AV_ARROW_R=">"
  AV_RULE="--"
  AV_SPIN=('|' '/' '-' '\')
else
  AV_ARROW_L="←"
  AV_ARROW_R="→"
  AV_RULE="──"
  AV_SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
fi

# Loading tiles spin until the roster resolves their colors. After this many
# seconds of pane uptime a still-unresolved tile falls back to the default art,
# so a gotchi the wallet never reports cannot spin forever.
AV_LOADING_MAX="${GOTCHIBOT_AVATAR_LOADING_MAX:-90}"
SPIN_FRAME=0
LOADING_VISIBLE=0

# chafa (optional SVG path): same flags as before for truecolor/unicode;
# otherwise step colors down and use ascii symbols.
AV_CHAFA_SYMBOLS="block"
[ "${TUI_GLYPHS}" = "ascii" ] && AV_CHAFA_SYMBOLS="ascii"
AV_CHAFA_COLORS=""
case "${TUI_COLOR}" in
  256|16|none) AV_CHAFA_COLORS="--colors ${TUI_COLOR}" ;;
esac

# Run gotchi-art with explicit color/glyph flags (bash 3.2 — no arrays needed).
gotchi_art() {
  if [ "${TUI_GLYPHS}" = "ascii" ]; then
    node "$ROOT/scripts/gotchi-art.mjs" "$@" --color-mode "$TUI_COLOR" --ascii
  else
    node "$ROOT/scripts/gotchi-art.mjs" "$@" --color-mode "$TUI_COLOR"
  fi
}

ART_CACHE=""
ART_CACHE_STATUS=""

# ---------------------------------------------------------------------------
# Memoization + state fingerprint.
#
# The pane used to re-derive everything on a timer: ~10-14 node spawns per
# repaint (roster parse, collateral-resolve and gotchi-art per tile). Renders
# are now driven by state — a cheap stat/pgrep fingerprint of every input that
# can change the pane — and derived values are cached for the life of one
# fingerprint. USR1 (poke-avatar.sh) still forces an immediate repaint.
# ---------------------------------------------------------------------------
MEMO_KEYS=""
MEMO_VAR=""
LAST_FP=""

# GOTCHIBOT_AVATAR_DEBUG=<file>: append one line per repaint decision, so a
# slow prev/next can be read off a log instead of guessed at.
dbg() {
  [ -n "${GOTCHIBOT_AVATAR_DEBUG:-}" ] || return 0
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$GOTCHIBOT_AVATAR_DEBUG" 2>/dev/null || true
}

memo_reset() {
  local v
  for v in $MEMO_KEYS; do unset "$v"; done
  MEMO_KEYS=""
  unset MEMO_ORCH_ID MEMO_FOCUS_HERO
  WARM_DONE=0
}

memo_var() { MEMO_VAR="MEMO_${1//[^A-Za-z0-9]/_}"; }

# memo_call <outvar> <key> <cmd> [args...] — run cmd once per fingerprint epoch.
memo_call() {
  local out="$1" key="$2"
  shift 2
  memo_var "$key"
  local var="$MEMO_VAR" val
  if eval "[ -n \"\${$var+x}\" ]"; then
    eval "$out=\"\$$var\""
    return 0
  fi
  dbg "memo miss: $key"
  val="$("$@")"
  eval "$var=\$val"
  MEMO_KEYS="$MEMO_KEYS $var"
  eval "$out=\$val"
}

# Everything that can change what the pane shows, without spawning node.
#
# Hashes file *contents*, not mtimes: several writers rewrite these caches on a
# heartbeat with byte-identical state, and an mtime check would read every one
# of those as a change and repaint. The `at` timestamps are stripped for the
# same reason. .avatar-roster.stamp is deliberately excluded — it is a pure
# heartbeat, and poke-avatar.sh already sends USR1 alongside it.
# NOTE: $PAGE_FILE is deliberately NOT part of this. Paging changes which
# heroes are on screen, not what any hero is — so it must not invalidate the
# memo cache. Prev/next used to re-derive collateral and re-draw every thumb
# through fresh node spawns purely because the page number lives in a file.
# NOTE: sessions/pstack/<project>/roster.json is also NOT hashed here. The
# open pane reloads that file in refresh_roster_for_order before this runs.
# Hashing it without rebuilding .avatar-roster.json first would latch the new
# checksum while the strip still paints the previous cache.
# Project roster.json is the display order settings just saved. The strip
# paints .avatar-roster.json, which is only rebuilt when something else in
# the fingerprint moves — so a position change on an already-open pane never
# showed up. Checksum the project file and rebuild before deciding to idle.
project_roster_file() {
  local slug="" f
  for f in "$SESSIONS/.pstack-dossier-current" "$SESSIONS/.project-current"; do
    [ -f "$f" ] || continue
    slug="$(tr -d '[:space:]' < "$f" 2>/dev/null || true)"
    [ -n "$slug" ] && break
  done
  case "$slug" in
    ""|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s\n' "$SESSIONS/pstack/${slug}/roster.json"
}

project_roster_sig() {
  local f
  f="$(project_roster_file 2>/dev/null || true)"
  if [ -n "${f}" ] && [ -f "$f" ]; then
    cksum "$f" | awk '{print $1}'
  fi
}

# $1 current roster.json checksum, $2 checksum last rebuilt into the strip.
# Different means the open pane would keep a stale order if it did not rebuild.
roster_order_needs_refresh() {
  [ "${1-}" != "${2-}" ]
}

refresh_roster_for_order() {
  local sig
  ROSTER_ORDER_REFRESHED=0
  sig="$(project_roster_sig || true)"
  if ! roster_order_needs_refresh "$sig" "${ROSTER_ORDER_SIG-}"; then
    return 0
  fi
  refresh_roster
  ROSTER_ORDER_SIG="$sig"
  ROSTER_ORDER_REFRESHED=1
}

state_fingerprint() {
  local sig live
  sig="$(cat "$PIN" "$FOCUS" "$ROSTER_CACHE" \
    "$SESSIONS/.hero-agent-state.json" "$SESSIONS/.focus-list.json" \
    "$SESSIONS/.onboarding.json" "$SESSIONS/.desk-active.line" \
    "$SESSIONS"/s*/state.env 2>/dev/null \
    | sed 's/"at": *"[^"]*"//g' | cksum | tr -d ' ')"
  # active_status also consults a live opencode TUI, which touches no file.
  if pgrep -f 'opencode.*--agent gotchi|opencode --agent gotchi' >/dev/null 2>&1; then
    live=1
  else
    live=0
  fi
  printf '%s|%s|%s|%s|%s\n' "$sig" "$live" "$(pane_width)" "$(pane_height)" "${GOTCHIBOT_AVATAR_HERO:-}"
}

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
      # ← / → page the roster (not ↑/↓ — those stay unused here)
      D|*D) page_prev; return 0 ;;
      C|*C) page_next; return 0 ;;
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
      D) page_prev; return 0 ;;
      C) page_next; return 0 ;;
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
    # h/l aliases for ←/→; keep [ ]
    l|']') page_next; return 0 ;;
    h|'[') page_prev; return 0 ;;
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
  if [ -n "${PANE_H_CACHE:-}" ]; then
    printf '%s\n' "$PANE_H_CACHE"
    return 0
  fi
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
  if [ -n "${PANE_W_CACHE:-}" ]; then
    printf '%s\n' "$PANE_W_CACHE"
    return 0
  fi
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

# pane_width/pane_height each shell out to tmux (~10ms). A paint asks for them
# many times, so the size is read once per paint and served from here until
# the paint ends. WINCH re-enters through safe_render, which re-reads it.
PANE_W_CACHE=""
PANE_H_CACHE=""
pane_dims_lock() {
  PANE_W_CACHE=""
  PANE_H_CACHE=""
  PANE_W_CACHE="$(pane_width)"
  PANE_H_CACHE="$(pane_height)"
}
pane_dims_unlock() {
  PANE_W_CACHE=""
  PANE_H_CACHE=""
}

RENDER_MAX_ROW=-1
LAST_MAX_ROW=-1

put_line() {
  local row="$1" text="$2"
  printf '\033[%d;1H\033[K' "$((row + 1))"
  printf '%s' "$text"
  [ "$row" -gt "$RENDER_MAX_ROW" ] && RENDER_MAX_ROW="$row"
  return 0
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
  if [ -n "${MEMO_ORCH_ID+x}" ]; then
    printf '%s\n' "$MEMO_ORCH_ID"
    return 0
  fi
  MEMO_ORCH_ID="$(node -e '
    const fs=require("fs");
    try {
      const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if (o.orchestratorHeroId) console.log(o.orchestratorHeroId);
    } catch {}
  ' "$SESSIONS/.onboarding.json" 2>/dev/null || true)"
  printf '%s\n' "$MEMO_ORCH_ID"
}

focus_hero() {
  local g
  g="$(gallery_hero)"
  if [ -n "$g" ]; then
    printf '%s\n' "$g"
    return
  fi
  if [ -n "${MEMO_FOCUS_HERO+x}" ]; then
    printf '%s\n' "$MEMO_FOCUS_HERO"
    return 0
  fi
  [ -f "$FOCUS" ] || return 0
  MEMO_FOCUS_HERO="$(node -e '
    const fs=require("fs");
    try {
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if (j.mode==="sub" && j.heroId) console.log(j.heroId);
    } catch {}
  ' "$FOCUS" 2>/dev/null || true)"
  printf '%s\n' "$MEMO_FOCUS_HERO"
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

# Roster JSON -> "id␟status␟svg␟collateral␟haunt␟name␟role␟loading" rows (US-separated:
# `read` collapses runs of tab, so an empty tab field shifts every later one).
roster_ids() {
  printf '%s' "${1:-}" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(d);
        for (const o of (j.others||[])) {
          console.log([o.id, o.status, o.svg||"", o.collateral||"", o.hauntId||"", o.name||"", o.role||"", o.loading?"1":"0"].join("\x1f"));
        }
      } catch {}
    });
  ' 2>/dev/null || true
}

load_roster_json() {
  [ -f "$ROSTER_CACHE" ] || refresh_roster
  [ -f "$ROSTER_CACHE" ] && cat "$ROSTER_CACHE" || echo '{"role":"orchestrator","others":[]}'
}

mini_chafa() {
  local svg="$1" w="$2" h="$3"
  if [ -f "$svg" ] && command -v chafa >/dev/null; then
    chafa --size "${w}x${h}" --symbols "$AV_CHAFA_SYMBOLS" $AV_CHAFA_COLORS --animate off "$svg" 2>/dev/null \
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

# Roster tile — large thumb, doubled collateral, eyes plain.
# (iMessage meet bubbles use --thumb and stay plain regular eyes.)
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
    # Prefer --hero so cartridge traits (eyeColor / eyeShape) load with the glyph.
    if [ -n "$id" ]; then
      art="$(gotchi_art --roster --hero "$id" --color 2>/dev/null)" || art=""
    fi
    if [ -z "$art" ] && [ -n "$collateral" ]; then
      if [ -n "$haunt" ]; then
        art="$(gotchi_art --roster --collateral "$collateral" --haunt "$haunt" --color 2>/dev/null)" || art=""
      else
        art="$(gotchi_art --roster --collateral "$collateral" --color 2>/dev/null)" || art=""
      fi
    fi
  fi
  if [ -z "$art" ] && [ -f "$ASCII_THUMB" ]; then
    art="$(cat "$ASCII_THUMB")"
  fi
  printf '%s\n' "$art"
}


# Visible width: strip CSI/SGR ANSI, then character length.
# Visible width without a fork. vislen_set leaves the answer in $VIS (no
# subshell); vislen prints it. Walks CSI sequences with anchored prefix/suffix
# removals — an extglob substitution looked neat but is quadratic in bash 3.2
# (~400ms on one truecolor art line); this is ~2ms and needs no sed.
VIS=0
ESC_CH=$'\033'
vislen_set() {
  local s="${1:-}" n=0 rest head
  if [[ "$s" != *"$ESC_CH"* ]]; then
    VIS="${#s}"
    return 0
  fi
  rest="$s"
  while [[ "$rest" == *"$ESC_CH["* ]]; do
    head="${rest%%"$ESC_CH["*}"
    n=$((n + ${#head}))
    rest="${rest#*"$ESC_CH["}"
    rest="${rest#*[a-zA-Z]}"
  done
  VIS=$((n + ${#rest}))
}

vislen() {
  vislen_set "${1:-}"
  printf '%s' "$VIS"
}

# Center $1 in $2 columns. left pad = floor((width - vislen) / 2). Wider than width → as-is.
center_pad() {
  local text="${1:-}" width="${2:-0}" vis lp
  vislen_set "$text"
  vis="$VIS"
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
  vislen_set "$text"
  vis="$VIS"
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
  vislen_set "$text"
  vis="$VIS"
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

# Placeholder thumb while colors load: dim ghost outline, spinner in the middle.
# Same 9x12 footprint as the roster thumb so the row does not jump when it resolves.
loading_art() {
  local s="${AV_SPIN[$(( ${1:-0} % ${#AV_SPIN[@]} ))]}" line
  for line in '  _""""""_  ' '_"        "_' '#          #' '#          #' \
    "#    $s     #" '#          #' '#          #' '#          #' '#__""__""__#'; do
    if [ "${TUI_GLYPHS}" != "ascii" ]; then
      line="${line//_/▄}"
      line="${line//\"/▀}"
      line="${line//#/█}"
    fi
    printf '%b%s%b\n' "$AV_MUTED" "$line" "$AV_RST"
  done
}

cell_block() {
  local id="$1" status="$2" svg="$3" cell_w="$4" cell_h="$5" collateral="${6:-}" haunt="${7:-}" name="${8:-}" role="${9:-}" loading="${10:-}"
  local art label status_color
  case "$status" in
    working)
      status_color="$AV_ST_WORKING"
      label="working"
      ;;
    active)
      status_color="$AV_ST_ACTIVE"
      label="active"
      ;;
    idle)
      status_color="$AV_ST_IDLE"
      label="idle"
      ;;
    watching)
      status_color="$AV_ST_WATCH"
      label="watching"
      ;;
    assigned)
      status_color="$AV_ST_ASSIGN"
      label="assigned"
      ;;
    occupied)
      # legacy alias → working
      status_color="$AV_ST_WORKING"
      label="working"
      ;;
    *)
      status_color="$AV_ST_AVAIL"
      label="available"
      ;;
  esac
  if [ -n "$loading" ]; then
    art="$(loading_art "$loading")"
    name="loading…"
    [ "${TUI_GLYPHS}" = "ascii" ] && name="loading..."
  fi
  # Prefer the shared thumb ASCII; optional SVG only when explicitly enabled.
  if [ -z "${art:-}" ] && [ "${GOTCHIBOT_THUMB_CHAFA:-0}" = "1" ]; then
    art="$(mini_chafa "$svg" "$cell_w" "$cell_h")"
  fi
  if [ -z "${art:-}" ]; then
    art="$(thumb_art "$collateral" "$id" "$haunt")"
  fi
  local line id_show
  if [ -n "${art:-}" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      pad_cell_line "$line" "$cell_w"
      printf '\n'
    done < <(printf '%s' "$art")
  fi
  printf '%b%s%b\n' "$status_color" "$(center_pad "$label" "$cell_w")" "$AV_RST"
  id_show="${name:-$id}"
  id_show="${id_show:0:$cell_w}"
  printf '%b%s%b\n' "$AV_ROSTER" "$(center_pad "$id_show" "$cell_w")" "$AV_RST"
  local role_show="${role//-/ }" role_color="$AV_ROLE_GAL"
  [ -z "$role" ] && role_show="no role" && role_color="$AV_MUTED"
  role_show="${role_show:0:$cell_w}"
  printf '%b%s%b\n' "$role_color" "$(center_pad "$role_show" "$cell_w")" "$AV_RST"
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
      body="$(chafa --size "${chafa_w}x${chafa_h}" --symbols "$AV_CHAFA_SYMBOLS" $AV_CHAFA_COLORS --animate off "$svg_path" 2>/dev/null \
        | sed -e 's/\x1b\[[?][0-9;]*[hl]//g')" || body=""
      if [ -n "$body" ]; then
        ART_CACHE="$body"
        ART_CACHE_STATUS="svg:$hero_id:${TUI_COLOR}/${TUI_GLYPHS}"
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
    local art_key="ascii:hero:${art_hero:-pin}:${art_coll:-}:${TUI_COLOR}/${TUI_GLYPHS}"
    if [ -n "$art_hero" ] && [ "$ART_CACHE_STATUS" = "$art_key" ] && [ -n "$ART_CACHE" ]; then
      body="$ART_CACHE"
    elif [ -f "$ROOT/scripts/gotchi-art.mjs" ] && command -v node >/dev/null; then
      [ -z "$art_hero" ] && art_hero="$hero_id"
      if [ -n "$art_hero" ]; then
        body="$(gotchi_art --color --no-rarity --hero "$art_hero" 2>/dev/null)" || body=""
      else
        body="$(gotchi_art --color --no-rarity 2>/dev/null)" || body=""
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

# Paint wrapper. No \033[J and no blank-every-row pass: put_line erases each
# row it writes, and only rows left over from the previous frame get cleared,
# so an unchanged pane never flashes. Wrapped in synchronized output (DECSET
# 2026) so terminals that support it swap the frame in one go.
render() {
  local status="${1:-idle}" r ph locked=0
  if [ -z "${PANE_W_CACHE:-}" ]; then
    pane_dims_lock
    locked=1
  fi
  RENDER_MAX_ROW=-1
  printf '\033[?2026h'
  render_body "$status" || true
  ph="$(pane_height)"
  for ((r = RENDER_MAX_ROW + 1; r <= LAST_MAX_ROW && r < ph; r++)); do
    printf '\033[%d;1H\033[K' "$((r + 1))"
  done
  LAST_MAX_ROW="$RENDER_MAX_ROW"
  printf '\033[1;1H\033[?2026l'
  if [ "$locked" = 1 ]; then
    pane_dims_unlock
  fi
}

# Framed orch block (art + caption lines), padded once per art/caption/width and
# memoized by the caller. The art keeps one left pad on every line so the box
# stays aligned; each caption line is centered on its own, like a roster tile.
render_header_block() {
  local main="$1" caption="$2" cols="$3" max_rows="$4"
  local -a ART_LINES=()
  local line max_vis=0 block_lp=0 i n=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    ART_LINES+=("$line")
    vislen_set "$line"
    [ "$VIS" -gt "$max_vis" ] && max_vis=$VIS
  done < <(printf '%s\n' "$main")
  if [ "$cols" -gt 0 ] && [ "$max_vis" -lt "$cols" ]; then
    block_lp=$(( (cols - max_vis) / 2 ))
  fi
  local art_n=${#ART_LINES[@]}
  for ((i = 0; i < art_n; i++)); do
    [ "$n" -ge "$max_rows" ] && break
    block_pad_line "${ART_LINES[i]}" "$cols" "$block_lp"
    printf '\n'
    n=$((n + 1))
  done
  while IFS= read -r line || [ -n "$line" ]; do
    center_pad "$line" "$cols"
    printf '\n'
  done < <(printf '%s\n' "$caption")
}

# One 3-col roster row: blank-fill missing cells, then join. Memoized by the
# caller on the three cell keys so a page revisit is a variable read.
page_row_block() {
  local left="$1" mid="$2" right="$3" gap="$4" cell_w="$5"
  local nlines
  nlines=$(printf '%s\n' "${left:-${mid:-$right}}" | wc -l | tr -d ' ')
  [ -z "$nlines" ] && nlines=1
  [ -z "$left" ] && left="$(blank_block "$cell_w" "$nlines")"
  [ -z "$mid" ] && mid="$(blank_block "$cell_w" "$nlines")"
  [ -z "$right" ] && right="$(blank_block "$cell_w" "$nlines")"
  pair_blocks "$left" "$mid" "$right" "$gap"
}

# Pre-render the tiles that are NOT on screen, right after a paint, so prev/next
# never spawns node while you wait. Once per memo epoch; memo_call skips tiles
# already computed. A click (USR1) still interrupts between tiles.
WARM_DONE=0
WARM_N=0
warm_other_cells() {
  [ "${WARM_DONE:-0}" = 1 ] && return 0
  [ "${WARM_N:-0}" -gt 0 ] || return 0
  local i v
  dbg "warm: $WARM_N tiles @ ${WARM_W}x${WARM_H}"
  for ((i = 0; i < WARM_N; i++)); do
    [ -n "${W_LOAD[i]:-}" ] && continue
    memo_call v "r|cell|${TUI_COLOR}/${TUI_GLYPHS}|${W_ID[i]}|${W_ST[i]}|${W_COL[i]}|${W_HAUNT[i]}|${W_NAME[i]}|${W_ROLE[i]}||$WARM_W|$WARM_H" \
      cell_block "${W_ID[i]}" "${W_ST[i]}" "${W_SVG[i]}" "$WARM_W" "$WARM_H" "${W_COL[i]}" "${W_HAUNT[i]}" "${W_NAME[i]}" "${W_ROLE[i]}"
  done
  WARM_DONE=1
  dbg "warm: done"

}

# active_status is a file walk plus a node JSON parse (~30ms); every input it
# reads is in the state fingerprint, so it is memoized per epoch like the art.
render_now() {
  local st
  memo_call st "status" active_status
  render "$st"
}

# Pane cols → ROSTER_PAD, ROSTER_CELL_W, ROSTER_ROW_W.
# Pad is one column unless the pane cannot spare it (padded row would pass cols).
# gap is 2, so the two gutters are 4. Cell clamps stay 10..36.
roster_geometry() {
  local cols="${1:-0}" gap=2 gaps pad avail
  gaps=$((gap * 2))
  ROSTER_PAD=0
  ROSTER_CELL_W=10
  ROSTER_ROW_W=$((ROSTER_CELL_W * 3 + gaps))
  for pad in 1 0; do
    [ "$cols" -lt 1 ] && pad=0
    avail=$((cols - pad - gaps))
    if [ "$avail" -lt 0 ]; then
      ROSTER_CELL_W=0
    else
      ROSTER_CELL_W=$((avail / 3))
    fi
    [ "$ROSTER_CELL_W" -lt 10 ] && ROSTER_CELL_W=10
    [ "$ROSTER_CELL_W" -gt 36 ] && ROSTER_CELL_W=36
    ROSTER_ROW_W=$((ROSTER_CELL_W * 3 + gaps))
    ROSTER_PAD=$pad
    if [ "$pad" -eq 0 ] || [ $((ROSTER_PAD + ROSTER_ROW_W)) -le "$cols" ]; then
      break
    fi
  done
}

# Prefix exactly ROSTER_PAD spaces. The cursor stays where put_line homes it.
roster_pad_line() {
  local text="${1:-}" pad="${ROSTER_PAD:-0}"
  if [ "$pad" -le 0 ]; then
    printf '%s' "$text"
    return 0
  fi
  printf '%*s%s' "$pad" '' "$text"
}

render_body() {
  local status="$1"
  local cols pane_h row=0 line
  cols="$(pane_width)"
  pane_h="$(pane_height)"

  # Pre-warm the node-backed lookups in this (parent) shell so the command
  # substitutions below inherit them instead of re-spawning node each time.
  orch_id >/dev/null || true
  focus_hero >/dev/null || true

  if [ "$cols" -lt 20 ]; then
    put_line 0 "narrow"
    return
  fi

  WARM_N=0
  local role roster_raw
  role="$(role_label)"
  local gallery=0
  [ -n "$(gallery_hero)" ] && gallery=1

  local grid_budget=15
  [ "$pane_h" -lt 28 ] && grid_budget=11
  [ "$pane_h" -gt 40 ] && grid_budget=19
  # -7: the 3-line caption (status · name · role) plus room for the roster's prev/next row.
  local main_budget=$((pane_h - grid_budget - 7))
  [ "$main_budget" -lt 10 ] && main_budget=10
  # Meet-gallery tiles: face + caption only (no roster strip).
  if [ "$gallery" = 1 ]; then
    main_budget=$((pane_h - 2))
    [ "$main_budget" -lt 6 ] && main_budget=6
    grid_budget=0
  fi

  # Pinned header from row 0 — orch face never moves. Pagination swaps the 3-col row.
  # (main art + ── orchestrator ── caption + roster label)
  local main
  memo_call main "art|${TUI_COLOR}/${TUI_GLYPHS}|${MEMO_FOCUS_HERO:-}|${MEMO_ORCH_ID:-}|$status|$cols|$main_budget" \
    render_main_art "$status" "$cols" "$main_budget"

  local role_color="$AV_ROLE_ORCH"
  [ "$role" = "sub-agent" ] && role_color="$AV_ROLE_SUB"
  [ "$gallery" = 1 ] && role_color="$AV_ROLE_GAL"
  local status_color="$AV_ST_DEFAULT"
  case "$status" in
    working|running|occupied) status_color="$AV_ST_WORKING" ;;
    active|pinned) status_color="$AV_ST_ACTIVE" ;;
    watching) status_color="$AV_ST_WATCH" ;;
    assigned) status_color="$AV_ST_ASSIGN" ;;
    idle) status_color="$AV_ST_IDLE" ;;
    available) status_color="$AV_ST_AVAIL" ;;
  esac
  local pin_id=""
  pin_id="$(focus_hero)"
  [ -z "$pin_id" ] && [ -f "$PIN" ] && pin_id="$(tr -d '[:space:]' < "$PIN")"
  [ -z "$pin_id" ] && pin_id="$(orch_id)"
  local pin_name="" pin_show
  pin_name="$(sed -n 's/^- \*\*Name:\*\* //p' "$ROOT/config/openclaw/workspaces/$pin_id/IDENTITY.md" 2>/dev/null | head -1)"
  [ "$pin_name" = "$(printf '%s' "$pin_id" | tr '[:lower:]' '[:upper:]')" ] && pin_name=""
  pin_show="$pin_id"
  [ -n "$pin_name" ] && pin_show="$pin_name · $pin_id"
  local active_line=""
  if [ -f "$SESSIONS/.desk-active.line" ]; then
    active_line="$(tr -d '\n' < "$SESSIONS/.desk-active.line" 2>/dev/null || true)"
  fi
  # Same stack as a roster tile: status, name, role — then the shared workflow line.
  local caption
  caption="$(printf '%b%s%b\n%b%s%b\n%b%s%b' \
    "$status_color" "$status" "$AV_RST" \
    "$AV_ROSTER" "${pin_name:-$pin_id}" "$AV_RST" \
    "$role_color" "$role" "$AV_RST")"
  if [ -n "$active_line" ]; then
    caption="${caption}"$'\n'"$(printf '%b%s%b' "$AV_MUTED" "$active_line" "$AV_RST")"
  fi

  # Framed orch (art + caption) padded once per (art, caption, width); a page
  # flip or a repaint only replays the lines. Do not clip the face.
  local hdr
  memo_call hdr "hdr|${TUI_COLOR}/${TUI_GLYPHS}|${MEMO_FOCUS_HERO:-}|${MEMO_ORCH_ID:-}|$status|$cols|$main_budget|$role|$pin_show|$active_line" \
    render_header_block "$main" "$caption" "$cols" "$main_budget"
  while IFS= read -r line || [ -n "$line" ]; do
    put_line "$row" "$line"
    row=$((row + 1))
  done < <(printf '%s\n' "$hdr")

  if [ "$gallery" = 1 ]; then
    printf '\033[1;1H'
    return
  fi

  put_line "$row" ""
  row=$((row + 1))

  put_line "$row" "$(roster_pad_line "$(printf '%broster%b' "$AV_ROSTER" "$AV_RST")")"
  row=$((row + 1))

  roster_raw="$(load_roster_json)"

  local ids ids_key
  # Key on the payload, not a bare "ids". A refresh that rewrote the cache
  # must not replay the previous strip order from the memo.
  ids_key="ids|$(printf '%s' "$roster_raw" | cksum | awk '{print $1}')"
  memo_call ids "$ids_key" roster_ids "$roster_raw"

  if [ -z "$(printf '%s' "$ids" | tr -d '[:space:]')" ]; then
    put_line "$row" "$(printf '%b(none else on cartridge)%b' "$AV_MUTED" "$AV_RST")"
    printf '\033[1;1H'
    return
  fi

  roster_geometry "$cols"
  local gap=2
  local cell_w="$ROSTER_CELL_W"
  # Thumb ASCII is ~10 rows; keep cells compact unless pane is very wide.
  local cell_h=10
  [ "$cols" -ge 90 ] && cell_h=12

  # LOAD_ARR holds the spinner frame for a loading tile, empty once it resolved.
  local -a ID_ARR ST_ARR SVG_ARR COL_ARR HAUNT_ARR NAME_ARR ROLE_ARR LOAD_ARR
  while IFS=$'\x1f' read -r iid ist isvg icol ihaunt iname irole iload; do
    [ -z "$iid" ] && continue
    ID_ARR+=("$iid")
    ST_ARR+=("$ist")
    SVG_ARR+=("$isvg")
    COL_ARR+=("$icol")
    HAUNT_ARR+=("$ihaunt")
    NAME_ARR+=("$iname")
    ROLE_ARR+=("$irole")
    if [ "$iload" = 1 ] && [ "$SECONDS" -lt "$AV_LOADING_MAX" ]; then
      LOAD_ARR+=("$((SPIN_FRAME % ${#AV_SPIN[@]}))")
    else
      LOAD_ARR+=("")
    fi
  done < <(printf '%s\n' "$ids")

  load_page
  local n_ids="${#ID_ARR[@]}"
  local page_size=3
  NPAGES=$(( (n_ids + page_size - 1) / page_size ))
  [ "$NPAGES" -lt 1 ] && NPAGES=1
  clamp_page
  save_page

  # Hand the roster to warm_other_cells (runs after this paint is on screen).
  WARM_N="$n_ids"
  WARM_W="$cell_w"
  WARM_H="$cell_h"
  W_ID=("${ID_ARR[@]}")
  W_ST=("${ST_ARR[@]}")
  W_SVG=("${SVG_ARR[@]}")
  W_COL=("${COL_ARR[@]}")
  W_HAUNT=("${HAUNT_ARR[@]}")
  W_NAME=("${NAME_ARR[@]}")
  W_ROLE=("${ROLE_ARR[@]}")
  W_LOAD=("${LOAD_ARR[@]}")

  local i left mid right pair k1="" k2="" k3=""
  i=$((PAGE * page_size))
  left=""
  mid=""
  right=""
  LOADING_VISIBLE=0
  if [ -n "${LOAD_ARR[i]:-}${LOAD_ARR[i+1]:-}${LOAD_ARR[i+2]:-}" ]; then
    LOADING_VISIBLE=1
  fi
  if [ "$i" -lt "$n_ids" ]; then
    # r| = roster traits on large thumb; bump if roster tile art format changes
    k1="r|cell|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|${ST_ARR[i]}|${COL_ARR[i]}|${HAUNT_ARR[i]}|${NAME_ARR[i]}|${ROLE_ARR[i]}|${LOAD_ARR[i]}|$cell_w|$cell_h"
    memo_call left "$k1" \
      cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cell_w" "$cell_h" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "${LOAD_ARR[i]}"
  fi
  if [ $((i + 1)) -lt "$n_ids" ]; then
    k2="r|cell|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i+1]}|${ST_ARR[i+1]}|${COL_ARR[i+1]}|${HAUNT_ARR[i+1]}|${NAME_ARR[i+1]}|${ROLE_ARR[i+1]}|${LOAD_ARR[i+1]}|$cell_w|$cell_h"
    memo_call mid "$k2" \
      cell_block "${ID_ARR[i+1]}" "${ST_ARR[i+1]}" "${SVG_ARR[i+1]}" "$cell_w" "$cell_h" "${COL_ARR[i+1]}" "${HAUNT_ARR[i+1]}" "${NAME_ARR[i+1]}" "${ROLE_ARR[i+1]}" "${LOAD_ARR[i+1]}"
  fi
  if [ $((i + 2)) -lt "$n_ids" ]; then
    k3="r|cell|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i+2]}|${ST_ARR[i+2]}|${COL_ARR[i+2]}|${HAUNT_ARR[i+2]}|${NAME_ARR[i+2]}|${ROLE_ARR[i+2]}|${LOAD_ARR[i+2]}|$cell_w|$cell_h"
    memo_call right "$k3" \
      cell_block "${ID_ARR[i+2]}" "${ST_ARR[i+2]}" "${SVG_ARR[i+2]}" "$cell_w" "$cell_h" "${COL_ARR[i+2]}" "${HAUNT_ARR[i+2]}" "${NAME_ARR[i+2]}" "${ROLE_ARR[i+2]}" "${LOAD_ARR[i+2]}"
  fi
  memo_call pair "row|${TUI_COLOR}/${TUI_GLYPHS}|$k1|$k2|$k3|$gap" page_row_block "$left" "$mid" "$right" "$gap" "$cell_w"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    put_line "$row" "$(roster_pad_line "$line")"
    row=$((row + 1))
    [ "$row" -ge "$pane_h" ] && break
  done < <(printf '%s\n' "$pair")

  # Button row under the 3-col row: [ ← ]  n / N  [ → ]
  if [ "$row" -lt "$pane_h" ]; then
    put_line "$row" ""
    row=$((row + 1))
  fi
  CTRL_ROW="$row"
  CTRL_COLS="$cols"
  save_page_env

  local dim="$AV_DIM" lit="$AV_LIT" num="$AV_NUM" rst="$AV_RST"
  local prev_s next_s mid_s vis_s pad ctrl
  if [ "$PAGE" -le 0 ]; then
    prev_s="${dim}[ ${AV_ARROW_L} ]${rst}"
  else
    prev_s="${lit}[ ${AV_ARROW_L} ]${rst}"
  fi
  if [ "$PAGE" -ge $((NPAGES - 1)) ]; then
    next_s="${dim}[ ${AV_ARROW_R} ]${rst}"
  else
    next_s="${lit}[ ${AV_ARROW_R} ]${rst}"
  fi
  mid_s="$(printf '%s%d / %d%s' "$num" "$((PAGE + 1))" "$NPAGES" "$rst")"
  if [ "${TUI_MOUSE:-on}" = "off" ]; then
    # No mouse (plain / linux console): show the keyboard paging keys instead
    # of clickable-looking buttons. Mouse layout below is unchanged so the
    # left-third / right-third click hitboxes still line up.
    vis_s="$(printf '[ %s ]   %d / %d   [ %s ]  ^Space P/N' "$AV_ARROW_L" "$((PAGE + 1))" "$NPAGES" "$AV_ARROW_R")"
    pad=$(( (cols - ${#vis_s}) / 2 ))
    [ "$pad" -lt 0 ] && pad=0
    ctrl="$(printf '%*s' "$pad" '')${prev_s}   ${mid_s}   ${next_s}  ${dim}^Space P/N${rst}"
  else
    vis_s="$(printf '[ %s ]     %d / %d     [ %s ]' "$AV_ARROW_L" "$((PAGE + 1))" "$NPAGES" "$AV_ARROW_R")"
    pad=$(( (cols - ${#vis_s}) / 2 ))
    [ "$pad" -lt 0 ] && pad=0
    ctrl="$(printf '%*s' "$pad" '')${prev_s}     ${mid_s}     ${next_s}"
  fi
  if [ "$row" -lt "$pane_h" ]; then
    put_line "$row" "$ctrl"
  fi

  printf '\033[1;1H'
}



rerender() {
  refresh_roster
  render_now
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
PENDING_RENDER=0
LAST_PAGE_DRAWN=""

# Reset derived values only when the underlying state moved. A page flip or a
# resize repaint reuses everything already computed for the heroes on screen.
# Leaves the fingerprint it computed in CUR_FP so the caller can settle
# LAST_FP without walking every session file a second time.
memo_reset_if_stale() {
  CUR_FP="$(state_fingerprint)"
  [ "$CUR_FP" = "$LAST_FP" ] && return 0
  dbg "memo reset: fp changed (${LAST_FP:-none} -> $CUR_FP)"
  memo_reset
}

# One repaint, then any repaint requested while it was in progress.
#
# A click arrives as USR1 from a separate sb-click process after it has
# already written the page file. Dropping that signal while a render is in
# flight used to leave the page changed on disk but not on screen; the tick
# could not catch it either, because the page file is deliberately outside the
# memo fingerprint. The next click then jumped two pages. So: queue, don't drop.
safe_render() {
  if [ "${RENDERING:-0}" = 1 ]; then
    PENDING_RENDER=1
    return 0
  fi
  RENDERING=1
  while true; do
    PENDING_RENDER=0
    # A key or poke paints immediately. Rebuild if roster.json moved so this
    # paint cannot settle on the new file while still drawing the old strip.
    refresh_roster_for_order
    pane_dims_lock
    memo_reset_if_stale
    dbg "safe_render: paint page=$(cat "$PAGE_FILE" 2>/dev/null || echo ?) memo_keys=$(printf '%s' "$MEMO_KEYS" | wc -w | tr -d ' ')"
    render_now || true
    dbg "safe_render: painted"
    pane_dims_unlock
    load_page
    LAST_PAGE_DRAWN="$PAGE"
    # Settle on the fingerprint taken before the draw. Anything that changed
    # during the draw differs from it and repaints on the next tick.
    LAST_FP="$CUR_FP"
    [ "${PENDING_RENDER:-0}" = 1 ] || break
  done
  RENDERING=0
  warm_other_cells || true
}

on_usr1() {
  # Page click already wrote PAGE; poke already wrote the roster cache.
  dbg "usr1"
  safe_render
  dbg "usr1 painted"
}

case "${1:-watch}" in
  pin|avatar)
    [ $# -ge 2 ] || { echo "usage: avatar-pane.sh pin <agentId>" >&2; exit 2; }
    pin "$2"
    ;;
  once)
    memo_reset
    refresh_roster
    refresh_roster_async
    render_now
    ;;
  sb-click)
    mkdir -p "$SESSIONS"
    apply_page_click "${2:-0}" "${3:-0}" tmux || true
    sb_click_wake "${4:-}"
    ;;
  sb-wheel)
    # tmux WheelUp/Down on avatar → page gotchi roster (vertical scroll).
    mkdir -p "$SESSIONS"
    case "${2:-}" in
      up|prev|-1) page_prev ;;
      down|next|1) page_next ;;
      *)
        echo "usage: avatar-pane.sh sb-wheel up|down [pid]" >&2
        exit 2
        ;;
    esac
    sb_click_wake "${3:-}"
    ;;
  roster-order-check)
    # usage: avatar-pane.sh roster-order-check <current-sig> <last-painted-sig>
    # refresh = the open pane must rebuild; keep = the strip order is current.
    if roster_order_needs_refresh "${2-}" "${3-}"; then
      printf 'refresh\n'
    else
      printf 'keep\n'
    fi
    ;;
  roster-origin)
    # Geometry probe. No tmux, no terminal read — roster_geometry + real join.
    cols="${2:-44}"
    case "$cols" in
      ''|*[!0-9]*) cols=44 ;;
    esac
    roster_geometry "$cols"
    cell="$(printf 'S%*s' "$((ROSTER_CELL_W - 1))" '')"
    row_line="$(pair_blocks "$cell" "$cell" "$cell" 2)"
    row_line="${row_line%%$'\n'*}"
    padded="$(roster_pad_line "$row_line")"
    label="$(roster_pad_line "roster")"
    label_r_prefix="${label%%r*}"
    label_col=${#label_r_prefix}
    sprite_prefix="${padded%%S*}"
    sprite_col=${#sprite_prefix}
    printf 'cols=%s\n' "$cols"
    printf 'pad=%s\n' "$ROSTER_PAD"
    printf 'cell_w=%s\n' "$ROSTER_CELL_W"
    printf 'row_w=%s\n' "$ROSTER_ROW_W"
    printf 'label_col=%s\n' "$label_col"
    printf 'sprite_col=%s\n' "$sprite_col"
    printf 'line_w=%s\n' "${#padded}"
    printf 'label_prefix=%s\n' "${label:0:1}"
    ;;
  watch)
    trap 'watch_leave' EXIT
    trap on_usr1 USR1
    trap safe_render WINCH
    read_t="${INTERVAL%%.*}"
    [ -n "$read_t" ] || read_t=8
    dbg "watch: start"
    watch_enter
    # First paint from the last roster on disk; the rebuild reads the Sepolia cartridge
    # (~2s, longer while the cockpit hits the same RPC). The tick repaints when it lands.
    [ -f "$ROSTER_CACHE" ] || refresh_roster
    render_now || true
    dbg "watch: first paint done"
    LAST_FP="$(state_fingerprint)"
    # Captured after the first paint. A later save of roster.json differs and
    # the next tick rebuilds. Startup already refreshes in the background.
    ROSTER_ORDER_SIG="$(project_roster_sig || true)"
    ( refresh_roster; kill -USR1 $$ 2>/dev/null ) &
    refresh_roster_async
    load_page; LAST_PAGE_DRAWN="$PAGE"
    warm_other_cells || true
    dbg "watch: warm done"
    spin_t=1
    [ "${BASH_VERSINFO[0]}" -ge 4 ] && spin_t=0.25
    while true; do
      key=""
      tick_t="$read_t"
      [ "$LOADING_VISIBLE" = 1 ] && tick_t="$spin_t"
      if read -rsn1 -t "$tick_t" key; then
        if handle_key "$key"; then
          safe_render
        fi
        continue
      fi
      # Timeout. The tick fingerprints the pane's inputs and stays still when
      # nothing moved. roster.json is the exception: a position save touches
      # only that file, so it is checksummed above and rebuilt before paint.
      # Other changes arrive here, or immediately via USR1 (poke-avatar.sh).
      load_page
      if [ "$PAGE" != "$LAST_PAGE_DRAWN" ]; then
        # Page moved on disk without a repaint (a click whose USR1 was lost).
        safe_render
        continue
      fi
      # Idle ticks used to skip node entirely. A position save only touches
      # roster.json, which is outside the fingerprint, so reload it first.
      # The rebuilt cache then changes the fingerprint and this tick paints.
      refresh_roster_for_order
      fp="$(state_fingerprint)"
      if [ "$fp" = "$LAST_FP" ]; then
        if [ "$LOADING_VISIBLE" = 1 ]; then
          SPIN_FRAME=$((SPIN_FRAME + 1))
          safe_render
        fi
        continue
      fi
      dbg "tick: fp changed ($LAST_FP -> $fp)"
      memo_reset
      # Order-file changes already rebuilt the cache above.
      if [ "${ROSTER_ORDER_REFRESHED:-0}" != 1 ]; then
        refresh_roster
      fi
      render_now || true
      load_page; LAST_PAGE_DRAWN="$PAGE"
      LAST_FP="$(state_fingerprint)"
      warm_other_cells || true
    done
    ;;
  *)
    echo "usage: avatar-pane.sh [watch|once|pin <agentId>|roster-origin [cols]|sb-click <x> <y> [pid]|sb-wheel up|down [pid]]" >&2
    exit 2
    ;;
esac
