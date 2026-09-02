#!/usr/bin/env bash
# Install GotchiBot OpenCode theme into every OpenCode lookup path that matters.
# Source of truth: <repo>/.opencode/themes/gotchi.json (256-index palette for Apple Terminal).
# Also copies to ~/.config/opencode/themes/ so `theme: gotchi` works outside the repo cwd.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.opencode/themes/gotchi.json"
quiet=0
[ "${1:-}" = "--quiet" ] && quiet=1

die() { echo "install-opencode-theme: $*" >&2; exit 1; }

[ -f "$SRC" ] || die "missing $SRC"

# Project path (already in repo) — ensure dir exists for clones that only have partial trees.
mkdir -p "$ROOT/.opencode/themes"

# User-wide OpenCode themes (XDG + classic).
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
dests=(
  "$config_home/opencode/themes/gotchi.json"
)
# macOS / older OpenCode also checks ~/.config even when XDG is set differently.
if [ "$config_home/opencode/themes/gotchi.json" != "$HOME/.config/opencode/themes/gotchi.json" ]; then
  dests+=("$HOME/.config/opencode/themes/gotchi.json")
fi

installed=0
for dest in "${dests[@]}"; do
  mkdir -p "$(dirname "$dest")"
  if cmp -s "$SRC" "$dest" 2>/dev/null; then
    [ "$quiet" = 1 ] || echo "opencode theme up to date → $dest"
  else
    cp "$SRC" "$dest"
    installed=1
    [ "$quiet" = 1 ] || echo "opencode theme installed → $dest"
  fi
done

[ "$quiet" = 1 ] || {
  if [ "$installed" = 1 ]; then
    echo "theme: gotchi (256-index) — restart chat pane / OpenCode to pick up"
  fi
}
exit 0
