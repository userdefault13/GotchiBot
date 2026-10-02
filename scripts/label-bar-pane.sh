#!/usr/bin/env bash
# Vertical label for a collapsed desk pane (Factory, Dossier, Meeting, …).
# Redraws when the active gotchi's workflow line changes.
#   label-bar-pane.sh Factory
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/desk-label.sh
. "$ROOT/scripts/lib/desk-label.sh"

word="${1:-Pane}"
desk_label_watch "$word"
