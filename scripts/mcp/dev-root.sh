#!/usr/bin/env bash
# Resolve ~/Dev (override with GOTCHIBOT_DEV).
DEV="${GOTCHIBOT_DEV:-$HOME/Dev}"
if [ ! -d "$DEV" ]; then
  echo "GOTCHIBOT_DEV not found: $DEV" >&2
  exit 1
fi
printf '%s' "$DEV"
