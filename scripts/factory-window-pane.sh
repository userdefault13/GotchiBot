#!/usr/bin/env bash
# Factory pane launcher (tmux work.1): runs factory-window under abra so its probes
# see vault keys — Hub SSH, the subgraph proxy key, OPENCODE_API_KEY. Falls back to
# a keyless pane when abra itself cannot start (exit 125 path, same as chat-pane.sh).
# The name must keep "factory-window" in it: orchestrator-layout.sh matches the pane's
# start command on that substring.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if command -v abra >/dev/null 2>&1 && [ "${GOTCHIBOT_FACTORY_NO_ABRA:-}" != "1" ]; then
  started="$ROOT/sessions/.abra-started.factory.$$"
  rm -f "$started"
  abra run gotchibot -- /bin/sh -c ': > "$0"; exec "$@"' "$started" node "$ROOT/scripts/factory-window.mjs" "$@"
  st=$?
  if [ -e "$started" ]; then
    rm -f "$started"
    exit "$st"
  fi
  printf '  Factory · abra unavailable — continuing without vault keys\n' >&2
fi
exec node "$ROOT/scripts/factory-window.mjs" "$@"
