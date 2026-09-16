#!/usr/bin/env bash
# Terminal progress bars for GotchiBot loading / wait states.
#
# The bar animates on its own: progress_pulse starts a background painter the
# first time it is called and only swaps the label afterwards, so a blocking
# step (fleet sync, layout, model resolve) no longer freezes the bar for as long
# as it runs. progress_end stops the painter and clears the line. Callers that
# drew one frame per step keep working unchanged and become live.
#
#   progress_pulse "label"     start / relabel the live bar
#   progress_end               stop it, clear the line
#   progress_done "label"      full bar + newline (keeps the line)
#   progress_fail "label"      empty warn-coloured bar + newline
#   progress_run "label" cmd…  live bar until cmd exits
#   progress_wait_session id   live bar until a sub-agent session finishes
set -euo pipefail

PROGRESS_WIDTH="${GOTCHIBOT_PROGRESS_WIDTH:-36}"
PROGRESS_FG="${GOTCHIBOT_PROGRESS_FG:-$'\033[38;5;39m'}"
PROGRESS_MUTED="${GOTCHIBOT_PROGRESS_MUTED:-$'\033[38;5;240m'}"
PROGRESS_DONE="${GOTCHIBOT_PROGRESS_DONE:-$'\033[38;5;82m'}"
PROGRESS_WARN="${GOTCHIBOT_PROGRESS_WARN:-$'\033[38;5;214m'}"
PROGRESS_RESET="${GOTCHIBOT_PROGRESS_RESET:-$'\033[0m'}"
# Seconds between frames (bash 3.2 has no EPOCHREALTIME; elapsed = frames × interval).
PROGRESS_INTERVAL="${GOTCHIBOT_PROGRESS_INTERVAL:-0.05}"
# Frames per second implied by the interval, for the elapsed readout. 0.05 → 20.
PROGRESS_FPS="${GOTCHIBOT_PROGRESS_FPS:-20}"
# Head of the pulse, dim edge → bright centre → dim edge. An array of glyphs, not a
# string: slicing a multibyte string by character breaks under a C locale.
PROGRESS_HEAD=(▒ ▓ █ ▓ ▒)
PROGRESS_TRACK="${GOTCHIBOT_PROGRESS_TRACK:-░}"

_PROGRESS_PID=""
_PROGRESS_LABEL_FILE=""
_PROGRESS_TTY_HIDDEN=0

_progress_hide_cursor() {
  [ "$_PROGRESS_TTY_HIDDEN" = 1 ] && return 0
  [ -t 2 ] && printf '\033[?25l' >&2
  _PROGRESS_TTY_HIDDEN=1
}

_progress_show_cursor() {
  [ "$_PROGRESS_TTY_HIDDEN" = 1 ] || return 0
  [ -t 2 ] && printf '\033[?25h' >&2
  _PROGRESS_TTY_HIDDEN=0
}

# One frame of the pulse: head bounces between the ends of the track.
# $1 label, $2 frame, $3 elapsed text (optional).
_progress_frame() {
  local label="$1" frame="${2:-0}" elapsed="${3:-}"
  local width="$PROGRESS_WIDTH" hl pos period i bar="" c
  hl=${#PROGRESS_HEAD[@]}
  [ "$hl" -lt 1 ] && { PROGRESS_HEAD=(█); hl=1; }
  period=$(( (width - hl) * 2 ))
  [ "$period" -lt 1 ] && period=1
  pos=$(( frame % period ))
  [ "$pos" -ge $(( width - hl )) ] && pos=$(( period - pos ))
  for ((i = 0; i < width; i++)); do
    if [ "$i" -ge "$pos" ] && [ "$i" -lt $(( pos + hl )) ]; then
      c="${PROGRESS_HEAD[$((i - pos))]}"
      bar+="${PROGRESS_FG}${c}"
    else
      bar+="${PROGRESS_MUTED}${PROGRESS_TRACK}"
    fi
  done
  printf '\r%s%s %s%s%s\033[K' "$bar" "$PROGRESS_RESET" "$label" "${elapsed:+${PROGRESS_MUTED} ${elapsed}}" "$PROGRESS_RESET" >&2
}

# Background painter: reads the label file every frame; stops when told to,
# or when the shell that started it is gone (a caller that exits without
# progress_end does not leave a ghost bar).
_progress_painter() {
  local file="$1" owner="$2" frame=0 label="" tenths secs
  trap 'exit 0' TERM INT HUP
  while :; do
    [ -f "$file" ] || exit 0
    IFS= read -r label < "$file" || label=""
    [ "$label" = "__stop__" ] && exit 0
    kill -0 "$owner" 2>/dev/null || exit 0
    tenths=$(( frame * 10 / PROGRESS_FPS ))
    secs="$(( tenths / 10 )).$(( tenths % 10 ))s"
    _progress_frame "$label" "$frame" "$secs"
    frame=$(( frame + 1 ))
    sleep "$PROGRESS_INTERVAL"
  done
}

_progress_running() {
  [ -n "$_PROGRESS_PID" ] && kill -0 "$_PROGRESS_PID" 2>/dev/null
}

# Start the live bar, or relabel it if it is already running.
progress_start() {
  local label="$1"
  if _progress_running; then
    printf '%s\n' "$label" > "$_PROGRESS_LABEL_FILE"
    return 0
  fi
  _PROGRESS_LABEL_FILE="$(mktemp -t gotchibot-progress.XXXXXX)"
  printf '%s\n' "$label" > "$_PROGRESS_LABEL_FILE"
  _progress_hide_cursor
  _progress_frame "$label" 0
  _progress_painter "$_PROGRESS_LABEL_FILE" "$$" </dev/null &
  _PROGRESS_PID=$!
  disown "$_PROGRESS_PID" 2>/dev/null || true
}

progress_set() {
  progress_start "$1"
}

# Stop the painter and clear the line.
progress_stop() {
  if [ -n "$_PROGRESS_LABEL_FILE" ] && [ -f "$_PROGRESS_LABEL_FILE" ]; then
    printf '__stop__\n' > "$_PROGRESS_LABEL_FILE" 2>/dev/null || true
  fi
  if _progress_running; then
    local i
    for ((i = 0; i < 10; i++)); do
      kill -0 "$_PROGRESS_PID" 2>/dev/null || break
      sleep 0.02
    done
    kill -TERM "$_PROGRESS_PID" 2>/dev/null || true
  fi
  [ -n "$_PROGRESS_LABEL_FILE" ] && rm -f "$_PROGRESS_LABEL_FILE" 2>/dev/null
  _PROGRESS_PID=""
  _PROGRESS_LABEL_FILE=""
  printf '\r\033[K' >&2
  _progress_show_cursor
}

# Draw a determinate bar: 0–100%. Stops any live pulse first.
progress_bar() {
  local pct="$1" label="$2"
  local width="$PROGRESS_WIDTH" filled empty bar="" i
  _progress_running && progress_stop
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100
  filled=$(( pct * width / 100 ))
  empty=$(( width - filled ))
  for ((i = 0; i < filled; i++)); do bar+='█'; done
  for ((i = 0; i < empty; i++)); do bar+="$PROGRESS_TRACK"; done
  printf '\r%s%s%s %3d%% %s%s\033[K' "$PROGRESS_FG" "$bar" "$PROGRESS_RESET" "$pct" "$label" "$PROGRESS_RESET" >&2
}

# Indeterminate pulse. Starts the live painter (or relabels it); the frame
# argument old callers pass is accepted and ignored.
progress_pulse() {
  local label="$1"
  progress_start "$label"
}

progress_end() {
  progress_stop
}

progress_done() {
  local label="$1"
  _progress_running && progress_stop
  progress_bar 100 "$label"
  printf '\n' >&2
}

progress_fail() {
  local label="$1"
  local width="$PROGRESS_WIDTH" bar=""
  local i
  _progress_running && progress_stop
  for ((i = 0; i < width; i++)); do bar+="$PROGRESS_TRACK"; done
  printf '\r%s%s%s %s%s\033[K\n' "$PROGRESS_WARN" "$bar" "$PROGRESS_RESET" "$label" "$PROGRESS_RESET" >&2
}

# Animate a boot splash for ~seconds (used before OpenCode TUI takes over).
progress_boot() {
  local label="$1" seconds="${2:-2}"
  seconds="${seconds%%.*}"
  [ -z "$seconds" ] || [ "$seconds" -lt 1 ] 2>/dev/null && seconds=1
  progress_start "$label"
  sleep "$seconds"
  progress_stop
}

# Poll a sub-agent session until it finishes; live pulse + status + elapsed.
progress_wait_session() {
  local id="$1" root="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local dir="$root/sessions/$id" ticks=0 max="${3:-600}" st="" last=""
  [ -f "$dir/state.env" ] || { progress_fail "unknown session: $id"; return 1; }

  while { [ ! -f "$dir/output.md" ] || grep -q '^status=running' "$dir/state.env" 2>/dev/null; }; do
    st="$(grep -E '^status=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || echo running)"
    if [ "$st" != "$last" ]; then
      progress_start "${id} · ${st}"
      last="$st"
    fi
    sleep 0.2
    ticks=$((ticks + 1))
    [ $(( ticks / 5 )) -ge "$max" ] && break
  done
  progress_stop

  st="$(grep -E '^status=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || echo '?')"
  local elapsed=$(( ticks / 5 ))
  case "$st" in
    done) progress_done "${id} · done · ${elapsed}s" ;;
    failed) progress_fail "${id} · failed · ${elapsed}s" ;;
    *) progress_done "${id} · ${st} · ${elapsed}s" ;;
  esac
  printf '%s\n' "$st"
}

# Run a command with a live bar until it exits.
progress_run() {
  local label="$1"; shift
  local rc=0
  progress_start "$label"
  "$@" || rc=$?
  progress_stop
  return "$rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    boot) progress_boot "${2:-Loading…}" "${3:-2}" ;;
    wait) progress_wait_session "${2:?session id}" "${3:-}" "${4:-600}" ;;
    run) shift; progress_run "$@" ;;
    *)
      echo "usage: progress-bar.sh boot|wait|run …" >&2
      exit 2
      ;;
  esac
fi
