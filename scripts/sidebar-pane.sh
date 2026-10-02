#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/desk-label.sh
. "$ROOT/scripts/lib/desk-label.sh"

# Collapsed Files bar. Redraws with the active gotchi, not on a timer clear.
desk_label_watch "Files"
