#!/usr/bin/env bash
# Switch this Mac from Tailscale GUI (App/pkg) to open-source Homebrew CLI.
# Run locally in Terminal (needs your password). Safe to re-run.
#
#   ./scripts/tailscale-cli-switch.sh
set -euo pipefail

echo "== quit GUI =="
osascript -e 'quit app "Tailscale"' 2>/dev/null || true
killall Tailscale 2>/dev/null || true
killall io.tailscale.ipn.macsys.network-extension 2>/dev/null || true

echo "== remove GUI app + /usr/local/bin/tailscale stub (admin) =="
osascript <<'EOF'
do shell script "rm -rf /Applications/Tailscale.app /usr/local/bin/tailscale; pkgutil --forget com.tailscale.ipn.macsys 2>/dev/null || true; rm -rf /Library/Tailscale 2>/dev/null || true" with administrator privileges
EOF

echo "== brew formula =="
if ! command -v brew >/dev/null; then
  echo "Homebrew required" >&2
  exit 1
fi
brew list tailscale >/dev/null 2>&1 || brew install tailscale

echo "== start tailscaled =="
osascript <<'EOF'
do shell script "$(command -v brew) services start tailscale" with administrator privileges
EOF

BIN="$(brew --prefix)/bin/tailscale"
echo "== login (browser) =="
"$BIN" status 2>&1 | head -5 || true
echo "Run: $BIN up"
echo "Then: $BIN status"
echo "Prefer PATH: export PATH=\"$(brew --prefix)/bin:\$PATH\"  # before /usr/local/bin"
