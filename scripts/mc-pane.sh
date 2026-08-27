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
  local block
  block="$(sed "s|@GOTCHIBOT_ROOT@|$ROOT|g" "$MENU_SRC")"
  block="${MARKER_BEGIN}
${block}
${MARKER_END}"

  if [ -f "$MENU_DST" ] && grep -q "$MARKER_BEGIN" "$MENU_DST" 2>/dev/null; then
    # Replace existing GotchiBot block
    awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" -v repl="$block" '
      $0 == begin { skip=1; print repl; next }
      $0 == end { skip=0; next }
      !skip { print }
    ' "$MENU_DST" > "${MENU_DST}.tmp"
    mv "${MENU_DST}.tmp" "$MENU_DST"
  elif [ -f "$MENU_DST" ]; then
    printf '\n%s\n' "$block" >> "$MENU_DST"
  else
    printf '%s\n' "$block" > "$MENU_DST"
  fi
  # Local project menu (used when cwd is repo root)
  printf '%s\n' "$(sed "s|@GOTCHIBOT_ROOT@|$ROOT|g" "$MENU_SRC")" > "$ROOT/.mc.menu"
  chmod 644 "$MENU_DST" "$ROOT/.mc.menu" 2>/dev/null || true
}

# Mouse needed for click-to-select; enable for this mc session's tmux client.
enable_tmux_mouse() {
  local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  tmux set-option -t "$sess" mouse on 2>/dev/null || true
}

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
enable_tmux_mouse
trap 'disable_tmux_mouse' EXIT
trap debounced_winch WINCH

# Hint on first paint (mc clears screen after).
export GOTCHIBOT_MC=1
# Mouse on (default); do not pass --nomouse.
exec mc .
