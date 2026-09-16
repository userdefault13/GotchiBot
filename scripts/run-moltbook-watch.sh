#!/usr/bin/env bash
# Cron-safe wrapper for the Moltbook watch desk (DAI / starter-dai-h1-1).
# Used by local launchd fallback and by Gotchi-Trader's cron402 webhook.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${MOLTBOOK_ENV_FILE:-${HOME}/.config/moltbook/credentials.json}"
ARGS=(--json)
if [[ -f "$ENV_FILE" ]]; then
  ARGS+=(--env-file "$ENV_FILE")
fi

exec /usr/bin/env node "$ROOT/scripts/moltbook-watch.mjs" "${ARGS[@]}"
