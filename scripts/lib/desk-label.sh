# Vertical desk label that follows sessions/.desk-active.line.
# Source from a pane script after ROOT is set.
#   desk_label_watch Factory

desk_label_mtime() {
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"
  else
    stat -c %Y "$1" 2>/dev/null || echo 0
  fi
}

# One column of pad on each side of the glyph. The collapsed bar is 3 wide.
desk_label_glyph() {
  local color="$1" ch="$2"
  printf '\033[38;5;%sm %s \033[0m\n' "$color" "$ch"
}

desk_label_render() {
  local word="$1" line="$2" i ch
  clear 2>/dev/null || printf '\033[2J\033[H'
  desk_label_glyph 245 "›"
  for ((i = 0; i < ${#word}; i++)); do
    ch="${word:i:1}"
    desk_label_glyph 39 "$ch"
  done
  [ -n "$line" ] || return 0
  desk_label_glyph 240 "·"
  line="${line:0:28}"
  for ((i = 0; i < ${#line}; i++)); do
    ch="${line:i:1}"
    case "$ch" in
      " ") printf '   \n' ;;
      *) desk_label_glyph 245 "$ch" ;;
    esac
  done
}

# One source: sessions/.desk-active.line. Republish when the line is older than 2s.
desk_label_watch() {
  local word="${1:-Pane}"
  local linefile="$ROOT/sessions/.desk-active.line"
  local prev="" line mt now dirty=1
  trap 'dirty=1' USR1 WINCH
  mkdir -p "$ROOT/sessions"
  while true; do
    mt="$(desk_label_mtime "$linefile" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ "$mt" = "0" ] || [ $((now - mt)) -ge 2 ]; then
      node "$ROOT/scripts/desk-active.mjs" line >/dev/null 2>&1 || true
    fi
    line=""
    [ -f "$linefile" ] && line="$(tr -d '\n' < "$linefile" 2>/dev/null || true)"
    if [ "$dirty" = 1 ] || [ "$line" != "$prev" ]; then
      desk_label_render "$word" "$line"
      prev="$line"
      dirty=0
    fi
    sleep 1 || true
  done
}
