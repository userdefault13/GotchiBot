#!/usr/bin/env bash
# OpenCode / local MCP launcher for Hub Claude ask tool.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT/scripts/mcp/gotchibot-claude.mjs"
