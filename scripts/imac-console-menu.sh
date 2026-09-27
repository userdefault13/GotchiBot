#!/usr/bin/env bash
# imac-console-menu.sh -- desk menu for the 2020 console (physical keyboard /
# monitor at the machine) or over SSH into it.
# Monitor DPMS/backlight actions need Linux sysfs + sudo tee. On macOS those
# paths are absent; the menu still runs and those actions fail soft.

set -u

DPMS_PATH="/sys/class/drm/card0/card0-Unknown-1/dpms"
BACKLIGHT_BRIGHTNESS="/sys/class/backlight/gmux_backlight/brightness"
BACKLIGHT_MAX="/sys/class/backlight/gmux_backlight/max_brightness"

MENU_ITEMS=(
  "1) Monitor off"
  "2) Monitor on"
  "3) Docker"
  "4) CPU/mem"
  "5) Quit"
)

CHOOSER=""
SELECT_BIN=""
CHOICE=""

detect_chooser() {
  if command -v gum >/dev/null 2>&1; then
    CHOOSER="gum"
    return
  fi
  # type -P finds a PATH binary; ignores the shell select keyword.
  SELECT_BIN="$(type -P select 2>/dev/null || true)"
  if [[ -n "${SELECT_BIN}" && -x "${SELECT_BIN}" ]]; then
    CHOOSER="select"
    return
  fi
  CHOOSER="prompt"
}

# Sets global CHOICE. Banner/prompt go to stderr so they never pollute CHOICE.
# Returns 1 only for gum/select cancel; EOF exits 0. Empty prompt input re-asks.
choose_menu() {
  CHOICE=""
  case "${CHOOSER}" in
    gum)
      CHOICE="$(printf '%s\n' "${MENU_ITEMS[@]}" | gum choose)" || return 1
      ;;
    select)
      CHOICE="$(printf '%s\n' "${MENU_ITEMS[@]}" | "${SELECT_BIN}")" || return 1
      ;;
    prompt)
      local reply
      while true; do
        echo >&2
        echo "Console menu" >&2
        printf '  %s\n' "${MENU_ITEMS[@]}" >&2
        printf 'Pick 1-5: ' >&2
        if ! read -r reply; then
          echo "Bye."
          exit 0
        fi
        # Empty / whitespace-only: re-prompt, do not exit.
        if [[ -z "${reply//[[:space:]]/}" ]]; then
          continue
        fi
        case "${reply}" in
          1) CHOICE="${MENU_ITEMS[0]}"; return 0 ;;
          2) CHOICE="${MENU_ITEMS[1]}"; return 0 ;;
          3) CHOICE="${MENU_ITEMS[2]}"; return 0 ;;
          4) CHOICE="${MENU_ITEMS[3]}"; return 0 ;;
          5) CHOICE="${MENU_ITEMS[4]}"; return 0 ;;
          *)
            printf 'Invalid pick: %s\n' "${reply}" >&2
            ;;
        esac
      done
      ;;
  esac
}

sysfs_write() {
  local value="$1" path="$2"
  if [[ ! -e "${path}" ]]; then
    printf 'error: path missing: %s\n' "${path}"
    printf 'This is Linux sysfs and will not work on macOS.\n'
    return 1
  fi
  if ! printf '%s\n' "${value}" | sudo tee "${path}" >/dev/null; then
    printf 'error: failed writing %s to %s (sudo unavailable or denied)\n' \
      "${value}" "${path}"
    return 1
  fi
}

action_monitor_off() {
  echo "Monitor off (DPMS Off, backlight 0)..."
  sysfs_write "Off" "${DPMS_PATH}" || true
  sysfs_write "0" "${BACKLIGHT_BRIGHTNESS}" || true
}

action_monitor_on() {
  local max target="12053"
  echo "Monitor on..."
  sysfs_write "On" "${DPMS_PATH}" || true
  if [[ -r "${BACKLIGHT_MAX}" ]]; then
    max="$(<"${BACKLIGHT_MAX}")" || max=""
    if [[ "${max}" =~ ^[0-9]+$ ]]; then
      target=$((max / 2))
    fi
  fi
  if sysfs_write "${target}" "${BACKLIGHT_BRIGHTNESS}"; then
    printf 'brightness set to %s\n' "${target}"
  fi
}

action_docker() {
  if command -v lazydocker >/dev/null 2>&1; then
    lazydocker || true
    echo "lazydocker exited; back to menu."
  else
    echo "lazydocker not installed (not on PATH). Skipping."
  fi
}

action_cpu_mem() {
  if command -v btop >/dev/null 2>&1; then
    btop || true
  else
    top || true
  fi
}

pause() {
  printf 'Press Enter to continue... '
  if ! read -r _; then
    echo "Bye."
    exit 0
  fi
}

main() {
  detect_chooser
  printf 'chooser: %s\n' "${CHOOSER}"

  while true; do
    clear 2>/dev/null || true
    printf 'iMac console menu (%s)\n' "${CHOOSER}"
    if ! choose_menu; then
      echo "No selection; try again."
      sleep 1
      continue
    fi
    CHOICE="${CHOICE%"${CHOICE##*[![:space:]]}"}"

    case "${CHOICE}" in
      "1) Monitor off") action_monitor_off; pause ;;
      "2) Monitor on")  action_monitor_on;  pause ;;
      "3) Docker")      action_docker;      pause ;;
      "4) CPU/mem")     action_cpu_mem ;;
      "5) Quit")
        echo "Bye."
        exit 0
        ;;
      *)
        printf 'Unknown choice: %s\n' "${CHOICE}"
        sleep 1
        ;;
    esac
  done
}

main "$@"
