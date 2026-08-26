#!/usr/bin/env bash
# Interactive OpenCode TUI — the GotchiBot chat pane.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${GOTCHIBOT_OPENCODE_MODEL:-opencode/nemotron-3.5-lightning-free}"
MINI="${GOTCHIBOT_OPENCODE_MINI:-1}"

cd "$ROOT"
printf '\033[2J\033[H\033[3J' 2>/dev/null || clear 2>/dev/null || true

args=(--no-replay -m "$MODEL")
[ "$MINI" = 1 ] && args=(--mini "${args[@]}")

exec opencode "${args[@]}" "$ROOT"
