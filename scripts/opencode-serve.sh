#!/usr/bin/env bash
# Headless OpenCode server for MBP attach + iPhone (Tailscale).
# Port 4096 avoids Envio/Hasura 8080/8082 on the home iMac.
#
# Modes:
#   Default: bind 0.0.0.0 + Basic auth (OPENCODE_SERVER_PASSWORD required)
#   iOS-friendly (OpenCode Mobile often ignores password fields):
#     GOTCHIBOT_OPENCODE_IOS=1
#       → bind Tailscale IP only (no LAN/public), no Basic auth
#
#   abra run gotchibot -- ./scripts/opencode-serve.sh
#   GOTCHIBOT_OPENCODE_IOS=1 abra run gotchibot -- ./scripts/gotchibot remote-serve
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GOTCHIBOT_OPENCODE_PORT:-4096}"
MDNS="${GOTCHIBOT_OPENCODE_MDNS:-1}"
IOS_MODE="${GOTCHIBOT_OPENCODE_IOS:-0}"

cd "$ROOT"
command -v opencode >/dev/null || {
  echo "opencode not on PATH — install or confirm before running (no autonomous installs)." >&2
  exit 1
}

if [ "$IOS_MODE" = "1" ]; then
  # Tailscale-only bind: reachable from phone/MBP on the tailnet, not the LAN.
  HOST="${GOTCHIBOT_OPENCODE_HOSTNAME:-${REMOTE_HOST:-}}"
  if [ -z "$HOST" ]; then
    echo "GOTCHIBOT_OPENCODE_IOS=1 needs REMOTE_HOST or GOTCHIBOT_OPENCODE_HOSTNAME (Tailscale IP)." >&2
    exit 1
  fi
  unset OPENCODE_SERVER_PASSWORD || true
  unset OPENCODE_SERVER_USERNAME || true
  MDNS=0
  echo "opencode serve → http://${HOST}:${PORT}  (Tailscale-only, no Basic auth — for OpenCode Mobile)"
  echo "iPhone: Tailscale ON → URL http://${HOST}:${PORT}  (leave user/password blank)"
else
  HOST="${GOTCHIBOT_OPENCODE_HOSTNAME:-0.0.0.0}"
  export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo "OPENCODE_SERVER_PASSWORD unset — required unless GOTCHIBOT_OPENCODE_IOS=1." >&2
    echo "  abra set gotchibot OPENCODE_SERVER_PASSWORD" >&2
    exit 1
  fi
  echo "opencode serve → http://${HOST}:${PORT}  user=${OPENCODE_SERVER_USERNAME}  (mdns=${MDNS})"
  echo "iOS: prefer GOTCHIBOT_OPENCODE_IOS=1 — OpenCode Mobile often cannot send Basic auth"
fi

args=(serve --hostname "$HOST" --port "$PORT")
if [ "$MDNS" = "1" ]; then
  args+=(--mdns)
fi

exec opencode "${args[@]}"
