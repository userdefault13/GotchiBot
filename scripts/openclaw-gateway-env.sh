#!/usr/bin/env bash
# Source OpenClaw gateway URL/token from sessions/.openclaw-gateway.json
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/sessions/.openclaw-gateway.json" ] && command -v node >/dev/null 2>&1 || exit 0
eval "$(node "$ROOT/scripts/openclaw-fleet.mjs" env 2>/dev/null)" || true
