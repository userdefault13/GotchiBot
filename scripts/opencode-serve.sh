#!/usr/bin/env bash
# Headless OpenCode server for MBP attach + iPhone (Tailscale).
# Port 4096 avoids Envio/Hasura 8080/8082 on the home iMac.
#
# Always requires Basic auth: OPENCODE_SERVER_PASSWORD must be set.
# Default bind: GOTCHIBOT_OPENCODE_HOSTNAME (default 0.0.0.0).
# Username default: OPENCODE_SERVER_USERNAME=opencode.
#
# The former GOTCHIBOT_OPENCODE_IOS=1 no-auth mode was removed (security:
# it exposed opencode serve with no auth on the tailnet).
#
#   abra run gotchibot -- ./scripts/opencode-serve.sh
#   abra run gotchibot -- ./scripts/gotchibot remote-serve
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GOTCHIBOT_OPENCODE_PORT:-4096}"
MDNS="${GOTCHIBOT_OPENCODE_MDNS:-1}"

cd "$ROOT"

if [ "${GOTCHIBOT_OPENCODE_IOS:-0}" = "1" ]; then
  echo "GOTCHIBOT_OPENCODE_IOS no-auth iOS mode was removed (security: it exposed opencode serve with no auth on the tailnet)." >&2
  exit 1
fi

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "OPENCODE_SERVER_PASSWORD unset — required for opencode serve." >&2
  echo "  abra set gotchibot OPENCODE_SERVER_PASSWORD" >&2
  exit 1
fi

command -v opencode >/dev/null || {
  echo "opencode not on PATH — install or confirm before running (no autonomous installs)." >&2
  exit 1
}

HOST="${GOTCHIBOT_OPENCODE_HOSTNAME:-0.0.0.0}"
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"

echo "opencode serve → http://${HOST}:${PORT}  user=${OPENCODE_SERVER_USERNAME}  (mdns=${MDNS})"

args=(serve --hostname "$HOST" --port "$PORT")
if [ "$MDNS" = "1" ]; then
  args+=(--mdns)
fi

exec opencode "${args[@]}"
