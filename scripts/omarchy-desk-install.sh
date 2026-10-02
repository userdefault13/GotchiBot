#!/usr/bin/env bash
# Omarchy desk refresh for the existing checkout (omarchymini). No hub, no :4001.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: $(basename "$0")" >&2
  echo "desk client only — does not install a hub and leaves port 4001 alone" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
SOURCE="$ROOT/scripts/gotchibot"
TARGET="$BIN_DIR/gotchibot"

if [[ ! -f "$SOURCE" ]]; then
  echo "missing desk CLI: $SOURCE" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sfn "$SOURCE" "$TARGET"

if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/ensure-local-config.mjs" --quiet
else
  echo "node not on PATH; symlink is in place, skipped config seed" >&2
fi

echo "GotchiBot desk client linked: $TARGET -> $SOURCE"
echo "No hub was installed. Port 4001 was not touched."
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add ${BIN_DIR} to PATH, or run ${SOURCE}" ;;
esac
