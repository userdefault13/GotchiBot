# Boot timing marks → sessions/.boot-trace.log. Read with: ./scripts/gotchibot boot-trace
#   boot_mark "label"          append a mark
#   boot_mark "launch" reset   start a fresh trace (gotchibot tmux only)
boot_mark() {
  local f="${GOTCHIBOT_ROOT:-$ROOT}/sessions/.boot-trace.log"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  [ "${2:-}" = "reset" ] && : > "$f"
  local ms
  ms="$(perl -MTime::HiRes=time -e 'printf "%d", time*1000' 2>/dev/null)" || ms="$(($(date +%s) * 1000))"
  printf '%s\t%s\n' "$ms" "$1" >> "$f" 2>/dev/null || true
}
