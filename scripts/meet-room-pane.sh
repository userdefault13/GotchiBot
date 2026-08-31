#!/usr/bin/env bash
# Meet room — Zoom carousel + OpenCode-style prompter (no OpenCode chat).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/meet-room-prompter.mjs"
