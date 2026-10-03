#!/usr/bin/env bash
# pstack dossier wizard pane — tmux work.2 while mode=pstack-dossier.
#
# Renders the chief SoT dossier (sessions/pstack/<slug>/dossier.json) for the
# current program and re-renders when it changes (USR1 / WINCH / mtime poll).
# Editing happens via CLI from the chat pane:
#   ./scripts/gotchibot pstack dossier set <slug> <field> <value>
#
#   pstack-pane.sh watch            (layout respawn target)
#   pstack-pane.sh once             single render (debug)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT="$ROOT/sessions/.pstack-dossier-current"
INTERVAL="${PSTACK_PANE_INTERVAL:-5}"

mark_self() {
  [ -n "${TMUX:-}" ] || return 0
  local tgt="${TMUX_PANE:-}"
  [ -n "$tgt" ] || return 0
  tmux set-option -p -t "$tgt" @gotchibot-pstack-dossier 1 2>/dev/null || true
  local line=""
  [ -f "$ROOT/sessions/.desk-active.line" ] && line="$(tr -d '\n' < "$ROOT/sessions/.desk-active.line" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    tmux set-option -p -t "$tgt" pane-border-format " #{?pane_active,●, }Dossier · ${line} " 2>/dev/null || true
  else
    tmux set-option -p -t "$tgt" pane-border-format ' #{?pane_active,●, }Dossier ' 2>/dev/null || true
  fi
  tmux set-option -p -t "$tgt" history-limit 0 2>/dev/null || true
  tmux set-option -p -t "$tgt" pane-scrollbars off 2>/dev/null || true
}

current_slug() {
  local slug=""
  if [ -f "$CURRENT" ]; then
    slug="$(tr -d '[:space:]' < "$CURRENT")"
  fi
  if [ -z "$slug" ] || [ ! -f "$ROOT/sessions/pstack/$slug/dossier.json" ]; then
    slug="$(ls "$ROOT"/sessions/pstack/*/dossier.json 2>/dev/null | head -1 | sed 's#.*/sessions/pstack/##; s#/dossier.json##')"
  fi
  printf '%s' "$slug"
}

pull_hub() {
  node "$ROOT/scripts/hub-project-sync.mjs" pull >/dev/null 2>&1 || true
}

render() {
  local slug
  slug="$(current_slug)"
  local active=""
  [ -f "$ROOT/sessions/.desk-active.line" ] && active="$(tr -d '\n' < "$ROOT/sessions/.desk-active.line" 2>/dev/null || true)"
  printf '\033[2J\033[H'
  [ -n "$active" ] && printf '%s\n\n' "$active"
  if [ -z "$slug" ]; then
    printf '%s\n' \
      "pstack · dossier wizard — no program yet" \
      "" \
      "new:  ./scripts/gotchibot pstack dossier new <slug> --goal \"…\"" \
      "list: ./scripts/gotchibot pstack dossier list" \
      "pane: leave with ./scripts/orchestrator-layout.sh leave-pstack-dossier"
    return 0
  fi
  node "$ROOT/scripts/pstack-dossier.mjs" show "$slug" 2>&1 || true
  printf '%s\n' \
    "" \
    "edit: ./scripts/gotchibot pstack dossier set $slug <field> <value>" \
    "pane: leave with ./scripts/orchestrator-layout.sh leave-pstack-dossier"
}

fingerprint() {
  local slug
  slug="$(current_slug)"
  if [ -f "$ROOT/sessions/.desk-active.line" ]; then
    stat -f '%m' "$ROOT/sessions/.desk-active.line" 2>/dev/null || stat -c '%Y' "$ROOT/sessions/.desk-active.line" 2>/dev/null || echo 0
  fi
  if [ -z "$slug" ]; then
    stat -f '%m' "$CURRENT" 2>/dev/null || echo 0
    return
  fi
  stat -f '%m' "$ROOT/sessions/pstack/$slug/dossier.json" 2>/dev/null || echo 0
}

case "${1:-watch}" in
  once)
    mark_self
    pull_hub
    render
    ;;
  watch)
    mark_self
    pull_hub
    render
    LAST_FP="$(fingerprint)"
    while true; do
      sleep "$INTERVAL"
      pull_hub
      FP="$(fingerprint)"
      if [ "$FP" != "$LAST_FP" ]; then
        render
        LAST_FP="$FP"
      fi
    done
    ;;
  *)
    echo "usage: pstack-pane.sh watch|once" >&2
    exit 2
    ;;
esac