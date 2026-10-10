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

# ── optional: gliff (Hyprland-to-Hyprland remote desktop over ssh) ──────────
# Installed with `omarchy pkg add gliff` only: no source build, no piped installer.
# Skipped (one line each) on macOS, non-Omarchy boxes, the hub, low-RAM desks,
# and when gliff is already there. Opt out with GOTCHIBOT_GLIFF=0. A missing
# package is a note, never a failed desk install.
install_gliff() {
  local os mem_kb min_kb host hub_names
  os="${GOTCHIBOT_GLIFF_OS:-$(uname -s)}"
  min_kb=$(( ${GOTCHIBOT_GLIFF_MIN_MIB:-2560} * 1024 ))
  if [[ "${GOTCHIBOT_GLIFF:-1}" == "0" ]]; then
    echo "gliff: skipped (GOTCHIBOT_GLIFF=0)"; return 0
  fi
  if [[ "$os" == "Darwin" ]]; then
    echo "gliff: skipped (macOS has no Hyprland)"; return 0
  fi
  if ! command -v omarchy >/dev/null 2>&1 || { ! command -v Hyprland >/dev/null 2>&1 && ! command -v hyprctl >/dev/null 2>&1; }; then
    echo "gliff: skipped (not an Omarchy/Hyprland desk)"; return 0
  fi
  host="${GOTCHIBOT_GLIFF_HOST:-$(hostname 2>/dev/null || true)}"
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"; host="${host%%.*}"
  hub_names="imacomarchy"
  if command -v node >/dev/null 2>&1 && [[ -f "$ROOT/config/desks.json" ]]; then
    hub_names="$(node -e 'const d=require(process.argv[1]).desks||{};console.log(Object.entries(d).filter(([,v])=>v.role==="hub").map(([k])=>k).join(" "))' "$ROOT/config/desks.json" 2>/dev/null || echo imacomarchy)"
  fi
  case " $hub_names " in
    *" $host "*) echo "gliff: skipped (hub desk; its RAM stays for the hub)"; return 0 ;;
  esac
  mem_kb="${GOTCHIBOT_GLIFF_MEMKB:-$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)}"
  if [[ "${mem_kb:-0}" -gt 0 && "$mem_kb" -lt "$min_kb" ]]; then
    echo "gliff: skipped (low RAM: $(( mem_kb / 1024 )) MiB < $(( min_kb / 1024 )) MiB)"; return 0
  fi
  if command -v gliff >/dev/null 2>&1; then
    echo "gliff: already installed"; return 0
  fi
  if omarchy pkg add gliff; then
    echo "gliff: installed with omarchy pkg add gliff"
  else
    echo "gliff: package not found via 'omarchy pkg add gliff'; not installed (desk install is fine)"
  fi
  return 0
}
install_gliff
