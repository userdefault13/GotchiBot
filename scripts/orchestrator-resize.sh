#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$ROOT/sessions/.resize-ts"
DEBOUNCE_MS="${GOTCHIBOT_RESIZE_DEBOUNCE_MS:-2500}"

now="$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000)"
last="$(tr -d '[:space:]' < "$STAMP" 2>/dev/null || echo 0)"
[ "$last" -gt 0 ] && [ $((now - last)) -lt "$DEBOUNCE_MS" ] && exit 0
printf '%s\n' "$now" > "$STAMP"
exec "$ROOT/scripts/orchestrator-layout.sh" fit-quiet
