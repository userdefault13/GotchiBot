#!/usr/bin/env bash
# Runs ON the Hub (iMac). Invoked by scripts/hub-vscode-open.mjs over SSH.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${PATH}"

ACTION="${1:-open}"
TIMEOUT="${2:-45}"
PREFERRED="${3:-}"

resolve_folder() {
  local c
  for c in "$PREFERRED" "$HOME/Dev/GotchiBot" "$HOME/dev/GotchiBot"; do
    [ -n "$c" ] && [ -d "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

bridge_up() {
  local out
  out="$(
    python3 - <<'PY' 2>/dev/null || true
import urllib.request
try:
    r = urllib.request.urlopen(
        urllib.request.Request(
            "http://127.0.0.1:45678/prompt",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        ),
        timeout=2,
    )
    print(r.read().decode())
except Exception as e:
    body = b""
    if hasattr(e, "read"):
        try:
            body = e.read() or b""
        except Exception:
            body = b""
    print(body.decode() if body else str(e))
PY
  )"
  case "$out" in
    *missing*|*prompt*|*400*|*accepted*) return 0 ;;
  esac
  return 1
}

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

case "$ACTION" in
  check|probe)
    FOLDER="$(resolve_folder || true)"
    CODE_BIN=""
    for b in code code-insiders; do
      if command -v "$b" >/dev/null 2>&1; then CODE_BIN="$(command -v "$b")"; break; fi
    done
    VSCODE_APP=0
    [ -d "/Applications/Visual Studio Code.app" ] && VSCODE_APP=1
    BRIDGE_OK=0
    bridge_up && BRIDGE_OK=1
    printf '{"folder":"%s","codeBin":"%s","bridgeOk":%s,"vscodeApp":%s}\n' \
      "$(json_escape "${FOLDER:-}")" \
      "$(json_escape "${CODE_BIN:-}")" \
      "$BRIDGE_OK" "$VSCODE_APP"
    ;;
  open)
    FOLDER="$(resolve_folder)" || {
      echo "GotchiBot folder not found on Hub" >&2
      exit 1
    }
    if command -v code >/dev/null 2>&1; then
      code -r "$FOLDER"
      echo "opened via code -r → $FOLDER"
    elif command -v code-insiders >/dev/null 2>&1; then
      code-insiders -r "$FOLDER"
      echo "opened via code-insiders -r → $FOLDER"
    elif [ -d "/Applications/Visual Studio Code.app" ]; then
      open -a "Visual Studio Code" --args "$FOLDER"
      echo "opened via open -a → $FOLDER"
    else
      echo "no VS Code CLI or app on Hub" >&2
      exit 1
    fi
    ;;
  wait-bridge)
    deadline=$(($(date +%s) + TIMEOUT))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if bridge_up; then
        echo ok
        exit 0
      fi
      sleep 1
    done
    echo "bridge still down after ${TIMEOUT}s" >&2
    exit 1
    ;;
  restart-bridge)
    FOLDER="$(resolve_folder)" || {
      echo "GotchiBot folder not found on Hub" >&2
      exit 1
    }
    # 1. Focus VS Code on the GotchiBot folder (code -r, or open -a fallback).
    if command -v code >/dev/null 2>&1; then
      code -r "$FOLDER" >/dev/null 2>&1 || true
      echo "focused via code -r → $FOLDER"
    elif command -v code-insiders >/dev/null 2>&1; then
      code-insiders -r "$FOLDER" >/dev/null 2>&1 || true
      echo "focused via code-insiders -r → $FOLDER"
    elif [ -d "/Applications/Visual Studio Code.app" ]; then
      open -a "Visual Studio Code" --args "$FOLDER" >/dev/null 2>&1 || true
      echo "focused via open -a → $FOLDER"
    else
      echo "no VS Code CLI or app on Hub" >&2
      exit 1
    fi
    # 2. Ask the extension to restart the bridge server (ignore failure — may not be enabled yet).
    if command -v code >/dev/null 2>&1; then
      code --command gotchibotBridge.restart >/dev/null 2>&1 || true
    fi
    # 3. Wait for the bridge to come up.
    deadline=$(($(date +%s) + TIMEOUT))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if bridge_up; then
        echo "ok — bridge :45678 up after restart"
        exit 0
      fi
      sleep 1
    done
    echo "bridge still down after ${TIMEOUT}s (enable gotchibot-bridge + reload window + sign into Claude)" >&2
    exit 1
    ;;
  *)
    echo "usage: hub-vscode-open-remote.sh check|open|wait-bridge|restart-bridge [timeout] [preferredPath]" >&2
    exit 2
    ;;
esac
