#!/usr/bin/env bash
# Kanban pane — gotchi-kanban TUI (agents · tasks · seats).
# The start command must contain "kanban-pane": orchestrator-layout.sh matches it.
# Open:  cockpit Desk panes → Kanban, or ./scripts/orchestrator-layout.sh enter-kanban
# Key:   Ctrl+Space then Shift+B (toggle-kanban; again returns to the cockpit)
# Bar:   label-bar-pane.sh Kanban
# q/esc in the TUI focuses the cockpit pane. The cockpit menu is not replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
export GOTCHIBOT_KANBAN_PANE=1
exec node "$ROOT/scripts/gotchi-kanban.mjs" --tui
