#!/usr/bin/env bash
# Inbox pane — project mail from sessions/pstack/<slug>/mail.json.
# The start command must contain "inbox-pane": orchestrator-layout.sh matches it.
# Open:  ./scripts/orchestrator-layout.sh enter-inbox
# Key:   Ctrl+Space then Shift+I (toggle-inbox; again returns to chat)
# Bar:   label-bar-pane.sh Inbox  → scripts/lib/desk-label.sh + sessions/.desk-active.line
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
exec node "$ROOT/scripts/inbox-pane.mjs" watch
