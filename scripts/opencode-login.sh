#!/bin/bash
# opencode-login.sh — restore the OpenCode Go credential (console API key → auth.json; subscription quotas).
#
# `opencode auth login` is interactive (a searchable provider prompt, then a
# browser step), so an agent cannot complete it. This puts the prompt in a real
# Terminal.app window for Julius, then waits for the credential store to appear
# and reports what OpenCode can see afterwards — never any secret values.
#
#   scripts/opencode-login.sh              open the login window, wait, verify
#   scripts/opencode-login.sh --status     just report (no window)
#   scripts/opencode-login.sh --timeout 900
#
# Credential store: ~/.local/share/opencode/auth.json (created by the login).
set -euo pipefail

AUTH_FILE="${OPENCODE_AUTH_FILE:-$HOME/.local/share/opencode/auth.json}"
TIMEOUT="${OPENCODE_LOGIN_TIMEOUT:-600}"
STATUS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --status) STATUS_ONLY=1; shift ;;
    --timeout) TIMEOUT="${2:-600}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

report() {
  local go zen
  echo "credential store: $AUTH_FILE"
  if [ -f "$AUTH_FILE" ]; then
    echo "  present, $(stat -f %Sm -t '%Y-%m-%d %H:%M' "$AUTH_FILE")"
  else
    echo "  MISSING — not logged in"
  fi
  # Provider names only; `opencode auth list` never prints values.
  echo "providers with credentials:"
  opencode auth list 2>/dev/null | grep -vE "opencode-mobile|Credentials|^\s*[│┌└]?\s*$" | sed 's/^/  /' | head -12 || true
  go="$(opencode models 2>/dev/null | grep -c '^opencode-go/' || true)"
  zen="$(opencode models 2>/dev/null | grep -c '^opencode/' || true)"
  echo "models visible: opencode-go/* = ${go:-0}   opencode/* = ${zen:-0}"
  if [ "${go:-0}" -gt 0 ]; then
    echo "OpenCode Go: OK — subscription models available"
    return 0
  fi
  echo "OpenCode Go: NOT available yet"
  return 1
}

if [ "$STATUS_ONLY" = 1 ]; then
  report
  exit $?
fi

if [ -f "$AUTH_FILE" ] && report >/dev/null 2>&1; then
  echo "already logged in:"
  report
  exit 0
fi

before_mtime="$( [ -f "$AUTH_FILE" ] && stat -f %m "$AUTH_FILE" || echo 0 )"

# A real terminal on the desktop: the prompt needs a TTY and the login a browser.
if command -v osascript >/dev/null 2>&1; then
  osascript >/dev/null <<'APPLESCRIPT'
tell application "Terminal"
  activate
  do script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; clear; echo 'GotchiBot: OpenCode login — type opencode, pick OpenCode Go, paste the API key from opencode.ai/auth (API Keys), then close this window.'; echo; opencode auth login; echo; echo 'done — you can close this window'; exec $SHELL -l"
end tell
APPLESCRIPT
  echo "opened a Terminal window with 'opencode auth login' — complete it there."
else
  echo "no desktop terminal available here; run this yourself:  opencode auth login" >&2
  exit 3
fi

echo "waiting up to ${TIMEOUT}s for the credential store…"
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  now_mtime="$( [ -f "$AUTH_FILE" ] && stat -f %m "$AUTH_FILE" || echo 0 )"
  if [ "$now_mtime" != "$before_mtime" ] && [ "$now_mtime" != 0 ]; then
    sleep 2
    echo
    report
    exit $?
  fi
  sleep 3
done
echo "timed out after ${TIMEOUT}s — the login window is still open; rerun with --status once it is done." >&2
exit 4
