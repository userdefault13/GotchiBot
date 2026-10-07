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

# Background behind the selected sub-agent card. Empty when color is off.
case "${TUI_COLOR}" in
  none) AV_SEL_BG="" ;;
  16) AV_SEL_BG=$'\033[100m' ;;
  *) AV_SEL_BG=$'\033[48;5;236m' ;;
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
  # Default word splitting even when a trap fired inside `IFS= read`.
  local v IFS=$' \t\n'
  for v in $MEMO_KEYS; do unset "$v" 2>/dev/null || true; done
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
  printf '%s|%s|%s|%s|%s|%s\n' "$sig" "$live" "$(pane_width)" "$(pane_height)" "${GOTCHIBOT_AVATAR_HERO:-}" "$(avatar_pane_focused && printf 1 || printf 0)"
}

# 0 when this pane is the focused tmux pane. Moving through chat, cockpit, or
# the other desks leaves it collapsed. GOTCHIBOT_AVATAR_FOCUSED overrides tmux
# so a test can force either layout without a session.
avatar_pane_focused() {
  case "${GOTCHIBOT_AVATAR_FOCUSED:-}" in
    1|yes|true) return 0 ;;
    0|no|false) return 1 ;;
  esac
  [ -n "${TMUX:-}" ] || return 1
  local tgt="${TMUX_PANE:-}" active=0
  if [ -n "$tgt" ]; then
    active="$(tmux display -p -t "$tgt" '#{pane_active}' 2>/dev/null || echo 0)"
  else
    active="$(tmux display -p '#{pane_active}' 2>/dev/null || echo 0)"
  fi
  [ "$active" = "1" ]
}

PAGE=0
NPAGES=1
CTRL_ROW=-1
CTRL_COLS=0
PAGE_FILE="$SESSIONS/.avatar-roster-page"
PAGE_ENV="$SESSIONS/.avatar-page.env"
SEL_FILE="$SESSIONS/.avatar-sel.env"
AVATAR_PID="$SESSIONS/.avatar-pane.pid"
SEL=0
MODAL=0
SEL_SIG=""
EXPANDED=0
N_IDS=0
PAGE_SIZE=12
SEL_COLS=4

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
  EXPANDED=0
  N_IDS=0
  PAGE_SIZE=12
  SEL_COLS=4
  if [ -f "$PAGE_ENV" ]; then
    # shellcheck disable=SC1090
    . "$PAGE_ENV" 2>/dev/null || true
  fi
  case "${NPAGES:-}" in ''|*[!0-9]*) NPAGES=1 ;; esac
  case "${CTRL_ROW:-}" in ''|-*|*[!0-9]*) ;; esac
  case "${CTRL_COLS:-}" in ''|*[!0-9]*) CTRL_COLS=0 ;; esac
  case "${EXPANDED:-}" in 1) EXPANDED=1 ;; *) EXPANDED=0 ;; esac
  case "${N_IDS:-}" in ''|*[!0-9]*) N_IDS=0 ;; esac
  case "${PAGE_SIZE:-}" in ''|*[!0-9]*) PAGE_SIZE=12 ;; esac
  case "${SEL_COLS:-}" in ''|*[!0-9]*) SEL_COLS=4 ;; esac
}

save_page_env() {
  cat > "$PAGE_ENV" <<EOF
NPAGES=${NPAGES:-1}
CTRL_ROW=${CTRL_ROW:--1}
CTRL_COLS=${CTRL_COLS:-0}
EXPANDED=${EXPANDED:-0}
N_IDS=${N_IDS:-0}
PAGE_SIZE=${PAGE_SIZE:-12}
SEL_COLS=${SEL_COLS:-4}
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

# Blank rows above a block so the remainder sits below (equal, odd row below).
expanded_vpad() {
  local pane_h="${1:-0}" block_h="${2:-0}"
  EXPANDED_TOP=0
  EXPANDED_BOTTOM=0
  case "$pane_h" in ''|*[!0-9]*) pane_h=0 ;; esac
  case "$block_h" in ''|*[!0-9]*) block_h=0 ;; esac
  if [ "$pane_h" -gt "$block_h" ]; then
    EXPANDED_TOP=$(( (pane_h - block_h) / 2 ))
    EXPANDED_BOTTOM=$(( pane_h - block_h - EXPANDED_TOP ))
  fi
}

load_sel() {
  SEL=0
  MODAL=0
  SEL_SIG=""
  MODAL_VIEW=card
  MENU_SEL=0
  ROLE_SEL=0
  SEL_ID=""
  SEL_NAME=""
  MODAL_MSG=""
  MODAL_TRUST=""
  # 1 = selector on the orchestrator portrait (the default on load).
  SEL_ORCH=1
  if [ -f "$SEL_FILE" ]; then
    # shellcheck disable=SC1090
    . "$SEL_FILE" 2>/dev/null || true
  fi
  case "${SEL:-}" in ''|*[!0-9]*) SEL=0 ;; esac
  case "${MODAL:-}" in 1) MODAL=1 ;; *) MODAL=0 ;; esac
  case "${SEL_SIG:-}" in *[!0-9]*) SEL_SIG="" ;; esac
  case "${MODAL_VIEW:-}" in roles) MODAL_VIEW=roles ;; *) MODAL_VIEW=card ;; esac
  case "${MENU_SEL:-}" in ''|*[!0-9]*) MENU_SEL=0 ;; esac
  case "${ROLE_SEL:-}" in ''|*[!0-9]*) ROLE_SEL=0 ;; esac
  case "${SEL_ORCH:-}" in 0) SEL_ORCH=0 ;; *) SEL_ORCH=1 ;; esac
}

save_sel() {
  mkdir -p "$SESSIONS"
  local tmp="$SEL_FILE.tmp"
  {
    printf 'SEL=%s\n' "${SEL:-0}"
    printf 'MODAL=%s\n' "${MODAL:-0}"
    printf 'SEL_SIG=%s\n' "${SEL_SIG:-}"
    printf 'MODAL_VIEW=%s\n' "${MODAL_VIEW:-card}"
    printf 'MENU_SEL=%s\n' "${MENU_SEL:-0}"
    printf 'ROLE_SEL=%s\n' "${ROLE_SEL:-0}"
    printf 'SEL_ORCH=%s\n' "${SEL_ORCH:-1}"
    # Hero under the selector, written by the paint. Other processes act on it.
    printf 'SEL_ID=%q\n' "${SEL_ID:-}"
    printf 'SEL_NAME=%q\n' "${SEL_NAME:-}"
    printf 'MODAL_MSG=%q\n' "${MODAL_MSG:-}"
    printf 'MODAL_TRUST=%q\n' "${MODAL_TRUST:-}"
  } > "$tmp"
  mv "$tmp" "$SEL_FILE"
}

# This pane has no input line, so space opens the sub-agent modal.
# A future prompt must echo its length here so space is not stolen while typing.
avatar_prompt_len() {
  printf '0'
}

# Sub-agent modal menu. Card: Chat / Assign role / [Promote] / Close. Roles: Back + catalog.
# Promote shows only for a gotchi on probation (hire sheet trust ramp).
MODAL_MENU=("Chat" "Assign role" "Close")
modal_menu_build() {
  MODAL_MENU=("Chat" "Assign role")
  [ "${MODAL_TRUST:-}" = probation ] && MODAL_MENU+=("Promote")
  MODAL_MENU+=("Close")
}

# Hire-sheet trust for the selected gotchi (empty for the orchestrator portrait).
modal_load_trust() {
  MODAL_TRUST=""
  [ "${SEL_ORCH:-1}" = 1 ] && return 0
  [ -n "${SEL_ID:-}" ] || return 0
  MODAL_TRUST="$(node "$ROOT/scripts/hire-sheet.mjs" trust "$SEL_ID" 2>/dev/null || true)"
  case "$MODAL_TRUST" in probation|trusted) ;; *) MODAL_TRUST="" ;; esac
}

# Probation → trusted. setTrust is instant; the workspace re-render that follows
# can take a while, so it runs detached and reports back on the card.
modal_promote() {
  if [ -z "${SEL_ID:-}" ]; then
    MODAL_MSG="no gotchi selected yet"
    return 0
  fi
  local hero="$SEL_ID"
  MODAL_TRUST=trusted
  MODAL_MSG="promoting ${SEL_NAME:-$hero} to trusted…"
  MENU_SEL=0
  ( if node "$ROOT/scripts/pack-wearable.mjs" trust "$hero" trusted > "$SESSIONS/.avatar-promote.log" 2>&1; then
      load_sel
      [ "$SEL_ID" = "$hero" ] && { MODAL_TRUST=trusted; MODAL_MSG="promoted · trusted"; }
    else
      load_sel
      [ "$SEL_ID" = "$hero" ] && { MODAL_TRUST=probation; MODAL_MSG="promote failed · .avatar-promote.log"; }
    fi
    save_sel
    sb_click_wake "" ) &
}
ROLE_LIST_FILE="$SESSIONS/.avatar-role-list"
ROLE_CATALOG="$ROOT/templates/marketplace/catalog.json"

# One role id per line, from the marketplace catalog (what pack-wearable equips).
load_role_list() {
  ROLE_LIST=()
  if [ ! -s "$ROLE_LIST_FILE" ] || [ "$ROLE_CATALOG" -nt "$ROLE_LIST_FILE" ]; then
    node -e 'const c=require(process.argv[1]);for(const p of (c.packs||[]))if(p&&p.id)console.log(p.id)' \
      "$ROLE_CATALOG" 2>/dev/null | sort -u > "$ROLE_LIST_FILE.tmp" && mv "$ROLE_LIST_FILE.tmp" "$ROLE_LIST_FILE"
  fi
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] && ROLE_LIST+=("$line")
  done < "$ROLE_LIST_FILE"
}

modal_reset() {
  MODAL_VIEW=card
  MENU_SEL=0
  ROLE_SEL=0
  MODAL_MSG=""
}

# Equip the role through pack-wearable (also writes config/agent-roles.json),
# then rebuild the roster so the card shows it.
modal_assign_role() {
  local role="$1" out
  if [ -z "${SEL_ID:-}" ]; then
    MODAL_MSG="no gotchi selected yet"
    return 0
  fi
  if out="$(node "$ROOT/scripts/pack-wearable.mjs" equip "$SEL_ID" "$role" 2>&1)"; then
    MODAL_MSG="assigned ${role//-/ } · on probation"
    MODAL_TRUST=probation
    refresh_roster
  else
    MODAL_MSG="assign failed: $(printf '%s' "$out" | tail -n 1)"
  fi
}

# 1:1 meeting with the selected gotchi. Runs detached: it relays out the desk.
modal_open_chat() {
  if [ -z "${SEL_ID:-}" ]; then
    MODAL_MSG="no gotchi selected yet"
    return 0
  fi
  ( cd "$ROOT" && ./scripts/gotchibot meet chat "$SEL_ID" > "$SESSIONS/.avatar-chat.log" 2>&1 \
      || { MODAL=1
           if grep -q "already open" "$SESSIONS/.avatar-chat.log"; then
             MODAL_MSG="a meeting is open · end it first"
           else
             MODAL_MSG="chat failed · .avatar-chat.log"
           fi
           save_sel; sb_click_wake ""; } ) &
  MODAL=0
  modal_reset
}

# Keys while the modal is open. Returns 0 when state changed.
modal_key() {
  local key="$1" n_menu n_roles
  modal_menu_build
  n_menu=${#MODAL_MENU[@]}
  if [ "$MODAL_VIEW" = roles ]; then
    load_role_list
    n_roles=$(( ${#ROLE_LIST[@]} + 1 ))
    case "$key" in
      up|k) [ "$ROLE_SEL" -gt 0 ] && ROLE_SEL=$((ROLE_SEL - 1)) ;;
      down|j) [ "$ROLE_SEL" -lt $((n_roles - 1)) ] && ROLE_SEL=$((ROLE_SEL + 1)) ;;
      left|esc) MODAL_VIEW=card; MODAL_MSG="" ;;
      enter|space|right)
        if [ "$ROLE_SEL" -eq 0 ]; then
          MODAL_VIEW=card
          MODAL_MSG=""
        else
          modal_assign_role "${ROLE_LIST[$((ROLE_SEL - 1))]}"
          MODAL_VIEW=card
        fi
        ;;
      *) return 1 ;;
    esac
    save_sel
    return 0
  fi
  case "$key" in
    up|k) [ "$MENU_SEL" -gt 0 ] && MENU_SEL=$((MENU_SEL - 1)) ;;
    down|j) [ "$MENU_SEL" -lt $((n_menu - 1)) ] && MENU_SEL=$((MENU_SEL + 1)) ;;
    esc|space) MODAL=0; modal_reset ;;
    enter|right)
      case "${MODAL_MENU[$MENU_SEL]}" in
        Chat) modal_open_chat ;;
        "Assign role") MODAL_VIEW=roles; ROLE_SEL=0; MODAL_MSG="" ;;
        Promote) modal_promote ;;
        *) MODAL=0; modal_reset ;;
      esac
      ;;
    left) return 0 ;;
    *) return 1 ;;
  esac
  save_sel
  return 0
}

# Move the sub-agent cursor. Prints sel= and page=. Does not touch files.
# Past the edge of a page, step onto the next page instead of sticking.
select_move_pure() {
  local dir="$1" sel="$2" n="$3" page_size="$4" cols="$5"
  local page local_i n_on_page npages col
  case "$sel" in ''|*[!0-9]*) sel=0 ;; esac
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  case "$page_size" in ''|0|*[!0-9]*) page_size=1 ;; esac
  case "$cols" in ''|0|*[!0-9]*) cols=1 ;; esac
  if [ "$n" -lt 1 ]; then
    printf 'sel=0\npage=0\n'
    return 0
  fi
  [ "$sel" -ge "$n" ] && sel=$((n - 1))
  npages=$(( (n + page_size - 1) / page_size ))
  page=$((sel / page_size))
  local_i=$((sel % page_size))
  n_on_page=$((n - page * page_size))
  [ "$n_on_page" -gt "$page_size" ] && n_on_page=$page_size
  col=$((local_i % cols))
  case "$dir" in
    right)
      if [ $((local_i + 1)) -lt "$n_on_page" ]; then
        sel=$((sel + 1))
      elif [ $((page + 1)) -lt "$npages" ]; then
        sel=$(( (page + 1) * page_size ))
      else
        sel=$((page * page_size))
      fi
      ;;
    left)
      if [ "$local_i" -gt 0 ]; then
        sel=$((sel - 1))
      elif [ "$page" -gt 0 ]; then
        local prev_page=$((page - 1)) prev_n
        prev_n=$((n - prev_page * page_size))
        [ "$prev_n" -gt "$page_size" ] && prev_n=$page_size
        sel=$((prev_page * page_size + prev_n - 1))
      else
        sel=$((page * page_size + n_on_page - 1))
      fi
      ;;
    down)
      if [ $((local_i + cols)) -lt "$n_on_page" ]; then
        sel=$((sel + cols))
      elif [ $((page + 1)) -lt "$npages" ]; then
        local next_page=$((page + 1)) next_n target
        next_n=$((n - next_page * page_size))
        [ "$next_n" -gt "$page_size" ] && next_n=$page_size
        target=$col
        [ "$target" -ge "$next_n" ] && target=$((next_n - 1))
        sel=$((next_page * page_size + target))
      else
        local target=$col
        [ "$target" -ge "$n_on_page" ] && target=$((n_on_page - 1))
        sel=$((page * page_size + target))
      fi
      ;;
    up)
      if [ "$local_i" -ge "$cols" ]; then
        sel=$((sel - cols))
      elif [ "$page" -gt 0 ]; then
        local prev_page=$((page - 1)) prev_n last_row target
        prev_n=$((n - prev_page * page_size))
        [ "$prev_n" -gt "$page_size" ] && prev_n=$page_size
        last_row=$(( ((prev_n - 1) / cols) * cols ))
        target=$((last_row + col))
        [ "$target" -ge "$prev_n" ] && target=$((prev_n - 1))
        sel=$((prev_page * page_size + target))
      else
        local last_row target
        last_row=$(( ((n_on_page - 1) / cols) * cols ))
        target=$((last_row + col))
        [ "$target" -ge "$n_on_page" ] && target=$((n_on_page - 1))
        sel=$((page * page_size + target))
      fi
      ;;
  esac
  page=$((sel / page_size))
  printf 'sel=%s\npage=%s\n' "$sel" "$page"
}

# EXPANDED=1 only after a focused expanded paint. Otherwise return 1 so
# ←/→ keep paging and space is not stolen.
# force=1 (roster-nudge, any pane) also drives the collapsed column.
apply_select_key() {
  local key="$1" force="${2:-0}"
  local prompt=0 moved sel_out page_out
  load_page
  load_page_env
  load_sel
  if [ "${EXPANDED:-0}" != 1 ] && [ "$force" != 1 ]; then
    return 1
  fi
  local n="${N_IDS:-0}" ps="${PAGE_SIZE:-12}" cols="${SEL_COLS:-4}"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  case "$ps" in ''|0|*[!0-9]*) ps=12 ;; esac
  case "$cols" in ''|0|*[!0-9]*) cols=4 ;; esac
  if [ "${MODAL:-0}" = 1 ]; then
    modal_key "$key"
    return $?
  fi
  # Orchestrator portrait sits left of the grid: right/down step into the grid,
  # left from the first column or up from the very first card step back to it.
  if [ "${SEL_ORCH:-1}" = 1 ]; then
    case "$key" in
      right|down)
        [ "$n" -ge 1 ] || return 0
        SEL_ORCH=0
        SEL=$((PAGE * ps))
        [ "$SEL" -ge "$n" ] && SEL=$((n - 1))
        SEL_ID=""
        SEL_NAME=""
        save_sel
        return 0
        ;;
      left|up) return 0 ;;
    esac
  else
    case "$key" in
      left|up)
        if { [ "$key" = left ] && [ $(( (SEL % ps) % cols )) -eq 0 ]; } || \
           { [ "$key" = up ] && [ "$SEL" -eq 0 ]; }; then
          SEL_ORCH=1
          SEL_ID=""
          SEL_NAME=""
          save_sel
          return 0
        fi
        ;;
    esac
  fi
  case "$key" in
    left|right|up|down)
      [ "$n" -ge 1 ] || return 1
      moved="$(select_move_pure "$key" "$SEL" "$n" "$ps" "$cols")"
      sel_out="$(printf '%s\n' "$moved" | awk -F= '/^sel=/{print $2}')"
      page_out="$(printf '%s\n' "$moved" | awk -F= '/^page=/{print $2}')"
      case "$sel_out" in ''|*[!0-9]*) return 1 ;; esac
      case "$page_out" in ''|*[!0-9]*) return 1 ;; esac
      SEL="$sel_out"
      PAGE="$page_out"
      MODAL=0
      # The paint fills SEL_ID for the new cursor; never act on the old hero.
      SEL_ID=""
      SEL_NAME=""
      save_sel
      save_page
      return 0
      ;;
    space|enter)
      prompt="$(avatar_prompt_len)"
      case "$prompt" in ''|*[!0-9]*) prompt=0 ;; esac
      [ "$prompt" -gt 0 ] && return 1
      [ "$n" -ge 1 ] || [ "${SEL_ORCH:-1}" = 1 ] || return 1
      MODAL=1
      modal_reset
      modal_load_trust
      save_sel
      return 0
      ;;
    esc)
      [ "${MODAL:-0}" = 1 ] || return 1
      MODAL=0
      save_sel
      return 0
      ;;
  esac
  return 1
}

# Index 0 when the pane opens or the ordered roster changes. Off-page cursors
# snap to the page (h/l and prefix P/N), so the highlight stays visible.
settle_selection() {
  local ids_text="$1" n_ids="$2" page_size="$3" sig page_start
  case "$n_ids" in ''|*[!0-9]*) n_ids=0 ;; esac
  case "$page_size" in ''|0|*[!0-9]*) page_size=1 ;; esac
  sig="$(printf '%s\n' "$ids_text" | awk -F '\037' 'NF { print $1 }' | cksum | awk '{print $1}')"
  load_sel
  if [ "$SEL_SIG" != "$sig" ]; then
    SEL=0
    SEL_ORCH=1
    MODAL=0
    SEL_SIG="$sig"
  fi
  if [ "$n_ids" -le 0 ]; then
    SEL=0
    MODAL=0
  elif [ "$SEL" -ge "$n_ids" ]; then
    SEL=$((n_ids - 1))
    MODAL=0
  fi
  page_start=$((PAGE * page_size))
  if [ "$n_ids" -gt 0 ] && { [ "$SEL" -lt "$page_start" ] || [ "$SEL" -ge $((page_start + page_size)) ]; }; then
    SEL=$page_start
    [ "$SEL" -ge "$n_ids" ] && SEL=$((n_ids - 1))
    MODAL=0
  fi
  if [ "${SEL_ORCH:-1}" = 1 ]; then
    SEL_ID="${pin_id:-}"
    SEL_NAME="${pin_name:-${pin_id:-}}"
  else
    SEL_ID="${ID_ARR[$SEL]:-}"
    SEL_NAME="${NAME_ARR[$SEL]:-}"
  fi
  [ "${MODAL:-0}" = 1 ] || { MODAL_VIEW=card; MENU_SEL=0; ROLE_SEL=0; }
  save_sel
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
  # Pane open: selector starts on the orchestrator portrait.
  SEL=0
  SEL_ORCH=1
  MODAL=0
  SEL_SIG=""
  save_sel
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
    if apply_select_key esc; then return 0; fi
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
      # Expanded avatar: arrows move the sub-agent selector. Else ←/→ page.
      A|*A) if apply_select_key up; then return 0; fi; return 1 ;;
      B|*B) if apply_select_key down; then return 0; fi; return 1 ;;
      D|*D)
        if apply_select_key left; then return 0; fi
        page_prev; return 0 ;;
      C|*C)
        if apply_select_key right; then return 0; fi
        page_next; return 0 ;;
      H|*H) page_home; return 0 ;;
      F|*F) page_end; return 0 ;;
      1~|7~) page_home; return 0 ;;
      4~|8~) page_end; return 0 ;;
      # PgUp/PgDn page even when the arrows drive the sub-agent selector.
      5~) page_prev; return 0 ;;
      6~) page_next; return 0 ;;
    esac
    return 1
  fi
  if [ "$ch" = "O" ]; then
    if ! read_seq_char; then
      return 1
    fi
    case "$REPLY" in
      A) if apply_select_key up; then return 0; fi; return 1 ;;
      B) if apply_select_key down; then return 0; fi; return 1 ;;
      D)
        if apply_select_key left; then return 0; fi
        page_prev; return 0 ;;
      C)
        if apply_select_key right; then return 0; fi
        page_next; return 0 ;;
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
  # Ctrl+] is sb_click_wake's repaint poke (state already written by the sender).
  [ "$key" = $'\x1d' ] && return 0
  # Enter arrives as "" (read's delimiter). j/k drive the modal menu while open.
  case "$key" in
    '') if apply_select_key enter; then return 0; fi; return 1 ;;
    j|k)
      load_sel
      if [ "${MODAL:-0}" = 1 ]; then
        if apply_select_key "$key" 1; then return 0; fi
        return 1
      fi
      ;;
  esac
  case "$key" in
    # No prompt in this pane: space opens or closes the sub-agent modal.
    ' ')
      if apply_select_key space; then return 0; fi
      return 1 ;;
    # Pages: j/l/] next, k/h/[ prev. Arrows stay on the sub-agent selector.
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

# Roster JSON -> "id␟status␟svg␟collateral␟haunt␟name␟role␟loading␟wearable␟hat" rows (US-separated:
# `read` collapses runs of tab, so an empty tab field shifts every later one).
roster_ids() {
  # $2=1 includes the pinned gotchi as a mini. Used when the pane is not focused,
  # so the selected face is not a chooser sitting above the column.
  local include_pinned="${2:-0}"
  printf '%s' "${1:-}" | GOTCHI_INCLUDE_PINNED="$include_pinned" node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(d);
        const row = (id, status, svg, collateral, haunt, name, role, loading, wearable, hat, pinned) => {
          if (!id) return;
          console.log([id, status||"", svg||"", collateral||"", haunt||"", name||"", role||"", loading?"1":"0", wearable||"", hat||"", pinned?"1":"0"].join("\x1f"));
        };
        if (process.env.GOTCHI_INCLUDE_PINNED === "1" && j.pinned) {
          // The desk orchestrator stays a plain tile here (the framed portrait is the
          // focused view); a box would make every fixed-size page one tile shorter.
          row(j.pinned, j.pinnedStatus, j.pinnedSvg, "", "", j.pinnedName, j.role, 0, "", "", 1);
        }
        for (const o of (j.others||[])) {
          row(o.id, o.status, o.svg, o.collateral, o.hauntId, o.name, o.role, o.loading, o.wearable, o.hat);
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
  local collateral="${1:-}" id="${2:-}" haunt="${3:-}" size="${4:-mid}"
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
    local flag="--roster"
    [ "$size" = "mini" ] && flag="--mini"
    if [ -n "$id" ]; then
      art="$(gotchi_art "$flag" --hero "$id" --color 2>/dev/null)" || art=""
    fi
    if [ -z "$art" ] && [ -n "$collateral" ]; then
      if [ -n "$haunt" ]; then
        art="$(gotchi_art "$flag" --collateral "$collateral" --haunt "$haunt" --color 2>/dev/null)" || art=""
      else
        art="$(gotchi_art "$flag" --collateral "$collateral" --color 2>/dev/null)" || art=""
      fi
    fi
  fi
  if [ -z "$art" ] && [ "$size" = "mini" ] && [ -f "$ROOT/assets/gotchi-kanban.ascii" ]; then
    art="$(cat "$ROOT/assets/gotchi-kanban.ascii")"
  elif [ -z "$art" ] && [ -f "$ASCII_THUMB" ]; then
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

# Keep the middle `width` visible columns. SGR sequences stay so color survives
# the cut. Wider than the pane must not spill into the next desk pane.
crop_center_line() {
  local text="${1:-}" width="${2:-0}"
  vislen_set "$text"
  if [ "$width" -le 0 ] || [ "$VIS" -le "$width" ]; then
    printf '%s' "$text"
    return 0
  fi
  printf '%s' "$text" | node -e '
    const width = Number(process.argv[1]);
    let d = "";
    process.stdin.on("data", (c) => { d += c; });
    process.stdin.on("end", () => {
      const line = d.replace(/\n$/, "");
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      const skip = Math.floor((plain.length - width) / 2);
      let vis = 0, out = "", i = 0;
      while (i < line.length) {
        if (line[i] === "\x1b") {
          const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
          if (m) { out += m[0]; i += m[0].length; continue; }
        }
        if (vis >= skip && vis < skip + width) out += line[i];
        vis += 1;
        i += 1;
      }
      if (line.includes("\x1b")) out += "\x1b[0m";
      process.stdout.write(out);
    });
  ' "$width"
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

# Four mid cells for one row of the expanded side grid.
join4() {
  local a="$1" b="$2" c="$3" d="$4" gap="${5:-2}"
  local gap_s i max=0
  local -a A B C D
  gap_s="$(printf '%*s' "$gap" '')"
  if [ -n "$a" ]; then
    while IFS= read -r line || [ -n "$line" ]; do A+=("$line"); done < <(printf '%s\n' "$a")
  fi
  if [ -n "$b" ]; then
    while IFS= read -r line || [ -n "$line" ]; do B+=("$line"); done < <(printf '%s\n' "$b")
  fi
  if [ -n "$c" ]; then
    while IFS= read -r line || [ -n "$line" ]; do C+=("$line"); done < <(printf '%s\n' "$c")
  fi
  if [ -n "$d" ]; then
    while IFS= read -r line || [ -n "$line" ]; do D+=("$line"); done < <(printf '%s\n' "$d")
  fi
  max=${#A[@]}
  [ "${#B[@]}" -gt "$max" ] && max=${#B[@]}
  [ "${#C[@]}" -gt "$max" ] && max=${#C[@]}
  [ "${#D[@]}" -gt "$max" ] && max=${#D[@]}
  # Cells differ in height (a hero box is taller): pad a short cell's missing
  # rows to its width so the columns after it stay put.
  local wa=0 wb=0 wc=0
  [ "${#A[@]}" -gt 0 ] && vislen_set "${A[0]}" && wa=$VIS
  [ "${#B[@]}" -gt 0 ] && vislen_set "${B[0]}" && wb=$VIS
  [ "${#C[@]}" -gt 0 ] && vislen_set "${C[0]}" && wc=$VIS
  for ((i = 0; i < max; i++)); do
    printf '%s%s%s%s%s%s%s\n' "${A[i]:-$(printf '%*s' "$wa" '')}" "$gap_s" "${B[i]:-$(printf '%*s' "$wb" '')}" "$gap_s" "${C[i]:-$(printf '%*s' "$wc" '')}" "$gap_s" "${D[i]:-}"
  done
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

# Selected mid card: shade the whole cell and bracket the three caption lines.
emit_line() {
  local text="$1"
  if [ "${CELL_SELECTED:-0}" = 1 ] && [ -n "${AV_SEL_BG:-}" ]; then
    text="${text//$'\033[0m'/${AV_RST}${AV_SEL_BG}}"
    printf '%s%s%s\n' "$AV_SEL_BG" "$text" "$AV_RST"
    return 0
  fi
  printf '%s\n' "$text"
}

# Status word + color for a tile. Leaves STATUS_LABEL / STATUS_COLOR.
status_style() {
  case "${1:-}" in
    working|occupied) STATUS_COLOR="$AV_ST_WORKING"; STATUS_LABEL="working" ;;
    active) STATUS_COLOR="$AV_ST_ACTIVE"; STATUS_LABEL="active" ;;
    idle) STATUS_COLOR="$AV_ST_IDLE"; STATUS_LABEL="idle" ;;
    watching) STATUS_COLOR="$AV_ST_WATCH"; STATUS_LABEL="watching" ;;
    assigned) STATUS_COLOR="$AV_ST_ASSIGN"; STATUS_LABEL="assigned" ;;
    needs-worker) STATUS_COLOR="$AV_MUTED"; STATUS_LABEL="asleep" ;;
    *) STATUS_COLOR="$AV_ST_AVAIL"; STATUS_LABEL="available" ;;
  esac
}

# Hero box: a template hero (its wearable) over the cAavegotchi that works it,
# grouped in a dashed frame — wearable, arrow down, worker, then wearable name,
# role · status, and the worker with the hat it wears. A hero with no worker
# (id hero:<template>) shows an empty worker slot. cell_w is the frame width.
hero_box() {
  local id="$1" status="$2" cell_w="$3" cell_h="$4" collateral="${5:-}" haunt="${6:-}" name="${7:-}" role="${8:-}" face="${9:-mini}" wear="${10:-}" hat="${11:-}"
  local tl='┌' tr='┐' bl='└' br='┘' hz='╌' vt='╎' arrow='▼' line i max_vis lp
  if [ "${TUI_GLYPHS}" = "ascii" ]; then
    tl='+'; tr='+'; bl='+'; br='+'; hz='-'; vt=':'; arrow='v'
  fi
  local inner=$((cell_w - 2))
  [ "$inner" -lt 8 ] && inner=8
  local wrows=4
  [ "$face" = "mid" ] && wrows=5
  local -a BODY=()

  # Center a block of art lines inside the frame.
  _hb_art() {
    local -a A=()
    max_vis=0
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && [ "${#A[@]}" -eq 0 ] && continue
      A+=("$line")
      vislen_set "$line"
      [ "$VIS" -gt "$max_vis" ] && max_vis=$VIS
    done < <(printf '%s\n' "$1")
    lp=0
    [ "$inner" -gt "$max_vis" ] && lp=$(( (inner - max_vis) / 2 ))
    for ((i = 0; i < ${#A[@]}; i++)); do
      BODY+=("$(block_pad_line "${A[i]}" "$inner" "$lp")")
    done
  }

  # The worker first: the wearable is drawn exactly as tall as the gotchi.
  local worker_art="" wa
  if [ "${id#hero:}" != "$id" ]; then
    worker_art="$(printf '%b%s\n%s\n%s%b' "$AV_MUTED" "$(repeat_char "$hz" 5)" "$vt ? $vt" "$(repeat_char "$hz" 5)" "$AV_RST")"
  else
    wa="$(thumb_art "$collateral" "$id" "$haunt" "$face")"
    worker_art="$(printf '%s\n' "$wa" | { head -n "$cell_h" || true; })"
  fi
  tile_lines "$worker_art"
  [ "${TILE_LINES:-0}" -ge 3 ] && wrows=$TILE_LINES

  local wart=""
  if command -v node >/dev/null && [ -f "$ROOT/scripts/hero-wearable.mjs" ]; then
    wart="$(node "$ROOT/scripts/hero-wearable.mjs" art "$role" --rows "$wrows" --width "$inner" --exact --color-mode "${TUI_COLOR:-truecolor}" 2>/dev/null)" || wart=""
  fi
  [ -z "$wart" ] && wart="$(printf '%b%s%b' "$AV_MUTED" "◇" "$AV_RST")"
  # Always wrows tall (a missing or short wearable is centred), so every box
  # with a worker is the same height and the column's page math holds.
  tile_lines "$wart"
  local wpad=$((wrows - TILE_LINES)) wtop
  if [ "$wpad" -gt 0 ]; then
    wtop=$((wpad / 2))
    for ((i = 0; i < wtop; i++)); do BODY+=(" "); done
    _hb_art "$wart"
    for ((i = 0; i < wpad - wtop; i++)); do BODY+=(" "); done
  else
    _hb_art "$wart"
  fi
  BODY+=("$(printf '%b%s%b' "$AV_MUTED" "$(center_pad "$arrow" "$inner")" "$AV_RST")")
  _hb_art "$worker_art"

  status_style "$status"
  local wear_show="${wear:-${role//-/ }}" role_line who
  wear_show="${wear_show:0:$inner}"
  BODY+=("$(printf '%b%s%b' "$AV_ROLE_GAL" "$(center_pad "$wear_show" "$inner")" "$AV_RST")")
  # Role and status each get their own line.
  role_line="${role//-/ }"
  role_line="${role_line:0:$inner}"
  BODY+=("$(printf '%b%s%b' "$AV_ROSTER" "$(center_pad "$role_line" "$inner")" "$AV_RST")")
  BODY+=("$(printf '%b%s%b' "$STATUS_COLOR" "$(center_pad "$STATUS_LABEL" "$inner")" "$AV_RST")")
  if [ "${id#hero:}" != "$id" ]; then
    who="needs a worker"
    BODY+=("$(printf '%b%s%b' "$AV_ST_ASSIGN" "$(center_pad "${who:0:$inner}" "$inner")" "$AV_RST")")
  else
    who="${name:-$id}"
    [ -n "$hat" ] && who="${who} · ${hat}"
    BODY+=("$(printf '%b%s%b' "$AV_ROSTER" "$(center_pad "${who:0:$inner}" "$inner")" "$AV_RST")")
  fi

  local edge
  edge="$(repeat_char "$hz" "$inner")"
  emit_line "$(printf '%b%s%s%s%b' "$AV_MUTED" "$tl" "$edge" "$tr" "$AV_RST")"
  for ((i = 0; i < ${#BODY[@]}; i++)); do
    emit_line "$(printf '%b%s%b%s%b%s%b' "$AV_MUTED" "$vt" "$AV_RST" "$(pad_cell_line "${BODY[i]}" "$inner")" "$AV_MUTED" "$vt" "$AV_RST")"
  done
  emit_line "$(printf '%b%s%s%s%b' "$AV_MUTED" "$bl" "$edge" "$br" "$AV_RST")"
}

cell_block() {
  local id="$1" status="$2" svg="$3" cell_w="$4" cell_h="$5" collateral="${6:-}" haunt="${7:-}" name="${8:-}" role="${9:-}" loading="${10:-}" face="${11:-mini}"
  CELL_SELECTED=0
  [ "${12:-0}" = 1 ] && CELL_SELECTED=1
  # A gotchi working a hero (or a hero with no worker yet) draws as a hero box.
  if [ -z "$loading" ] && [ -n "${13:-}" ] && [ -n "$role" ] && [ "${GOTCHIBOT_HERO_BOX:-1}" = 1 ]; then
    hero_box "$id" "$status" "$cell_w" "$cell_h" "$collateral" "$haunt" "$name" "$role" "$face" "${13:-}" "${14:-}"
    return 0
  fi
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
  # Template portraits reserved at assets/templates/<id>.png (Julius). Missing file keeps the glyph.
  local template_png=""
  if [ -n "$id" ]; then
    template_png="$ROOT/assets/templates/${id}.png"
  fi
  if [ -z "${art:-}" ] && [ -n "$template_png" ] && [ -f "$template_png" ]; then
    art="$(mini_chafa "$template_png" "$cell_w" "$cell_h")"
  fi
  if [ -z "${art:-}" ] && [ "${GOTCHIBOT_THUMB_CHAFA:-0}" = "1" ]; then
    art="$(mini_chafa "$svg" "$cell_w" "$cell_h")"
  fi
  if [ -z "${art:-}" ]; then
    art="$(thumb_art "$collateral" "$id" "$haunt" "$face")"
  fi
  local line id_show pane_w max_vis lp i
  # One column: center on the full pane. Three mid columns: center in the cell.
  pane_w=$cell_w
  if [ "${ROSTER_COLS:-1}" = 1 ]; then
    pane_w=$(( cell_w + ${ROSTER_PAD:-0} ))
  fi
  [ "$pane_w" -lt 1 ] && pane_w=$cell_w
  if [ -n "${art:-}" ]; then
    art="$(printf '%s\n' "$art" | { head -n "$cell_h" || true; })"
    local -a ART_LINES=()
    max_vis=0
    while IFS= read -r line || [ -n "$line" ]; do
      ART_LINES+=("$line")
      vislen_set "$line"
      [ "$VIS" -gt "$max_vis" ] && max_vis=$VIS
    done < <(printf '%s\n' "$art")
    lp=0
    if [ "$pane_w" -gt "$max_vis" ]; then
      lp=$(( (pane_w - max_vis) / 2 ))
    fi
    for ((i = 0; i < ${#ART_LINES[@]}; i++)); do
      emit_line "$(block_pad_line "${ART_LINES[i]}" "$pane_w" "$lp")"
    done
  fi
  if [ "$CELL_SELECTED" = 1 ]; then
    local inner=$((pane_w - 2)) ml="[" mr="]"
    [ "$inner" -lt 1 ] && inner=1
    [ "${TUI_GLYPHS}" != "ascii" ] && ml="▌" && mr="▐"
    emit_line "$(printf '%b%s%b%s%b%s%b' "$AV_LIT" "$ml" "$status_color" "$(center_pad "$label" "$inner")" "$AV_LIT" "$mr" "$AV_RST")"
    id_show="${name:-$id}"
    id_show="${id_show:0:$inner}"
    emit_line "$(printf '%b%s%b%s%b%s%b' "$AV_LIT" "$ml" "$AV_ROSTER" "$(center_pad "$id_show" "$inner")" "$AV_LIT" "$mr" "$AV_RST")"
    local role_show="${role//-/ }" role_color="$AV_ROLE_GAL"
    [ -z "$role" ] && role_show="no role" && role_color="$AV_MUTED"
    role_show="${role_show:0:$inner}"
    emit_line "$(printf '%b%s%b%s%b%s%b' "$AV_LIT" "$ml" "$role_color" "$(center_pad "$role_show" "$inner")" "$AV_LIT" "$mr" "$AV_RST")"
  else
    emit_line "$(printf '%b%s%b' "$status_color" "$(center_pad "$label" "$pane_w")" "$AV_RST")"
    id_show="${name:-$id}"
    id_show="${id_show:0:$pane_w}"
    emit_line "$(printf '%b%s%b' "$AV_ROSTER" "$(center_pad "$id_show" "$pane_w")" "$AV_RST")"
    local role_show="${role//-/ }" role_color="$AV_ROLE_GAL"
    [ -z "$role" ] && role_show="no role" && role_color="$AV_MUTED"
    role_show="${role_show:0:$pane_w}"
    emit_line "$(printf '%b%s%b' "$role_color" "$(center_pad "$role_show" "$pane_w")" "$AV_RST")"
  fi
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

  # assets/templates/<id>.png when Julius has dropped it; otherwise the glyph below.
  local template_png=""
  [ -n "$hero_id" ] && template_png="$ROOT/assets/templates/${hero_id}.png"
  if [ -z "$body" ] && [ -n "$template_png" ] && [ -f "$template_png" ] && command -v chafa >/dev/null; then
    body="$(chafa --size "${chafa_w}x${chafa_h}" --symbols "$AV_CHAFA_SYMBOLS" $AV_CHAFA_COLORS --animate off "$template_png" 2>/dev/null \
      | sed -e 's/\x1b\[[?][0-9;]*[hl]//g')" || body=""
    if [ -n "$body" ]; then
      ART_CACHE="$body"
      ART_CACHE_STATUS="png:$hero_id:${TUI_COLOR}/${TUI_GLYPHS}"
    fi
  fi

  if [ "$use_static" = 0 ] && [ -z "$body" ] && [ -n "$hero_id" ] && command -v chafa >/dev/null && command -v node >/dev/null; then
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
  # Hotkey legend owns the last row. The body lays out in the rows above it.
  ph="$(pane_height)"
  local legend=0 body_h="$ph"
  if [ -z "$(gallery_hero)" ] && [ "$ph" -ge 16 ]; then
    legend=1
    body_h=$((ph - 1))
    PANE_H_CACHE="$body_h"
  fi
  render_body "$status" || true
  for ((r = RENDER_MAX_ROW + 1; r <= LAST_MAX_ROW && r < body_h; r++)); do
    printf '\033[%d;1H\033[K' "$((r + 1))"
  done
  LAST_MAX_ROW="$RENDER_MAX_ROW"
  if [ "$legend" = 1 ]; then
    PANE_H_CACHE="$ph"
    draw_key_legend "$((ph - 1))" "$(pane_width)"
  fi
  printf '\033[1;1H\033[?2026l'
  if [ "$locked" = 1 ]; then
    pane_dims_unlock
  fi
}

# Bottom-row hotkey legend. Focused: in-pane keys. Elsewhere: the prefix keys
# that reach the roster from any pane.
draw_key_legend() {
  local row="$1" cols="$2" text pad
  case "$cols" in ''|*[!0-9]*) return 0 ;; esac
  if [ "${EXPANDED:-0}" = 1 ]; then
    text="j/k page · arrows select · space/⏎ card · esc close"
    [ "${#text}" -gt "$cols" ] && text="j/k page · arrows · space card"
  else
    text="^Space j/k select · ^Space ⏎ card · ^Space P/N page"
    [ "${#text}" -gt "$cols" ] && text="^Spc j/k sel · ⏎ card · P/N pg"
  fi
  [ "${#text}" -gt "$cols" ] && text="${text:0:$cols}"
  pad=$(( (cols - ${#text}) / 2 ))
  [ "$pad" -lt 0 ] && pad=0
  printf '\033[%d;1H\033[K%*s%b%s%b' "$((row + 1))" "$pad" '' "$AV_MUTED" "$text" "$AV_RST"
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
  local line_out
  for ((i = 0; i < art_n; i++)); do
    [ "$n" -ge "$max_rows" ] && break
    line_out="${ART_LINES[i]}"
    if [ "$cols" -gt 0 ] && [ "$max_vis" -gt "$cols" ]; then
      line_out="$(crop_center_line "$line_out" "$cols")"
    fi
    block_pad_line "$line_out" "$cols" "$block_lp"
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
    local warm_face=mini
    [ "${WARM_H:-0}" -ge 9 ] && warm_face=mid
    memo_call v "r|cell|${TUI_COLOR}/${TUI_GLYPHS}|${W_ID[i]}|${W_ST[i]}|${W_COL[i]}|${W_HAUNT[i]}|${W_NAME[i]}|${W_ROLE[i]}||$WARM_W|$WARM_H|$warm_face|${W_WEAR[i]:-}|${W_HAT[i]:-}" \
      cell_block "${W_ID[i]}" "${W_ST[i]}" "${W_SVG[i]}" "$WARM_W" "$WARM_H" "${W_COL[i]}" "${W_HAUNT[i]}" "${W_NAME[i]}" "${W_ROLE[i]}" "" "$warm_face" 0 "${W_WEAR[i]:-}" "${W_HAT[i]:-}"
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


# collapsed: the whole pane is a single column of minis. No selected header.
# focused: the portrait is the left column. The right column is 4 columns by
# 3 rows. Each card is 12 lines: 9 art + status, name, and role.
roster_budget() {
  local pane_h="${1:-0}" mode="${2:-collapsed}" mini=6 remain stride=12 rows
  # Hero boxes (frame + wearable + arrow + worker + 3 lines) need more rows a tile.
  if [ "${HERO_VIEW:-0}" = 1 ]; then
    stride=20
  fi
  case "$pane_h" in
    ''|*[!0-9]*) pane_h=0 ;;
  esac
  if [ "$mode" = "focused" ]; then
    rows=$((pane_h / stride))
    [ "$rows" -gt 3 ] && rows=3
    [ "$rows" -lt 1 ] && rows=1
    ROSTER_ROWS=$rows
    ROSTER_COLS_N=4
    ROSTER_PAGE=$((rows * ROSTER_COLS_N))
    ROSTER_GRID=$pane_h
    return 0
  fi
  ROSTER_COLS_N=1
  ROSTER_ROWS=1
  remain=$pane_h
  [ "$remain" -lt "$mini" ] && remain=$mini
  ROSTER_PAGE=$((remain / mini))
  [ "$ROSTER_PAGE" -lt 1 ] && ROSTER_PAGE=1
  ROSTER_GRID=$remain
}

# One column. One pad column when the pane can spare it; the cell is the rest.
roster_geometry() {
  local cols="${1:-0}" mode="${2:-collapsed}"
  if [ "$mode" = "wide" ]; then
    local gap=2 gaps pad avail
    ROSTER_PAD=0
    ROSTER_COLS=4
    gaps=$((gap * (ROSTER_COLS - 1)))
    ROSTER_CELL_W=12
    ROSTER_ROW_W=$((ROSTER_CELL_W * ROSTER_COLS + gaps))
    for pad in 0; do
      [ "$cols" -lt 1 ] && pad=0
      avail=$((cols - pad - gaps))
      if [ "$avail" -lt 0 ]; then
        ROSTER_CELL_W=12
      else
        ROSTER_CELL_W=$((avail / ROSTER_COLS))
      fi
      [ "$ROSTER_CELL_W" -lt 12 ] && ROSTER_CELL_W=12
      [ "$ROSTER_CELL_W" -gt 22 ] && ROSTER_CELL_W=22
      ROSTER_ROW_W=$((ROSTER_CELL_W * ROSTER_COLS + gaps))
      ROSTER_PAD=$pad
      break
    done
    return 0
  fi
  ROSTER_COLS=1
  ROSTER_PAD=0
  [ "$cols" -ge 12 ] && ROSTER_PAD=1
  ROSTER_CELL_W=$((cols - ROSTER_PAD))
  [ "$ROSTER_CELL_W" -lt 10 ] && ROSTER_CELL_W=10
  if [ $((ROSTER_PAD + ROSTER_CELL_W)) -gt "$cols" ] && [ "$cols" -ge 10 ]; then
    ROSTER_PAD=0
    ROSTER_CELL_W=$cols
  fi
  ROSTER_ROW_W=$ROSTER_CELL_W
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


repeat_char() {
  local ch="$1" n="$2" i out=""
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  for ((i = 0; i < n; i++)); do
    out="${out}${ch}"
  done
  printf '%s' "$out"
}

modal_put() {
  local row="$1" col="$2" text="$3"
  [ "$row" -ge 0 ] || return 0
  [ "$col" -lt 0 ] && col=0
  printf '\033[%d;%dH%s' "$((row + 1))" "$((col + 1))" "$text"
  [ "$row" -gt "$RENDER_MAX_ROW" ] && RENDER_MAX_ROW="$row"
}

# Dossier-style overlay for the selected sub-agent. Display only.
# Close with esc or space (same keys the pane already handles).
draw_sub_modal() {
  local name="$1" role="$2" status="$3" cols="$4" pane_h="$5" id="$6"
  [ -n "$name" ] || name="${id:-sub-agent}"
  local role_show="${role//-/ }"
  [ -z "$role" ] && role_show="no role"
  [ -n "$status" ] || status="available"
  local tl="+" tr="+" bl="+" br="+" hz="-" vt="|"
  if [ "${TUI_GLYPHS}" != "ascii" ]; then
    tl="┌"; tr="┐"; bl="└"; br="┘"; hz="─"; vt="│"
  fi
  local inner=34
  if [ "$cols" -lt $((inner + 4)) ]; then
    inner=$((cols - 4))
  fi
  [ "$inner" -lt 12 ] && inner=12
  local width=$((inner + 2))
  local left=$(( (cols - width) / 2 ))
  [ "$left" -lt 0 ] && left=0
  local bg="${AV_SEL_BG:-}" fg="" rst="$AV_RST"
  if [ -n "$bg" ]; then
    case "${TUI_COLOR}" in
      16) fg=$'\033[97m' ;;
      none) fg="" ;;
      *) fg=$'\033[38;5;255m' ;;
    esac
  fi
  # Body rows: "text" plain, ">text" selected (reverse video), "~text" dim.
  local -a ROWS=()
  local i
  if [ "${MODAL_VIEW:-card}" = roles ]; then
    load_role_list
    local n=$(( ${#ROLE_LIST[@]} + 1 )) win top_i label cur="${role:-}"
    ROWS+=(" assign role · ${name}" "")
    win=$(( pane_h - 8 ))
    [ "$win" -gt 12 ] && win=12
    [ "$win" -lt 3 ] && win=3
    top_i=$(( ROLE_SEL - win / 2 ))
    [ "$top_i" -gt $(( n - win )) ] && top_i=$(( n - win ))
    [ "$top_i" -lt 0 ] && top_i=0
    for ((i = top_i; i < n && i < top_i + win; i++)); do
      if [ "$i" -eq 0 ]; then
        label="← back"
      else
        label="${ROLE_LIST[$((i - 1))]//-/ }"
        [ "${ROLE_LIST[$((i - 1))]}" = "$cur" ] && label="$label  (current)"
      fi
      if [ "$i" -eq "${ROLE_SEL:-0}" ]; then ROWS+=("> ▸ $label"); else ROWS+=("   $label"); fi
    done
    ROWS+=("" "~ ↑↓ move · ⏎ assign · esc back")
  else
    modal_menu_build
    local status_row=" ${status}"
    [ -n "${MODAL_TRUST:-}" ] && status_row=" ${status} · ${MODAL_TRUST}"
    ROWS+=(" ${name}" " ${role_show}" "$status_row" "")
    for ((i = 0; i < ${#MODAL_MENU[@]}; i++)); do
      if [ "$i" -eq "${MENU_SEL:-0}" ]; then ROWS+=("> ▸ ${MODAL_MENU[i]}"); else ROWS+=("   ${MODAL_MENU[i]}"); fi
    done
    [ -n "${MODAL_MSG:-}" ] && ROWS+=("" " ${MODAL_MSG}")
    ROWS+=("" "~ ↑↓ move · ⏎ choose · esc close")
  fi
  local box_h=$(( ${#ROWS[@]} + 2 ))
  local top=$(( (pane_h - box_h) / 2 ))
  [ "$top" -lt 0 ] && top=0
  local bar r text sel_on=$'\033[7m' dim_on="$AV_MUTED"
  bar="$(repeat_char "$hz" "$inner")"
  modal_put "$top" "$left" "${bg}${fg}${tl}${bar}${tr}${rst}"
  for ((i = 0; i < ${#ROWS[@]}; i++)); do
    r="${ROWS[i]}"
    case "$r" in
      ">"*)
        text="${r:1}"
        text="${text:0:$inner}"
        modal_put $((top + 1 + i)) "$left" "${bg}${fg}${vt}${sel_on}${text}$(printf '%*s' "$((inner - ${#text}))" '')${rst}${bg}${fg}${vt}${rst}"
        ;;
      "~"*)
        modal_put $((top + 1 + i)) "$left" "$(modal_row "${r:1}" "$inner" "$bg" "${fg}${dim_on}" "$vt" "$rst")"
        ;;
      *)
        modal_put $((top + 1 + i)) "$left" "$(modal_row "$r" "$inner" "$bg" "$fg" "$vt" "$rst")"
        ;;
    esac
  done
  modal_put $((top + 1 + ${#ROWS[@]})) "$left" "${bg}${fg}${bl}${bar}${br}${rst}"
}

# Card for whatever the selector is on: the orch portrait or a grid card.
# Uses render_body's locals (pin_id, pin_name, status, *_ARR).
draw_selected_modal() {
  local cols="$1" pane_h="$2" orch_role
  if [ "${SEL_ORCH:-1}" = 1 ]; then
    orch_role="$(node -e 'try{const r=require(process.argv[1]);console.log(r[process.argv[2]]||"")}catch{}' "$ROOT/config/agent-roles.json" "${pin_id:-}" 2>/dev/null)"
    draw_sub_modal "${pin_name:-${pin_id:-}}" "$orch_role" "${status:-}" "$cols" "$pane_h" "${pin_id:-}"
  else
    draw_sub_modal "${NAME_ARR[$SEL]:-}" "${ROLE_ARR[$SEL]:-}" "${ST_ARR[$SEL]:-}" "$cols" "$pane_h" "${ID_ARR[$SEL]:-}"
  fi
}

modal_row() {
  local text="$1" inner="$2" bg="$3" fg="$4" vt="$5" rst="$6" cut pad
  cut="${text:0:$inner}"
  pad=$((inner - ${#cut}))
  [ "$pad" -lt 0 ] && pad=0
  printf '%s%s%s%s%*s%s%s' "$bg" "$fg" "$vt" "$cut" "$pad" '' "$vt" "$rst"
}

# Lines a tile draws (the column loop skips blank lines, so they do not count).
tile_lines() {
  local n=0 l
  while IFS= read -r l || [ -n "$l" ]; do
    [ -n "$l" ] && n=$((n + 1))
  done < <(printf '%s\n' "$1")
  TILE_LINES=$n
}

# Largest fixed page size whose every page fits in $3 rows. Heights are measured
# once per kind — plain tile, hero box, loading tile — from the first of each.
# Reads ID/ST/…/WEAR/HAT_ARR from render_body. Leaves FIT_PAGE.
fit_collapsed_page() {
  local cw="$1" ch="$2" avail="$3" n="$4" i k ok sum start kind tile=""
  local hp=0 hb=0 hu=0 hl=0 ho=0
  local -a H=()
  [ "$avail" -lt 1 ] && avail=1
  for ((i = 0; i < n; i++)); do
    kind=p
    if [ "${PIN_ARR[i]:-0}" = 1 ]; then kind=o
    elif [ -n "${LOAD_ARR[i]:-}" ]; then kind=l
    elif [ -n "${WEAR_ARR[i]:-}" ] && [ -n "${ROLE_ARR[i]:-}" ] && [ "${GOTCHIBOT_HERO_BOX:-1}" = 1 ]; then
      kind=b
      # A hero with no worker has a shorter (3-row) worker slot and wearable.
      [ "${ID_ARR[i]#hero:}" != "${ID_ARR[i]}" ] && kind=u
    fi
    case "$kind" in
      p) if [ "$hp" = 0 ]; then
           memo_call tile "fit|p|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|$cw|$ch" \
             cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cw" "$ch" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "" mini 0 "" ""
           tile_lines "$tile"; hp=$TILE_LINES
         fi
         H+=("$hp") ;;
      b) if [ "$hb" = 0 ]; then
           memo_call tile "fit|b|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|$cw|$ch|${WEAR_ARR[i]}" \
             cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cw" "$ch" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "" mini 0 "${WEAR_ARR[i]}" "${HAT_ARR[i]}"
           tile_lines "$tile"; hb=$TILE_LINES
         fi
         H+=("$hb") ;;
      u) if [ "$hu" = 0 ]; then
           memo_call tile "fit|u|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|$cw|$ch|${WEAR_ARR[i]}" \
             cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cw" "$ch" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "" mini 0 "${WEAR_ARR[i]}" ""
           tile_lines "$tile"; hu=$TILE_LINES
         fi
         H+=("$hu") ;;
      o) if [ "$ho" = 0 ]; then
           memo_call tile "fit|o|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|$cw|$ORCH_CELL_H" \
             cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cw" "$ORCH_CELL_H" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "" mid 0 "" ""
           tile_lines "$tile"; ho=$TILE_LINES
         fi
         H+=("$ho") ;;
      l) if [ "$hl" = 0 ]; then
           tile_lines "$(loading_art 0)"; hl=$((TILE_LINES + 3))
         fi
         H+=("$hl") ;;
    esac
  done
  for ((k = n; k > 1; k--)); do
    ok=1
    for ((start = 0; start < n && ok; start += k)); do
      sum=0
      for ((i = start; i < start + k && i < n; i++)); do sum=$((sum + H[i])); done
      [ "$sum" -gt "$avail" ] && ok=0
    done
    [ "$ok" = 1 ] && break
  done
  FIT_PAGE=$k
  FIT_H=("${H[@]}")
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

  local expanded=0
  # Gallery is its own large-face mode. The desk column expands only while
  # this pane is focused; every other pane keeps the collapsed minis.
  if [ "$gallery" = 1 ] || avatar_pane_focused; then
    expanded=1
  fi
  HERO_VIEW=0
  if [ "${GOTCHIBOT_HERO_BOX:-1}" = 1 ] && [ -f "$ROSTER_CACHE" ] && grep -q '"wearable": *"' "$ROSTER_CACHE" 2>/dev/null; then
    HERO_VIEW=1
  fi
  if [ "$expanded" = 1 ] && [ "$gallery" != 1 ]; then
    roster_budget "$pane_h" focused
  else
    roster_budget "$pane_h" collapsed
  fi
  local grid_budget="$ROSTER_GRID"
  local roster_rows="$ROSTER_ROWS"
  # -7: the 3-line caption (status · name · role) plus room for the roster's prev/next row.
  local main_budget=$((pane_h - grid_budget - 7))
  [ "$main_budget" -lt 10 ] && main_budget=10
  # Meet-gallery tiles: face + caption only (no roster strip).
  if [ "$gallery" = 1 ]; then
    main_budget=$((pane_h - 2))
    [ "$main_budget" -lt 6 ] && main_budget=6
    grid_budget=0
  fi
  # Expanded desk: portrait is the left column, so it is not squeezed by a
  # roster strip underneath it.
  if [ "$expanded" = 1 ] && [ "$gallery" != 1 ]; then
    main_budget=$pane_h
    [ "$main_budget" -gt 30 ] && main_budget=30
  fi

  # Gallery, and the desk column while this pane is focused, use the framed
  # portrait. Unfocused, the header stays empty so the column is only minis.
  local main=""
  if [ "$gallery" = 1 ] || [ "$expanded" = 1 ]; then
    memo_call main "art|${TUI_COLOR}/${TUI_GLYPHS}|${MEMO_FOCUS_HERO:-}|${MEMO_ORCH_ID:-}|$status|$cols|$main_budget|$expanded" \
      render_main_art "$status" "$cols" "$main_budget"
  fi

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
  load_sel
  if [ "${SEL_ORCH:-1}" = 1 ]; then
    # Selector on the orch: bracket and shade the caption like a selected card.
    local cw=${#status} ml="[" mr="]" sb="${AV_SEL_BG:-}"
    [ ${#pin_name} -gt "$cw" ] && cw=${#pin_name}
    [ -z "$pin_name" ] && [ ${#pin_id} -gt "$cw" ] && cw=${#pin_id}
    [ ${#role} -gt "$cw" ] && cw=${#role}
    cw=$((cw + 2))
    [ "${TUI_GLYPHS}" != "ascii" ] && ml="▌" && mr="▐"
    caption="$(printf '%s%b%s%b%s%b%s%b\n%s%b%s%b%s%b%s%b\n%s%b%s%b%s%b%s%b' \
      "$sb" "$AV_LIT" "$ml" "$status_color" "$(center_pad "$status" "$cw")" "$AV_LIT" "$mr" "$AV_RST" \
      "$sb" "$AV_LIT" "$ml" "$AV_ROSTER" "$(center_pad "${pin_name:-$pin_id}" "$cw")" "$AV_LIT" "$mr" "$AV_RST" \
      "$sb" "$AV_LIT" "$ml" "$role_color" "$(center_pad "$role" "$cw")" "$AV_LIT" "$mr" "$AV_RST")"
  else
    caption="$(printf '%b%s%b\n%b%s%b\n%b%s%b' \
      "$status_color" "$status" "$AV_RST" \
      "$AV_ROSTER" "${pin_name:-$pin_id}" "$AV_RST" \
      "$role_color" "$role" "$AV_RST")"
  fi
  if [ -n "$active_line" ]; then
    caption="${caption}"$'\n'"$(printf '%b%s%b' "$AV_MUTED" "$active_line" "$AV_RST")"
  fi

  # Focused: framed portrait on the left. Unfocused: no selected face.
  local side=0 LEFT_BLOCK="" LEFT_W=42
  if [ "$expanded" = 1 ]; then
    local hdr hdr_cols="$cols"
    if [ "$gallery" != 1 ]; then
      side=1
      [ "$LEFT_W" -ge $((cols - 20)) ] && LEFT_W=$((cols / 3))
      [ "$LEFT_W" -lt 38 ] && LEFT_W=38
      hdr_cols=$LEFT_W
    fi
    memo_call hdr "hdr|${TUI_COLOR}/${TUI_GLYPHS}|${MEMO_FOCUS_HERO:-}|${MEMO_ORCH_ID:-}|$status|$hdr_cols|$main_budget|$role|$pin_show|$active_line|$expanded|$side|${SEL_ORCH:-1}" \
      render_header_block "$main" "$caption" "$hdr_cols" "$main_budget"
    if [ "$side" = 1 ]; then
      LEFT_BLOCK="$hdr"
    else
      while IFS= read -r line || [ -n "$line" ]; do
        put_line "$row" "$line"
        row=$((row + 1))
      done < <(printf '%s\n' "$hdr")
      if [ "$gallery" = 1 ]; then
        printf '\033[1;1H'
        return
      fi
    fi
  fi

  roster_raw="$(load_roster_json)"

  local ids ids_key
  # Key on the payload, not a bare "ids". A refresh that rewrote the cache
  # must not replay the previous strip order from the memo.
  local include_pinned=0
  [ "$expanded" != 1 ] && include_pinned=1
  ids_key="ids|$include_pinned|$(printf '%s' "$roster_raw" | cksum | awk '{print $1}')"
  memo_call ids "$ids_key" roster_ids "$roster_raw" "$include_pinned"

  if [ -z "$(printf '%s' "$ids" | tr -d '[:space:]')" ]; then
    if [ "$side" = 1 ]; then
      row=0
      while IFS= read -r line || [ -n "$line" ]; do
        put_line "$row" "$line"
        row=$((row + 1))
      done < <(printf '%s\n' "$LEFT_BLOCK")
    else
      put_line "$row" "$(printf '%b(none else on cartridge)%b' "$AV_MUTED" "$AV_RST")"
    fi
    EXPANDED=0
    [ "$side" = 1 ] && EXPANDED=1
    N_IDS=0
    save_page_env
    printf '\033[1;1H'
    return
  fi

  local face=mini right_w="$cols"
  # Expanded pane: mid thumbs, four across, on the right of the portrait.
  # Collapsed: one column of minis.
  if [ "$side" = 1 ]; then
    face=mid
    right_w=$((cols - LEFT_W - 2))
    [ "$right_w" -lt 54 ] && right_w=54
    roster_geometry "$right_w" wide
  else
    roster_geometry "$cols"
  fi
  local gap=2
  local cell_w="$ROSTER_CELL_W"
  local cell_h=5
  [ "$face" = "mid" ] && cell_h=9
  ORCH_CELL_H=9

  # LOAD_ARR holds the spinner frame for a loading tile, empty once it resolved.
  local -a ID_ARR ST_ARR SVG_ARR COL_ARR HAUNT_ARR NAME_ARR ROLE_ARR LOAD_ARR WEAR_ARR HAT_ARR PIN_ARR
  while IFS=$'\x1f' read -r iid ist isvg icol ihaunt iname irole iload iwear ihat ipin; do
    [ -z "$iid" ] && continue
    ID_ARR+=("$iid")
    ST_ARR+=("$ist")
    SVG_ARR+=("$isvg")
    COL_ARR+=("$icol")
    HAUNT_ARR+=("$ihaunt")
    NAME_ARR+=("$iname")
    ROLE_ARR+=("$irole")
    WEAR_ARR+=("$iwear")
    HAT_ARR+=("$ihat")
    PIN_ARR+=("${ipin:-0}")
    if [ "$iload" = 1 ] && [ "$SECONDS" -lt "$AV_LOADING_MAX" ]; then
      LOAD_ARR+=("$((SPIN_FRAME % ${#AV_SPIN[@]}))")
    else
      LOAD_ARR+=("")
    fi
  done < <(printf '%s\n' "$ids")

  load_page
  local n_ids="${#ID_ARR[@]}"
  local page_size="$ROSTER_PAGE"
  [ -n "$page_size" ] || page_size=3
  # Collapsed column: size the page from what the tiles really measure (a hero
  # box is taller than a plain tile), so the column fills instead of guessing.
  if [ "$side" != 1 ] && [ "$n_ids" -gt 0 ]; then
    fit_collapsed_page "$cell_w" "$cell_h" "$((pane_h - row - 3))" "$n_ids"
    page_size=$FIT_PAGE
  fi
  NPAGES=$(( (n_ids + page_size - 1) / page_size ))
  [ "$NPAGES" -lt 1 ] && NPAGES=1
  clamp_page
  save_page
  settle_selection "$ids" "$n_ids" "$page_size"

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
  W_WEAR=("${WEAR_ARR[@]}")
  W_HAT=("${HAT_ARR[@]}")
  W_LOAD=("${LOAD_ARR[@]}")

  local i base left k1 r vi end mid right pair k2 k3
  base=$((PAGE * page_size))
  LOADING_VISIBLE=0
  end=$((base + page_size))
  [ "$end" -gt "$n_ids" ] && end="$n_ids"
  for ((vi = base; vi < end; vi++)); do
    if [ -n "${LOAD_ARR[vi]:-}" ]; then
      LOADING_VISIBLE=1
      break
    fi
  done
  local GRID_BLOCK="" c0 c1 c2 c3 k4 slot
  if [ "$side" = 1 ]; then
    for ((r = 0; r < roster_rows; r++)); do
      i=$((base + r * ROSTER_COLS))
      [ "$i" -ge "$n_ids" ] && break
      c0=""; c1=""; c2=""; c3=""; k1=""; k2=""; k3=""; k4=""
      for slot in 0 1 2 3; do
        vi=$((i + slot))
        [ "$vi" -ge "$n_ids" ] && continue
        sel_flag=0
        [ "${SEL_ORCH:-1}" != 1 ] && [ "$vi" -eq "${SEL:-0}" ] && sel_flag=1
        k1="g|cell|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[vi]}|${ST_ARR[vi]}|${COL_ARR[vi]}|${HAUNT_ARR[vi]}|${NAME_ARR[vi]}|${ROLE_ARR[vi]}|${LOAD_ARR[vi]}|$cell_w|$cell_h|$face|$sel_flag|${WEAR_ARR[vi]}|${HAT_ARR[vi]}"
        memo_call left "$k1" \
          cell_block "${ID_ARR[vi]}" "${ST_ARR[vi]}" "${SVG_ARR[vi]}" "$cell_w" "$cell_h" "${COL_ARR[vi]}" "${HAUNT_ARR[vi]}" "${NAME_ARR[vi]}" "${ROLE_ARR[vi]}" "${LOAD_ARR[vi]}" "$face" "$sel_flag" "${WEAR_ARR[vi]}" "${HAT_ARR[vi]}"
        case "$slot" in
          0) c0="$left"; k1s="$k1" ;;
          1) c1="$left"; k2="$k1" ;;
          2) c2="$left"; k3="$k1" ;;
          3) c3="$left"; k4="$k1" ;;
        esac
      done
      [ -z "$c0" ] && c0="$(blank_block "$cell_w" 12)"
      [ -z "$c1" ] && c1="$(blank_block "$cell_w" 12)"
      [ -z "$c2" ] && c2="$(blank_block "$cell_w" 12)"
      [ -z "$c3" ] && c3="$(blank_block "$cell_w" 12)"
      pair="$(join4 "$c0" "$c1" "$c2" "$c3" "$gap")"
      if [ -n "$GRID_BLOCK" ]; then
        GRID_BLOCK="${GRID_BLOCK}"$'
'"${pair}"
      else
        GRID_BLOCK="$pair"
      fi
    done
    local -a L G
    local li gi nmax gap_s lft gline
    gap_s="  "
    while IFS= read -r li || [ -n "$li" ]; do L+=("$li"); done < <(printf '%s\n' "$LEFT_BLOCK")
    while IFS= read -r gi || [ -n "$gi" ]; do G+=("$gi"); done < <(printf '%s\n' "$GRID_BLOCK")
    # Center the portrait column and the 4 by 3 grid as one block.
    # bash 3.2: local x=${#arr[@]} in a multi-assign leaves the name unbound
    # and set -u kills the pane (Files then swallows the row).
    local llen glen block_h pager
    llen=${#L[@]}
    glen=${#G[@]}
    block_h=$llen
    pager=0
    [ "$glen" -gt "$block_h" ] && block_h=$glen
    if [ "$NPAGES" -gt 1 ]; then
      pager=1
      [ $((glen + 1)) -gt "$block_h" ] && block_h=$((glen + 1))
    fi
    expanded_vpad "$pane_h" "$block_h"
    local top=$EXPANDED_TOP row lft gline
    for ((i = 0; i < top && i < pane_h; i++)); do
      put_line "$i" ""
    done
    local nlines=$llen
    [ "$glen" -gt "$nlines" ] && nlines=$glen
    for ((i = 0; i < nlines; i++)); do
      row=$((top + i))
      [ "$row" -ge "$pane_h" ] && break
      lft=""
      if [ "$i" -lt "$llen" ]; then
        lft="${L[i]}"
      fi
      lft="$(pad_cell_line "$lft" "$LEFT_W")"
      gline=""
      if [ "$i" -lt "$glen" ]; then
        gline="${G[i]}"
      fi
      put_line "$row" "${lft}${gap_s}${gline}"
    done
    EXPANDED=1
    N_IDS=$n_ids
    PAGE_SIZE=$page_size
    SEL_COLS=${ROSTER_COLS:-4}
    if [ "$pager" = 1 ]; then
      row=$((top + glen))
      if [ "$row" -lt "$pane_h" ]; then
        CTRL_ROW=$row
        CTRL_COLS=$cols
        lft=""
        if [ "$glen" -lt "$llen" ]; then
          lft="${L[$glen]}"
        fi
        lft="$(pad_cell_line "$lft" "$LEFT_W")"
        put_line "$row" "${lft}${gap_s}$(printf '%d / %d' "$((PAGE + 1))" "$NPAGES")"
      fi
    fi
    save_page_env
    if [ "${MODAL:-0}" = 1 ] && { [ "${SEL_ORCH:-1}" = 1 ] || { [ "$n_ids" -gt 0 ] && [ "$SEL" -lt "$n_ids" ]; }; }; then
      draw_selected_modal "$cols" "$pane_h"
    fi
    printf '\033[1;1H'
    return
  fi
  if [ "${ROSTER_COLS:-1}" != 4 ]; then
  # Bottom-align the column: the page's tiles sit just above the pager row.
  local page_h=0 drop
  for ((i = base; i < end; i++)); do page_h=$((page_h + ${FIT_H[i]:-0})); done
  drop=$((pane_h - row - 3 - page_h))
  for ((i = 0; i < drop; i++)); do
    put_line "$row" ""
    row=$((row + 1))
  done
  for ((i = base; i < end; i++)); do
    [ "$row" -ge "$pane_h" ] && break
    # Collapsed column shows the selector too, so the any-pane keys have a target.
    sel_flag=0
    [ "${SEL_ORCH:-1}" != 1 ] && [ "$i" -eq "${SEL:-0}" ] && sel_flag=1
    # The desk orchestrator draws with the medium face; everyone else is a mini.
    local tface=mini th="$cell_h"
    [ "${PIN_ARR[i]:-0}" = 1 ] && tface=mid && th="$ORCH_CELL_H"
    k1="c|cell|${TUI_COLOR}/${TUI_GLYPHS}|${ID_ARR[i]}|${ST_ARR[i]}|${COL_ARR[i]}|${HAUNT_ARR[i]}|${NAME_ARR[i]}|${ROLE_ARR[i]}|${LOAD_ARR[i]}|$cell_w|$th|$sel_flag|${WEAR_ARR[i]}|${HAT_ARR[i]}|$tface"
    memo_call left "$k1" \
      cell_block "${ID_ARR[i]}" "${ST_ARR[i]}" "${SVG_ARR[i]}" "$cell_w" "$th" "${COL_ARR[i]}" "${HAUNT_ARR[i]}" "${NAME_ARR[i]}" "${ROLE_ARR[i]}" "${LOAD_ARR[i]}" "$tface" "$sel_flag" "${WEAR_ARR[i]}" "${HAT_ARR[i]}"
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      put_line "$row" "$line"
      row=$((row + 1))
      [ "$row" -ge "$pane_h" ] && break
    done < <(printf '%s\n' "$left")
  done
  fi

  # Button row under the roster: [ ← ]  n / N  [ → ]
  if [ "$row" -lt "$pane_h" ]; then
    put_line "$row" ""
    row=$((row + 1))
  fi
  CTRL_ROW="$row"
  CTRL_COLS="$cols"
  EXPANDED=0
  N_IDS=$n_ids
  PAGE_SIZE=$page_size
  SEL_COLS=1
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
  if [ "${MODAL:-0}" = 1 ] && { [ "${SEL_ORCH:-1}" = 1 ] || { [ "$n_ids" -gt 0 ] && [ "$SEL" -lt "$n_ids" ]; }; }; then
    draw_selected_modal "$cols" "$pane_h"
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
  [ -n "${pid:-}" ] || return 0
  # Wake with a key, not a signal: the watch loop sits in `read -t 8`, and bash
  # 3.2 only runs a USR1 trap once that read returns — nudges from other panes
  # showed up to 8s late. A private key byte (Ctrl+]) returns read at once.
  local pane
  pane="$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | awk -v p="$pid" '$1==p{print $2; exit}')"
  if [ -n "$pane" ] && tmux send-keys -t "$pane" C-] 2>/dev/null; then
    return 0
  fi
  kill -USR1 "$pid" 2>/dev/null || true
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
  # Traps run inside whatever was executing — usually the watch loop's
  # `IFS= read`, so IFS is empty here. Restore it for everything this repaints
  # (an empty IFS made memo_reset unset one bogus name and set -e killed the pane).
  local IFS=$' \t\n'
  # Page click already wrote PAGE; poke already wrote the roster cache.
  dbg "usr1"
  safe_render
  dbg "usr1 painted"
}

on_winch() {
  local IFS=$' \t\n'
  safe_render
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
  select-arrow)
    # tmux gotchi-avatar table. Expanded focus moves the sub-agent selector.
    mkdir -p "$SESSIONS"
    case "${2:-}" in
      left|right|up|down|space|esc|enter) ;;
      *)
        echo "usage: avatar-pane.sh select-arrow left|right|up|down|space|esc [pid]" >&2
        exit 2
        ;;
    esac
    if apply_select_key "${2}" ; then
      sb_click_wake "${3:-}"
      exit 0
    fi
    case "${2}" in
      left) page_prev; sb_click_wake "${3:-}" ;;
      right) page_next; sb_click_wake "${3:-}" ;;
    esac
    ;;
  roster-nudge)
    # Any-pane keys (tmux root/prefix). Moves the sub-agent selector across
    # pages or toggles its modal, whether or not the avatar pane is focused.
    mkdir -p "$SESSIONS"
    case "${2:-}" in
      up|down|left|right|space|esc|enter) ;;
      *)
        echo "usage: avatar-pane.sh roster-nudge up|down|left|right|space|esc" >&2
        exit 2
        ;;
    esac
    apply_select_key "$2" 1 || true
    sb_click_wake ""
    ;;
  select-apply)
    # Pure probe. No files. focused=0 leaves sel/page/modal unchanged.
    focused="${2:-0}"
    n="${3:-0}"
    ps="${4:-12}"
    cols="${5:-4}"
    sel="${6:-0}"
    page="${7:-0}"
    modal="${8:-0}"
    key="${9:-}"
    prompt="${10:-0}"
    case "$prompt" in ''|*[!0-9]*) prompt=0 ;; esac
    if [ "$focused" != 1 ]; then
      printf 'sel=%s\npage=%s\nmodal=%s\n' "$sel" "$page" "$modal"
      exit 0
    fi
    case "$key" in
      space)
        if [ "$prompt" -gt 0 ]; then
          printf 'sel=%s\npage=%s\nmodal=%s\n' "$sel" "$page" "$modal"
          exit 0
        fi
        if [ "$modal" = 1 ]; then modal=0; else modal=1; fi
        printf 'sel=%s\npage=%s\nmodal=%s\nmodal_for=%s\n' "$sel" "$page" "$modal" "$sel"
        exit 0
        ;;
      esc)
        modal=0
        printf 'sel=%s\npage=%s\nmodal=%s\n' "$sel" "$page" "$modal"
        exit 0
        ;;
      left|right|up|down)
        moved="$(select_move_pure "$key" "$sel" "$n" "$ps" "$cols")"
        sel="$(printf '%s\n' "$moved" | awk -F= '/^sel=/{print $2}')"
        page="$(printf '%s\n' "$moved" | awk -F= '/^page=/{print $2}')"
        printf 'sel=%s\npage=%s\nmodal=0\n' "$sel" "$page"
        exit 0
        ;;
      *)
        echo "usage: avatar-pane.sh select-apply <focused> <n> <page_size> <cols> <sel> <page> <modal> <key> [prompt_len]" >&2
        exit 2
        ;;
    esac
    ;;
  block-origin)
    # Pure: blank rows above and below a block of the given height.
    case "${2:-}" in ''|*[!0-9]*) echo "usage: avatar-pane.sh block-origin <pane-height> <block-height>" >&2; exit 2 ;; esac
    case "${3:-}" in ''|*[!0-9]*) echo "usage: avatar-pane.sh block-origin <pane-height> <block-height>" >&2; exit 2 ;; esac
    expanded_vpad "$2" "$3"
    printf 'top=%s\nbottom=%s\n' "$EXPANDED_TOP" "$EXPANDED_BOTTOM"
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
  roster-rows)
    # usage: avatar-pane.sh roster-rows <pane-height>
    # Pure: how many roster rows and how much grid a pane of that height gets.
    h="${2:-}"
    mode="${3:-collapsed}"
    case "$h" in
      ''|*[!0-9]*) echo "usage: avatar-pane.sh roster-rows <pane-height> [collapsed|focused]" >&2; exit 2 ;;
    esac
    case "$mode" in
      collapsed|focused) ;;
      *) echo "usage: avatar-pane.sh roster-rows <pane-height> [collapsed|focused]" >&2; exit 2 ;;
    esac
    roster_budget "$h" "$mode"
    printf 'rows=%s\n' "$ROSTER_ROWS"
    printf 'page=%s\n' "$ROSTER_PAGE"
    printf 'grid=%s\n' "$ROSTER_GRID"
    printf 'cols=%s\n' "${ROSTER_COLS_N:-1}"
    ;;
  roster-origin)
    # Geometry probe. No tmux, no terminal read — roster_geometry + real join.
    cols="${2:-44}"
    case "$cols" in
      ''|*[!0-9]*) cols=44 ;;
    esac
    roster_geometry "$cols"
    cell="$(printf 'S%*s' "$((ROSTER_CELL_W - 1))" '')"
    row_line="$cell"
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
    # 9-wide mini, centered on the full pane like the 12-wide selected face.
    pane_w=$((ROSTER_CELL_W + ROSTER_PAD))
    printf 'mini_col=%s\n' "$(( (pane_w - 9) / 2 ))"
    printf 'face_col=%s\n' "$(( (cols - 12) / 2 ))"
    ;;
  watch)
    trap 'watch_leave' EXIT
    trap on_usr1 USR1
    trap on_winch WINCH
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
      # IFS= keeps a typed space. Default IFS strips it to "" and space never
      # reached the sub-agent modal.
      if IFS= read -rsn1 -t "$tick_t" key; then
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
    echo "usage: avatar-pane.sh [watch|once|pin <agentId>|roster-origin [cols]|roster-rows <pane-height>|block-origin <pane-h> <block-h>|select-apply ...|select-arrow left|right|up|down|space|esc [pid]|roster-nudge up|down|space|esc|sb-click <x> <y> [pid]|sb-wheel up|down [pid]]" >&2
    exit 2
    ;;
esac
