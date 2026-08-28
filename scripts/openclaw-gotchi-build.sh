#!/usr/bin/env bash
# Apply GotchiBot TUI patches to a local OpenClaw checkout and build dist/.
#
#   ./scripts/openclaw-gotchi-build.sh
#   OPENCLAW_SRC=~/Dev/openclaw ./scripts/openclaw-gotchi-build.sh
#
# Requires pnpm in the OpenClaw repo (pnpm install once, not run automatically here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="$ROOT/patches/openclaw-gotchi-tui"
OPENCLAW_SRC="${OPENCLAW_SRC:-$HOME/Dev/openclaw}"

if [ ! -d "$OPENCLAW_SRC/.git" ] && [ ! -f "$OPENCLAW_SRC/package.json" ]; then
  echo "OpenClaw source not found at $OPENCLAW_SRC" >&2
  echo "Clone: git clone https://github.com/openclaw/openclaw.git $OPENCLAW_SRC" >&2
  exit 1
fi

if [ ! -f "$PATCH_DIR/gotchi-commands.ts" ]; then
  echo "Missing patch files in $PATCH_DIR" >&2
  exit 1
fi

echo "Applying GotchiBot TUI patch → $OPENCLAW_SRC"

cp "$PATCH_DIR/gotchi-load-progress.ts" "$OPENCLAW_SRC/src/tui/gotchi-load-progress.ts"
cp "$PATCH_DIR/gotchi-prose-segments.ts" "$OPENCLAW_SRC/src/tui/gotchi-prose-segments.ts"
cp "$PATCH_DIR/gotchi-prose-tts.ts" "$OPENCLAW_SRC/src/tui/gotchi-prose-tts.ts"
cp "$PATCH_DIR/gotchi-prose-segments.test.ts" "$OPENCLAW_SRC/src/tui/gotchi-prose-segments.test.ts"
cp "$PATCH_DIR/gotchi-commands.ts" "$OPENCLAW_SRC/src/tui/gotchi-commands.ts"
cp "$PATCH_DIR/gotchi-commands.test.ts" "$OPENCLAW_SRC/src/tui/gotchi-commands.test.ts"
cp "$PATCH_DIR/gotchi-tui-chrome.ts" "$OPENCLAW_SRC/src/tui/gotchi-tui-chrome.ts"
cp "$PATCH_DIR/gotchi-tui-chrome.test.ts" "$OPENCLAW_SRC/src/tui/gotchi-tui-chrome.test.ts"
cp "$PATCH_DIR/chat-log.ts" "$OPENCLAW_SRC/src/tui/components/chat-log.ts"
cp "$PATCH_DIR/user-message.ts" "$OPENCLAW_SRC/src/tui/components/user-message.ts"
cp "$PATCH_DIR/assistant-message.ts" "$OPENCLAW_SRC/src/tui/components/assistant-message.ts"
cp "$PATCH_DIR/custom-editor.ts" "$OPENCLAW_SRC/src/tui/components/custom-editor.ts"
cp "$PATCH_DIR/gotchi-system-tray.ts" "$OPENCLAW_SRC/src/tui/components/gotchi-system-tray.ts"
cp "$PATCH_DIR/tool-execution.ts" "$OPENCLAW_SRC/src/tui/components/tool-execution.ts"
cp "$PATCH_DIR/commands.ts" "$OPENCLAW_SRC/src/tui/commands.ts"
cp "$PATCH_DIR/tui-command-handlers.ts" "$OPENCLAW_SRC/src/tui/tui-command-handlers.ts"
cp "$PATCH_DIR/tui.ts" "$OPENCLAW_SRC/src/tui/tui.ts"
cp "$PATCH_DIR/theme.ts" "$OPENCLAW_SRC/src/tui/theme/theme.ts"
cp "$PATCH_DIR/opencode-palette.ts" "$OPENCLAW_SRC/src/tui/theme/opencode-palette.ts"

cd "$OPENCLAW_SRC"
if [ ! -d node_modules ]; then
  echo ""
  echo "node_modules missing in $OPENCLAW_SRC"
  echo "Run once:  cd $OPENCLAW_SRC && pnpm install"
  echo "Then re-run: $ROOT/scripts/openclaw-gotchi-build.sh"
  exit 1
fi

echo "Building OpenClaw dist (core only — skips plugin asset bundle)…"
pnpm exec node --import tsx scripts/tsdown-build.mts
node scripts/runtime-postbuild.mjs 2>/dev/null || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$OPENCLAW_SRC/dist/.gotchi-patch-built"

if [ -f "$OPENCLAW_SRC/dist/entry.js" ] \
  && rg -q 'formatGotchiOpencodeHeader|B650FF' "$OPENCLAW_SRC/dist/entry.js" "$OPENCLAW_SRC/dist"/tui-*.js 2>/dev/null; then
  echo ""
  echo "GotchiBot TUI patch ready (purple/pink theme + /orch /list /switch)."
  echo "Chat pane will use: $ROOT/scripts/openclaw-gotchi.sh"
  echo "Respawn tmux center pane, then try: /orch  /list  /switch"
else
  echo "Build finished but GotchiBot patch markers not found in dist — check build output" >&2
  exit 1
fi
