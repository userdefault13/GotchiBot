#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEV="$("$ROOT/scripts/mcp/dev-root.sh")"
exec node "$DEV/AarcadeGh-t/mcp/hackathon-ideas/src/index.mjs"
