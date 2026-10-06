#!/usr/bin/env bash
# screen-power.sh — turn a Linux desk's backlight off to save the panel and power.
#
#   screen-power.sh status         which backlight, current / max brightness
#   screen-power.sh off            backlight 0 (remembers the current level)
#   screen-power.sh on             back to the remembered level (else max)
#   screen-power.sh off-until-key  off now, any key turns it back on
#   gotchibot screen …             same; cockpit → Settings… → Screen off
#
# Any machine with /sys/class/backlight (2020 iMac gmux_backlight, Apple Silicon
# apple-panel-bl, laptops). Brightness is set through systemd-logind
# (Session.SetBrightness): no password for the user logged in at the machine's
# own screen, which is where the desk runs. Over SSH logind refuses, and it
# falls back to `sudo tee` (asks for the password). The old 2020-only menu is
# scripts/imac-console-menu.sh.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/sessions/.screen-power"
SYS="${GOTCHIBOT_BACKLIGHT_SYSFS:-/sys/class/backlight}"

# Preferred panel backlights first, then whatever the machine has.
backlight() {
  local d
  for d in gmux_backlight apple-panel-bl intel_backlight acpi_video0; do
    [ -e "$SYS/$d/brightness" ] && { printf '%s\n' "$d"; return 0; }
  done
  for d in "$SYS"/*; do
    [ -e "$d/brightness" ] && { basename "$d"; return 0; }
  done
  return 1
}

read_val() { tr -dc '0-9' < "$1" 2>/dev/null; }

set_brightness() {
  local dev="$1" value="$2"
  if command -v busctl >/dev/null 2>&1 \
    && busctl call org.freedesktop.login1 /org/freedesktop/login1/session/auto \
      org.freedesktop.login1.Session SetBrightness ssu backlight "$dev" "$value" >/dev/null 2>&1; then
    return 0
  fi
  [ -w "$SYS/$dev/brightness" ] && printf '%s\n' "$value" > "$SYS/$dev/brightness" 2>/dev/null && return 0
  echo "logind would not set the backlight here (not this machine's own screen?) — trying sudo" >&2
  printf '%s\n' "$value" | sudo tee "$SYS/$dev/brightness" >/dev/null
}

cmd_status() {
  local dev
  dev="$(backlight)" || { echo "no backlight on this machine"; return 1; }
  printf '%s %s/%s\n' "$dev" "$(read_val "$SYS/$dev/brightness")" "$(read_val "$SYS/$dev/max_brightness")"
}

cmd_off() {
  local dev cur
  dev="$(backlight)" || { echo "no backlight on this machine" >&2; return 1; }
  cur="$(read_val "$SYS/$dev/brightness")"
  # Keep the last real level: a second "off" must not remember 0.
  if [ -n "$cur" ] && [ "$cur" -gt 0 ]; then
    mkdir -p "$(dirname "$STATE")"
    printf '%s %s\n' "$dev" "$cur" > "$STATE"
  fi
  set_brightness "$dev" 0
}

cmd_on() {
  local dev saved_dev saved max
  dev="$(backlight)" || { echo "no backlight on this machine" >&2; return 1; }
  read -r saved_dev saved < "$STATE" 2>/dev/null || true
  max="$(read_val "$SYS/$dev/max_brightness")"
  if [ "${saved_dev:-}" != "$dev" ] || [ -z "${saved:-}" ] || [ "$saved" -le 0 ]; then
    saved="${max:-1}"
  fi
  set_brightness "$dev" "$saved"
}

cmd_off_until_key() {
  cmd_off || return 1
  printf '\n  Screen off. Press any key to turn it back on.\n' >&2
  # Wake on any key; restore even if the read is interrupted.
  trap 'cmd_on' EXIT
  IFS= read -rsn1 _ 2>/dev/null || sleep 86400
}

case "${1:-status}" in
  status) cmd_status ;;
  off) cmd_off ;;
  on) cmd_on ;;
  off-until-key) cmd_off_until_key ;;
  available) backlight >/dev/null ;;
  *)
    echo "usage: screen-power.sh status|off|on|off-until-key|available" >&2
    exit 2
    ;;
esac
