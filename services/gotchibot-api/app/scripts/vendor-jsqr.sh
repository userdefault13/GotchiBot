#!/usr/bin/env bash
# Reproduce vendor/jsQR.min.js from npm jsqr@1.4.0 (Apache-2.0).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

cd "$TMP"
npm pack jsqr@1.4.0 --silent
tar -xzf jsqr-1.4.0.tgz
npx --yes esbuild package/dist/jsQR.js --minify --outfile=jsQR.min.raw.js
{
  echo '/*! jsQR 1.4.0 — Apache-2.0 — https://github.com/cozmo/jsQR */'
  cat jsQR.min.raw.js
} > "$ROOT/vendor/jsQR.min.js"
cp package/LICENSE "$ROOT/vendor/LICENSE-jsQR.txt"
echo "Wrote $ROOT/vendor/jsQR.min.js ($(wc -c < "$ROOT/vendor/jsQR.min.js") bytes)"
