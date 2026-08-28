#!/usr/bin/env bash
# OpenClaw CLI with GotchiBot TUI slash commands (/orch /list /switch).
#
# Prefers a local dev build at ~/Dev/openclaw when dist/ includes gotchi-commands.js.
# Falls back to ~/.openclaw/bin/openclaw (stock install).
#
# Build patched OpenClaw once:
#   ./scripts/openclaw-gotchi-build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GOTCHIBOT_ROOT="${GOTCHIBOT_ROOT:-$ROOT}"
export PATH="${HOME}/.openclaw/bin:${PATH}"

DEV_OPENCLAW="${GOTCHIBOT_OPENCLAW_SRC:-$HOME/Dev/openclaw}"
NODE="${OPENCLAW_NODE:-${HOME}/.openclaw/tools/node/bin/node}"

# abra run gotchibot replaces the parent env with vault secrets only — set TUI
# chrome vars here so the patched OpenClaw build always sees them.
apply_gotchi_tui_env() {
  [ "${1:-}" = "tui" ] || return 0
  export OPENCLAW_THEME="${OPENCLAW_THEME:-opencode}"
  export GOTCHIBOT_TUI_STYLE="${GOTCHIBOT_TUI_STYLE:-opencode}"
  export GOTCHIBOT_TUI_TITLE="${GOTCHIBOT_TUI_TITLE:-Gotchi}"
  export GOTCHIBOT_TUI_SCROLL="${GOTCHIBOT_TUI_SCROLL:-1}"
  export GOTCHIBOT_TUI_MOUSE="${GOTCHIBOT_TUI_MOUSE:-1}"
  export GOTCHIBOT_TUI_SCROLL_SPEED="${GOTCHIBOT_TUI_SCROLL_SPEED:-4}"
  export GOTCHIBOT_TUI_COLLAPSE_SYSTEM="${GOTCHIBOT_TUI_COLLAPSE_SYSTEM:-1}"
  export GOTCHIBOT_TUI_PROSE_TTS="${GOTCHIBOT_TUI_PROSE_TTS:-1}"
  export GOTCHIBOT_TUI_LOAD_PROGRESS="${GOTCHIBOT_TUI_LOAD_PROGRESS:-1}"
  export GOTCHIBOT_TUI_PROMPT_LINES="${GOTCHIBOT_TUI_PROMPT_LINES:-5}"
  export COLORTERM="${COLORTERM:-truecolor}"
  export FORCE_COLOR="${FORCE_COLOR:-1}"
}

apply_gotchi_tui_env "${1:-}"

if [ -x "$NODE" ] && [ -f "$DEV_OPENCLAW/dist/entry.js" ]; then
  if [ -f "$DEV_OPENCLAW/dist/.gotchi-patch-built" ] \
    || rg -q 'formatGotchiOpencodeHeader|B650FF' "$DEV_OPENCLAW/dist/entry.js" "$DEV_OPENCLAW/dist"/tui-*.js 2>/dev/null; then
    # One-shot config migration for 2026.8+ schema (agents.entries, no legacy keys).
    if [ "${GOTCHIBOT_SKIP_OPENCLAW_DOCTOR:-}" != "1" ] \
      && [ "${1:-}" = "tui" ] \
      && [ -f "${HOME}/.openclaw/openclaw.json" ]; then
      "$NODE" "$DEV_OPENCLAW/dist/entry.js" doctor --fix --non-interactive >/dev/null 2>&1 || true
    fi
    exec "$NODE" "$DEV_OPENCLAW/dist/entry.js" "$@"
  fi
fi

if command -v openclaw >/dev/null 2>&1; then
  exec openclaw "$@"
fi

echo "openclaw not found — run ./scripts/openclaw-cli-install.sh" >&2
exit 127
