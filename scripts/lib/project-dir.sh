# shellcheck shell=bash
# project_dir ROOT — the current project's folder (its reconnected checkout), else ROOT.
# Files and Terminal open here so every pane follows the desk's project.
project_dir() {
  local root="$1" dir=""
  if command -v node >/dev/null 2>&1; then
    dir="$(cd "$root" && node --input-type=module -e 'import { currentProjectSlug, reconnectProjectDb } from "./scripts/project-context.mjs"; const s = currentProjectSlug(); process.stdout.write((s && reconnectProjectDb(s)) || "");' 2>/dev/null || true)"
  fi
  if [ -n "$dir" ] && [ -d "$dir" ]; then printf '%s\n' "$dir"; else printf '%s\n' "$root"; fi
}
