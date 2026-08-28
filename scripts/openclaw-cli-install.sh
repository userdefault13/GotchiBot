#!/usr/bin/env bash
# Install OpenClaw CLI into ~/.openclaw (bundled Node 24 — no system Node upgrade needed).
#
#   ./scripts/openclaw-cli-install.sh
#   ./scripts/openclaw-cli-install.sh --onboard   # run openclaw onboard after install
#
# Docs: https://docs.openclaw.ai/install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${OPENCLAW_PREFIX:-$HOME/.openclaw}"
ONBOARD=0

args=()
for a in "$@"; do
  case "$a" in
    --onboard) ONBOARD=1 ;;
    *) args+=("$a") ;;
  esac
done

if [ "${#args[@]}" -eq 0 ]; then
  args=(--no-onboard)
fi

echo "Installing OpenClaw CLI → ${PREFIX}/bin/openclaw"
curl -fsSL https://openclaw.ai/install-cli.sh | bash -s -- "${args[@]}"

export PATH="${PREFIX}/bin:${PATH}"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw not on PATH after install" >&2
  exit 1
fi

openclaw --version

# GotchiBot fleet entries (harmless if cartridge not configured yet).
if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/openclaw-fleet.mjs" sync 2>/dev/null || true
fi

if [ "$ONBOARD" = 1 ]; then
  echo ""
  echo "Starting OpenClaw onboarding (gateway daemon, config)…"
  openclaw onboard --install-daemon
fi

cat <<EOF

OpenClaw CLI ready.

Add to ~/.zshrc (new shells):
  export PATH="\$HOME/.openclaw/bin:\$PATH"

GotchiBot scripts prepend this automatically.

Merge fleet into gateway config:
  node $ROOT/scripts/openclaw-fleet.mjs sync
  # then include $ROOT/config/openclaw.install.json5 in ~/.openclaw/openclaw.json

Verify:
  openclaw doctor
  openclaw gateway status
  ./scripts/gotchibot openclaw status
EOF
