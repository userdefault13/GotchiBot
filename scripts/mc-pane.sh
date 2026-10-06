#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MENU_SRC="$ROOT/config/mc.menu"
MENU_DST="${XDG_CONFIG_HOME:-$HOME/.config}/mc/menu"
MARKER_BEGIN="# >>> gotchibot-add-to-chat"
MARKER_END="# <<< gotchibot-add-to-chat"

install_user_menu() {
  mkdir -p "$(dirname "$MENU_DST")"
  local block_file="$ROOT/sessions/.mc-menu-block.tmp"
  sed "s|@GOTCHIBOT_ROOT@|$ROOT|g" "$MENU_SRC" > "${block_file}.part"
  {
    printf '%s\n' "$MARKER_BEGIN"
    cat "${block_file}.part"
    printf '%s\n' "$MARKER_END"
  } > "$block_file"

  if [ -f "$MENU_DST" ] && grep -q "$MARKER_BEGIN" "$MENU_DST" 2>/dev/null; then
    # macOS awk cannot take multiline strings in -v repl; read from a file instead.
    awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" -v repl="$block_file" '
      $0 == begin { skip=1; while ((getline line < repl) > 0) print line; close(repl); next }
      $0 == end { skip=0; next }
      !skip { print }
    ' "$MENU_DST" > "${MENU_DST}.tmp"
    mv "${MENU_DST}.tmp" "$MENU_DST"
  elif [ -f "$MENU_DST" ]; then
    printf '\n%s\n' "$(cat "$block_file")" >> "$MENU_DST"
  else
    cp "$block_file" "$MENU_DST"
  fi
  cp "$block_file" "$ROOT/.mc.menu"
  chmod 644 "$MENU_DST" "$ROOT/.mc.menu" 2>/dev/null || true
  rm -f "$block_file" "${block_file}.part"
}

# Desk mouse stays off. Do not turn the session mouse back on for mc.

disable_tmux_mouse() {
  local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  # Restore default (OpenCode owns wheel) unless user opted in globally.
  if [ "${GOTCHIBOT_TMUX_MOUSE:-0}" != "1" ]; then
    tmux set-option -t "$sess" mouse off 2>/dev/null || true
  fi
}

debounced_winch() {
  local now
  now=$(date +%s)
  if [ "$((now - ${last_winch:-0}))" -lt 1 ]; then
    return
  fi
  last_winch=$now
  kill -WINCH $$ 2>/dev/null || true
}

chmod +x "$ROOT/scripts/mc-add-to-chat.sh" 2>/dev/null || true
install_user_menu
disable_tmux_mouse
trap 'disable_tmux_mouse' EXIT
trap debounced_winch WINCH

# Hint on first paint (mc clears screen after).
export GOTCHIBOT_MC=1
# No mouse. Keyboard still drives mc. Open on the current project's folder
# (else the repo); project-sync restarts it on a project switch.
# shellcheck source=scripts/lib/project-dir.sh
. "$ROOT/scripts/lib/project-dir.sh"
cd "$(project_dir "$ROOT")" 2>/dev/null || cd "$ROOT"
exec mc --nomouse .
