#!/usr/bin/env bash
# Source OpenClaw gateway URL/token from sessions/.openclaw-gateway.json
#
# This file is SOURCED (see scripts/gotchibot). That means it must never call
# `exit` — that would exit the caller — and must never end on a failing
# command, because the caller runs under `set -e` and sources this as the last
# command of an `&&` list, where set -e still applies. Both of those used to
# happen whenever sessions/ was missing these optional files, which is the
# normal state of a fresh install: every gotchibot subcommand then silently
# did nothing.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT/sessions/.openclaw-gateway.json" ] && command -v node >/dev/null 2>&1; then
  eval "$(node "$ROOT/scripts/openclaw-fleet.mjs" env 2>/dev/null)" || true
fi

# Persistent gotchi-mode default model (pinned fast tier)
# sessions/.gotchi-model.env sets GOTCHIBOT_OPENCODE_MODEL so gotchi mode
# doesn't auto-rotate through OpenRouter free models.
if [ -f "$ROOT/sessions/.gotchi-model.env" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/sessions/.gotchi-model.env"
fi

# Always succeed: a non-zero status here kills a `set -e` caller.
true
