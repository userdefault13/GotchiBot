#!/usr/bin/env bash
set -euo pipefail

phrase="${1:-}"
[ -n "$phrase" ] || exit 0
[ "${GOTCHIBOT_TTS:-off}" = "on" ] || exit 0

persona="${GOTCHIBOT_TTS_PERSONA:-gotchi}"

if command -v edge-tts >/dev/null 2>&1; then
  voice="${GOTCHIBOT_TTS_VOICE:-en-US-AnaNeural}"
  [ "$persona" = "sub" ] && voice="en-US-BlueNeural"
  edge-tts --voice "$voice" --text "$phrase" --play-audio >/dev/null 2>&1 || true
else
  say -v "${GOTCHIBOT_SAY_VOICE:-Samantha}" "$phrase" >/dev/null 2>&1 || true
fi
