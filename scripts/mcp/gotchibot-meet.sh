#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT/scripts/mcp/gotchibot-meet.mjs"
