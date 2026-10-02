#!/usr/bin/env bash
# Thin vertical label when the Gotchi chat pane is collapsed.
# Follows the active gotchi workflow line.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/desk-label.sh
. "$ROOT/scripts/lib/desk-label.sh"

desk_label_watch "Gotchi"
