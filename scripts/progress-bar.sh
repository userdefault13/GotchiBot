#!/usr/bin/env bash
# Terminal progress bars for GotchiBot loading / wait states.
set -euo pipefail

PROGRESS_WIDTH="${GOTCHIBOT_PROGRESS_WIDTH:-36}"
PROGRESS_FG="${GOTCHIBOT_PROGRESS_FG:-$'\033[38;5;39m'}"
PROGRESS_MUTED="${GOTCHIBOT_PROGRESS_MUTED:-$'\033[38;5;245m'}"
PROGRESS_DONE="${GOTCHIBOT_PROGRESS_DONE:-$'\033[38;5;82m'}"
PROGRESS_WARN="${GOTCHIBOT_PROGRESS_WARN:-$'\033[38;5;214m'}"
PROGRESS_RESET="${GOTCHIBOT_PROGRESS_RESET:-$'\033[0m'}"

# Draw a determinate bar: 0–100%.
progress_bar() {
  local pct="$1" label="$2"
  local width="$PROGRESS_WIDTH" filled empty bar="" i
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100
  filled=$(( pct * width / 100 ))
  empty=$(( width - filled ))
  for ((i = 0; i < filled; i++)); do bar+='█'; done
  for ((i = 0; i < empty; i++)); do bar+='░'; done
  printf '\r%s%s%s %3d%% %s%s' "$PROGRESS_FG" "$bar" "$PROGRESS_RESET" "$pct" "$label" "$PROGRESS_RESET" >&2
}

# Indeterminate sliding pulse (frame = tick counter).
progress_pulse() {
  local label="$1" frame="${2:-0}"
  local width="$PROGRESS_WIDTH" pos bar="" i
  pos=$(( (frame * 2) % (width + 8) ))
  [ "$pos" -gt "$width" ] && pos=$(( width * 2 + 8 - pos ))
  for ((i = 0; i < width; i++)); do
    if [ "$i" -eq "$pos" ] || [ "$i" -eq "$((pos - 1))" ] || [ "$i" -eq "$((pos + 1))" ]; then
      bar+='█'
    else
      bar+='░'
    fi
  done
  printf '\r%s%s%s %s%s' "$PROGRESS_FG" "$bar" "$PROGRESS_RESET" "$label" "$PROGRESS_RESET" >&2
}

progress_end() {
  printf '\r\033[K' >&2
}

progress_done() {
  local label="$1"
  progress_bar 100 "$label"
  printf '\n' >&2
}

progress_fail() {
  local label="$1"
  local width="$PROGRESS_WIDTH" bar=""
  local i
  for ((i = 0; i < width; i++)); do bar+='░'; done
  printf '\r%s%s%s %s%s\n' "$PROGRESS_WARN" "$bar" "$PROGRESS_RESET" "$label" "$PROGRESS_RESET" >&2
}

# Animate a boot splash (~seconds as integer; used before OpenCode TUI takes over).
progress_boot() {
  local label="$1" seconds="${2:-2}" frames tick max_frames
  seconds="${seconds%%.*}"
  [ -z "$seconds" ] || [ "$seconds" -lt 1 ] 2>/dev/null && seconds=1
  max_frames="${GOTCHIBOT_PROGRESS_BOOT_FRAMES:-0}"
  if [ "$max_frames" -le 0 ] 2>/dev/null; then
    max_frames=$(( seconds * 10 ))
  fi
  tick=0
  while [ "$tick" -lt "$max_frames" ]; do
    progress_pulse "$label" "$tick"
    tick=$((tick + 1))
    sleep 0.1
  done
  progress_end
}

# Poll a sub-agent session until it finishes; show pulse + elapsed time.
progress_wait_session() {
  local id="$1" root="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local dir="$root/sessions/$id" elapsed=0 max="${3:-600}" st=""
  [ -f "$dir/state.env" ] || { progress_fail "unknown session: $id"; return 1; }

  while { [ ! -f "$dir/output.md" ] || grep -q '^status=running' "$dir/state.env" 2>/dev/null; }; do
    st="$(grep -E '^status=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || echo running)"
    progress_pulse "${id} · ${st} · ${elapsed}s" "$elapsed"
    sleep 1
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge "$max" ] && break
  done

  st="$(grep -E '^status=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || echo '?')"
  case "$st" in
    done) progress_done "${id} · done · ${elapsed}s" ;;
    failed) progress_fail "${id} · failed · ${elapsed}s" ;;
    *) progress_done "${id} · ${st} · ${elapsed}s" ;;
  esac
  printf '%s\n' "$st"
}

# Run a command with an indeterminate bar until it exits.
progress_run() {
  local label="$1"; shift
  local frame=0 rc=0
  "$@" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    progress_pulse "$label" "$frame"
    frame=$((frame + 1))
    sleep 0.12
  done
  wait "$pid" || rc=$?
  progress_end
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
