#!/usr/bin/env bash
# Omarchy desk refresh for the existing checkout (omarchymini). No hub, no :4001.
set -euo pipefail

DRY_RUN=0
usage() {
  echo "usage: $(basename "$0") [--dry-run]" >&2
  echo "desk client only — does not install a hub and leaves port 4001 alone" >&2
  echo "--dry-run prints each step and changes nothing (also GOTCHIBOT_DRY_RUN=1)" >&2
}
case "${1:-}" in
  "") ;;
  --dry-run|-n) DRY_RUN=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then usage; exit 2; fi
[[ "${GOTCHIBOT_DRY_RUN:-0}" == "1" ]] && DRY_RUN=1

# run CMD...: execute, or print it under --dry-run.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'dry-run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

for tool in git node; do
  command -v "$tool" >/dev/null 2>&1 || echo "note: $tool not on PATH (Omarchy: omarchy pkg add ${tool/node/nodejs})" >&2
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
SOURCE="$ROOT/scripts/gotchibot"
TARGET="$BIN_DIR/gotchibot"

link_desk() {
  if [[ ! -f "$SOURCE" ]]; then
    echo "missing desk CLI: $SOURCE" >&2
    exit 1
  fi

  run mkdir -p "$BIN_DIR"
  run ln -sfn "$SOURCE" "$TARGET"

  if command -v node >/dev/null 2>&1; then
    run node "$ROOT/scripts/ensure-local-config.mjs" --quiet
  else
    echo "node not on PATH; symlink is in place, skipped config seed" >&2
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "Dry run: nothing was changed."
    echo "GotchiBot desk client would link: $TARGET -> $SOURCE"
  else
    echo "GotchiBot desk client linked: $TARGET -> $SOURCE"
  fi
  echo "No hub was installed. Port 4001 was not touched."
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) echo "Add ${BIN_DIR} to PATH, or run ${SOURCE}" ;;
  esac
}

# ── optional: gliff (Hyprland-to-Hyprland remote desktop over ssh) ──────────
# Sources in order: OPR (`omarchy pkg add gliff`), an AUR helper if the AUR lists it,
# then opt-in upstream source build (GOTCHIBOT_GLIFF_SOURCE=1). No piped installer.
# GOTCHIBOT_GLIFF_ONLY=1 runs just this step.
# Skipped (one line each) on macOS, non-Omarchy boxes, the hub, low-RAM desks,
# and when gliff is already there. Opt out with GOTCHIBOT_GLIFF=0. A missing
# package is a note, never a failed desk install.
gliff_done() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "gliff: would install with $1"; else echo "gliff: installed with $1"; fi
}
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
  # 1) Omarchy Package Repository (OPR, github.com/omacom/omarchy-pkgs).
  if run omarchy pkg add gliff; then
    gliff_done "omarchy pkg add gliff"; return 0
  fi
  # 2) An AUR helper, only if the AUR actually lists gliff (it did not on 2026-10-11).
  local helper
  for helper in yay paru; do
    if command -v "$helper" >/dev/null 2>&1 && "$helper" -Ssq '^gliff$' 2>/dev/null | grep -qx gliff; then
      if run "$helper" -S --needed --noconfirm gliff; then gliff_done "$helper (AUR)"; return 0; fi
    fi
  done
  # 3) Upstream source (github.com/omacom/gliff): bin/install runs makepkg -fsi,
  #    which needs sudo for pacman. Opt-in only, and only with non-interactive sudo.
  local src="${GOTCHIBOT_GLIFF_SRC_DIR:-${HOME}/.cache/gotchibot/gliff}"
  local hint="git clone https://github.com/omacom/gliff ${src} && ${src}/bin/install"
  if [[ "${GOTCHIBOT_GLIFF_SOURCE:-0}" != "1" ]]; then
    echo "gliff: not in OPR/AUR here; not installed (desk install is fine)."
    echo "gliff: hint: GOTCHIBOT_GLIFF_SOURCE=1 $0  or run: ${hint}"
    return 0
  fi
  if ! command -v makepkg >/dev/null 2>&1; then
    echo "gliff: skipped (no makepkg for a source build); run on Arch: ${hint}"; return 0
  fi
  if [[ "$DRY_RUN" != "1" ]] && ! sudo -n true 2>/dev/null; then
    echo "gliff: source build needs sudo (pacman); run it yourself: ${hint}"; return 0
  fi
  if [[ -d "$src/.git" ]]; then
    run git -C "$src" pull --ff-only -q || { echo "gliff: could not update $src; run: ${hint}"; return 0; }
  else
    run mkdir -p "$(dirname "$src")"
    run git clone -q https://github.com/omacom/gliff "$src" || { echo "gliff: clone failed; run: ${hint}"; return 0; }
  fi
  if run "$src/bin/install" --noconfirm; then
    gliff_done "source build (github.com/omacom/gliff bin/install)"
  else
    echo "gliff: source build failed; not installed (desk install is fine). Retry: ${hint}"
  fi
  return 0
}
if [[ "${GOTCHIBOT_GLIFF_ONLY:-0}" != "1" ]]; then
  link_desk
fi
install_gliff
