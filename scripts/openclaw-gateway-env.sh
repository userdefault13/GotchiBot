#!/usr/bin/env bash
# Source OpenClaw gateway URL/token from sessions/.openclaw-gateway.json
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/sessions/.openclaw-gateway.json" ] && command -v node >/dev/null 2>&1 || exit 0
eval "$(node "$ROOT/scripts/openclaw-fleet.mjs" env 2>/dev/null)" || true

# Persistent gotchi-mode default model (pinned fast tier)
# sessions/.gotchi-model.env sets GOTCHIBOT_OPENCODE_MODEL so gotchi mode
# doesn't auto-rotate through OpenRouter free models.
[ -f "$ROOT/sessions/.gotchi-model.env" ] && source "$ROOT/sessions/.gotchi-model.env"
