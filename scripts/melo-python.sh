#!/usr/bin/env bash
# Resolve Python for MeloTTS (override with GOTCHIBOT_MELO_PYTHON).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${GOTCHIBOT_MELO_PYTHON:-}" ] && [ -x "$GOTCHIBOT_MELO_PYTHON" ]; then
  printf '%s\n' "$GOTCHIBOT_MELO_PYTHON"
  exit 0
fi
for candidate in \
  "$ROOT/.venv/melo/bin/python" \
  "/tmp/melotts-venv/bin/python"; do
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done
echo "MeloTTS python not found. Run: ./scripts/setup-melo-tts.sh" >&2
exit 1
