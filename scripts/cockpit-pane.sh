#!/usr/bin/env bash
# Cockpit menu in its own pane. Chat stays parked and shows as a thin bar.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GOTCHIBOT_COCKPIT_PANE=1
export GOTCHIBOT_SKIP_ONBOARDING=1

set +e
node ./scripts/onboarding-gate.mjs --cockpit
st=$?
set -e

# 6: the menu handed the desk to another pane (meet room); leaving the cockpit
# here would focus chat over it.
[ "$st" = 6 ] && exit 0

mode="$(tr -d '[:space:]' < "$ROOT/sessions/.layout-mode" 2>/dev/null || echo normal)"
if [ "$mode" = "cockpit" ]; then
  GOTCHIBOT_LAYOUT_SAFE=1 "$ROOT/scripts/orchestrator-layout.sh" leave-cockpit || true
fi
exit "$st"
