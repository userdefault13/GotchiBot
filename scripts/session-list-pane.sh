#!/usr/bin/env bash
# Sessions render in the tmux status bar; this script prints the same row for terminals.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/session-status-bar.sh"
