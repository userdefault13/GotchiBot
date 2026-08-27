#!/usr/bin/env bash
# Thin wrapper — prefs in sessions/.tts.json; personas in config/tts.personas.json5
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
phrase="${1:-}"
[ -n "$phrase" ] || exit 0
persona="${GOTCHIBOT_TTS_PERSONA:-}"
args=(speak "$phrase")
[ -n "$persona" ] && args+=(--persona "$persona")
node "$ROOT/scripts/tts.mjs" "${args[@]}" >/dev/null 2>&1 || true
