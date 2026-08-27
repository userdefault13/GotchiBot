#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$("$ROOT/scripts/melo-python.sh")"
exec "$PY" "$ROOT/scripts/melo-speak.py" "$@"
