#!/usr/bin/env bash
# Terminal capability detection for headless / SSH GotchiBot desk use.
# Sourceable (defines gotchibot_term_caps) and runnable (prints one line).
# Pure bash — no node. Compatible with bash 3.2 (macOS).
#
# Sets: TUI_COLOR, TUI_GLYPHS, TUI_MOUSE
# Usage:
#   source scripts/lib/term-caps.sh && gotchibot_term_caps
#   ./scripts/lib/term-caps.sh

gotchibot_term_caps() {
  local term term_lc colorterm_lc color_override loc loc_lc
  local color glyphs mouse
  local plain ascii_forced mouse_forced_off
  local term_ascii term_mouse_off
  local is_tmux_or_screen
  local probe_out client_term client_features
  local no_probe
  local ct

  term="${TERM:-}"
  term_lc=$(printf '%s' "$term" | tr '[:upper:]' '[:lower:]')

  plain=0
  if [ "${GOTCHIBOT_TUI_PLAIN:-}" = "1" ]; then
    plain=1
  fi

  ascii_forced=0
  if [ "$plain" = "1" ] || [ "${GOTCHIBOT_TUI_ASCII:-}" = "1" ]; then
    ascii_forced=1
  fi

  mouse_forced_off=0
  if [ "$plain" = "1" ] || [ "${GOTCHIBOT_TUI_MOUSE:-}" = "0" ]; then
    mouse_forced_off=1
  fi

  # Parse GOTCHIBOT_TUI_COLOR aliases (invalid → empty).
  color_override=""
  case "$(printf '%s' "${GOTCHIBOT_TUI_COLOR:-}" | tr '[:upper:]' '[:lower:]')" in
    truecolor|24bit|true|rgb) color_override="truecolor" ;;
    256|256color) color_override="256" ;;
    16|8|16color|basic) color_override="16" ;;
    none|0|off|no) color_override="none" ;;
  esac

  term_ascii=0
  term_mouse_off=0
  case "$term_lc" in
    dumb)
      term_ascii=1
      term_mouse_off=1
      ;;
    linux|vt*|cons25|ansi)
      term_ascii=1
      case "$term_lc" in
        linux|vt*) term_mouse_off=1 ;;
      esac
      ;;
  esac

  is_tmux_or_screen=0
  case "$term_lc" in
    tmux*|screen*) is_tmux_or_screen=1 ;;
  esac

  # --- color ---
  if [ -n "$color_override" ]; then
    color="$color_override"
  elif [ "$plain" = "1" ]; then
    color="16"
  elif [ -n "${NO_COLOR:-}" ]; then
    color="none"
  else
    colorterm_lc=$(printf '%s' "${COLORTERM:-}" | tr '[:upper:]' '[:lower:]')
    if [ "$colorterm_lc" = "truecolor" ] || [ "$colorterm_lc" = "24bit" ]; then
      color="truecolor"
    elif [ "$is_tmux_or_screen" = "1" ]; then
      no_probe=0
      if [ "${GOTCHIBOT_TUI_NO_PROBE:-}" = "1" ]; then
        no_probe=1
      fi
      if [ "$no_probe" = "1" ]; then
        color="256"
      else
        probe_out=""
        if command -v tmux >/dev/null 2>&1 && [ -n "${TMUX:-}" ]; then
          probe_out=$(tmux display-message -p '#{client_termname}|#{client_termfeatures}' 2>/dev/null) || probe_out=""
        fi
        if [ -z "$probe_out" ]; then
          color="256"
        else
          client_term="${probe_out%%|*}"
          if [ "$probe_out" = "$client_term" ]; then
            client_features=""
          else
            client_features="${probe_out#*|}"
          fi
          ct=$(printf '%s' "$client_term" | tr '[:upper:]' '[:lower:]')
          # No attached client yet (detached session) → unknown → 256, not 16.
          if [ -z "$ct" ]; then
            case "$client_features" in *RGB*|*rgb*) ;; *) client_features="__none__"; ct="tmux-256color" ;; esac
          fi
          case "$client_features" in
            *RGB*|*rgb*)
              color="truecolor"
              ;;
            *)
              case "$ct" in
                xterm-kitty|kitty|foot|foot-extra|alacritty|wezterm|xterm-ghostty|ghostty)
                  color="truecolor"
                  ;;
                *-direct)
                  color="truecolor"
                  ;;
                tmux*|screen*)
                  color="256"
                  ;;
                dumb)
                  color="none"
                  term_ascii=1
                  ;;
                linux|vt*|cons25|ansi)
                  color="16"
                  term_ascii=1
                  ;;
                *256color*)
                  color="256"
                  ;;
                *)
                  color="16"
                  ;;
              esac
              ;;
          esac
        fi
      fi
    else
      # Rule 4 on local TERM (non-tmux).
      case "$term_lc" in
        "")
          color="16"
          ;;
        dumb)
          color="none"
          ;;
        linux|vt*|cons25|ansi)
          color="16"
          ;;
        *-direct)
          color="truecolor"
          ;;
        *256color*)
          color="256"
          ;;
        xterm-kitty|kitty|foot|foot-extra|alacritty|wezterm|xterm-ghostty|ghostty)
          color="truecolor"
          ;;
        *)
          color="16"
          ;;
      esac
    fi
  fi

  # --- glyphs ---
  if [ "$ascii_forced" = "1" ] || [ "$term_ascii" = "1" ]; then
    glyphs="ascii"
  else
    loc=""
    if [ -n "${LC_ALL:-}" ]; then
      loc="$LC_ALL"
    elif [ -n "${LC_CTYPE:-}" ]; then
      loc="$LC_CTYPE"
    elif [ -n "${LANG:-}" ]; then
      loc="$LANG"
    fi
    if [ -z "$loc" ]; then
      glyphs="unicode"
    else
      loc_lc=$(printf '%s' "$loc" | tr '[:upper:]' '[:lower:]')
      case "$loc_lc" in
        *utf-8*|*utf8*)
          glyphs="unicode"
          ;;
        *)
          glyphs="ascii"
          ;;
      esac
    fi
  fi

  # --- mouse ---
  if [ "$mouse_forced_off" = "1" ] || [ "$term_mouse_off" = "1" ]; then
    mouse="off"
  else
    mouse="on"
  fi

  TUI_COLOR="$color"
  TUI_GLYPHS="$glyphs"
  TUI_MOUSE="$mouse"
}

# When executed directly (not sourced), print the one-line summary.
# ${BASH_SOURCE[0]:-} keeps this safe under `set -u` and when sourced from zsh.
if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  gotchibot_term_caps
  printf 'color=%s glyphs=%s mouse=%s\n' "${TUI_COLOR}" "${TUI_GLYPHS}" "${TUI_MOUSE}"
fi
