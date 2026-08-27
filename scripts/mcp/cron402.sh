#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEV="$("$ROOT/scripts/mcp/dev-root.sh")"
MCP="$DEV/ai-cron-site/packages/mcp/dist/index.js"
if [ ! -f "$MCP" ]; then
  echo "cron402-mcp not built. Run: cd $DEV/ai-cron-site/packages/mcp && npm run build" >&2
  exit 1
fi
if command -v abra >/dev/null 2>&1; then
  exec abra run ai-cron-site -- node "$MCP"
fi
exec node "$MCP"
