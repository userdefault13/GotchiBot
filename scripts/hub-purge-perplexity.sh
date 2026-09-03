#!/usr/bin/env bash
# Runs ON Hub. Strip perplexity (+ stock opencode) so gateway can become ready.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${PATH}"

mkdir -p "$HOME/.openclaw/npm/projects-disabled"

echo "=== npm projects (before) ==="
ls -1 "$HOME/.openclaw/npm/projects" 2>/dev/null || echo "(none)"

if [ -d "$HOME/.openclaw/npm/projects" ]; then
  shopt -s nullglob
  for d in "$HOME/.openclaw/npm/projects"/*; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"
    case "$base" in
      *perplexity*|*opencode*)
        echo "quarantine $base"
        mv "$d" "$HOME/.openclaw/npm/projects-disabled/" || true
        ;;
    esac
  done
  shopt -u nullglob
fi

rm -rf \
  "$HOME/.openclaw/extensions/perplexity" \
  "$HOME/.openclaw/plugins/perplexity" \
  "$HOME/.openclaw/extensions/opencode" \
  "$HOME/.openclaw/plugins/opencode" \
  2>/dev/null || true

node <<'NODE'
const fs = require("fs");
const p = process.env.HOME + "/.openclaw/openclaw.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.gateway = c.gateway || {};
c.gateway.mode = "local";
c.gateway.bind = c.gateway.bind || "lan";
c.plugins = {
  allow: ["slack", "opencode-go"],
  entries: {
    slack: { enabled: true },
    "opencode-go": { enabled: true },
    perplexity: { enabled: false },
    opencode: { enabled: false },
  },
};
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
console.log("ok plugins", JSON.stringify(c.plugins));
NODE

echo "=== npm projects (after) ==="
ls -1 "$HOME/.openclaw/npm/projects" 2>/dev/null || echo "(none)"

bash "$HOME/Dev/GotchiBot/scripts/hub-ops-remote.sh" restart-gateway "${1:-150}" 1
