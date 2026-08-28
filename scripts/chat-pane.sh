#!/usr/bin/env bash
# Interactive OpenCode TUI — the GotchiBot chat pane.
# Scroll past responses: replay on by default (GOTCHIBOT_OPENCODE_REPLAY=1).
# Mouse wheel scrolls message history (OpenClaw: GOTCHIBOT_TUI_MOUSE=1; OpenCode: config/tui.json).
# Tab/F2 cycle agents in tmux (gotchi-chat key table). OpenCode native Tab also works in full TUI.
# Disable tmux Tab hook: GOTCHIBOT_TAB_TMUX=0. Mini mode: GOTCHIBOT_OPENCODE_MINI=1
# Fallback: `./scripts/gotchibot mode cycle --restart` | Ctrl+X A agent menu
# Copy: Shift+drag, or Ctrl+X Y; paste Ctrl+V.
# Disable OpenCode mouse: GOTCHIBOT_OPENCODE_MOUSE=0
# Full OpenCode TUI (not mini): GOTCHIBOT_OPENCODE_MINI=0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GOTCHIBOT_ROOT="$ROOT"
export PATH="${HOME}/.openclaw/bin:${PATH}"
# Persisted remote gateway (iMac) — sessions/.openclaw-gateway.json
# shellcheck source=/dev/null
[ -f "$ROOT/scripts/openclaw-gateway-env.sh" ] && source "$ROOT/scripts/openclaw-gateway-env.sh"
MODEL="${GOTCHIBOT_OPENCODE_MODEL:-opencode/hy3-free}"
MODE_FILE="$ROOT/sessions/.agent-mode.json"
if [ -n "${GOTCHIBOT_OPENCODE_AGENT:-}" ]; then
  AGENT="$GOTCHIBOT_OPENCODE_AGENT"
elif [ -f "$MODE_FILE" ] && command -v node >/dev/null; then
  AGENT="$(node "$ROOT/scripts/agent-mode.mjs" 2>/dev/null || echo gotchi)"
else
  AGENT="gotchi"
fi
MINI="${GOTCHIBOT_OPENCODE_MINI:-0}"
REPLAY="${GOTCHIBOT_OPENCODE_REPLAY:-1}"
REPLAY_LIMIT="${GOTCHIBOT_OPENCODE_REPLAY_LIMIT:-}"
export OPENCODE_TUI_CONFIG="${GOTCHIBOT_TUI_CONFIG:-$ROOT/config/tui.json}"
if [ "${GOTCHIBOT_OPENCODE_MOUSE:-1}" = "0" ]; then
  export OPENCODE_DISABLE_MOUSE=true
fi

cd "$ROOT"
# Sync persisted TTS preference into the chat pane environment.
if [ -f "$ROOT/sessions/.tts.json" ] && command -v node >/dev/null; then
  eval "$(node -e "
    const s=require('$ROOT/sessions/.tts.json');
    if(s.enabled) console.log('export GOTCHIBOT_TTS=on');
    if(s.persona) console.log('export GOTCHIBOT_TTS_PERSONA='+JSON.stringify(s.persona));
  " 2>/dev/null || true)"
fi
printf '\033[2J\033[H\033[3J' 2>/dev/null || clear 2>/dev/null || true

# Welcome / sign-in gate until onboarding is complete.
if [ "${GOTCHIBOT_SKIP_ONBOARDING:-}" != "1" ]; then
  if ! node "$ROOT/scripts/onboarding-lib.mjs" check 2>/dev/null; then
    if [ ! -t 0 ]; then
      echo "GotchiBot onboarding needs an interactive terminal." >&2
      echo "Attach tmux and select the center (Gotchi) pane: ./scripts/gotchibot tmux" >&2
      exit 1
    fi
    GOTCHIBOT_IN_CHAT_PANE=1 node "$ROOT/scripts/onboarding-gate.mjs" || exit 1
    # Refresh avatar pane after orchestrator pin.
    if [ -n "${TMUX:-}" ]; then
      pid="$(tmux display -p -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.2" '#{pane_pid}' 2>/dev/null || true)"
      [ -n "$pid" ] && kill -USR1 "$pid" 2>/dev/null || true
    fi
  fi
fi

# OpenClaw TUI via iMac (or local) gateway when reachable.
if [ "${GOTCHIBOT_CHAT_RUNTIME:-}" != "opencode" ] && [ "${GOTCHIBOT_OPENCLAW:-1}" != "0" ]; then
  if command -v openclaw >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    GW="${GOTCHIBOT_OPENCLAW_URL:-${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}}"
    WS="${GOTCHIBOT_OPENCLAW_WS:-${GW/http:/ws:}}"
    if curl -sf --max-time 3 "${GW%/}/healthz" >/dev/null 2>&1; then
      AGENT_ID="$(node "$ROOT/scripts/openclaw-fleet.mjs" tui-agent 2>/dev/null || echo owned-954)"
      ORCH_ID="$(node -e "
        try {
          const m=require('$ROOT/sessions/.openclaw-agent-map.json');
          process.stdout.write(String(m.orchestratorAgentId||'owned-954'));
        } catch { process.stdout.write('owned-954'); }
      " 2>/dev/null || echo owned-954)"
      SESSION="agent:${AGENT_ID}:main"
      # Gotchi chrome for patched OpenClaw TUI (Aavegotchi purple/pink, compact header/footer)
      export OPENCLAW_THEME="${GOTCHIBOT_OPENCLAW_THEME:-opencode}"
      export GOTCHIBOT_TUI_STYLE="${GOTCHIBOT_TUI_STYLE:-opencode}"
      export GOTCHIBOT_TUI_TITLE="${GOTCHIBOT_TUI_TITLE:-Gotchi}"
      # Scrollable chat history (mouse wheel + PageUp/PageDown); tmux mouse stays off.
      export GOTCHIBOT_TUI_SCROLL="${GOTCHIBOT_TUI_SCROLL:-1}"
      export GOTCHIBOT_TUI_MOUSE="${GOTCHIBOT_TUI_MOUSE:-1}"
      export GOTCHIBOT_TUI_SCROLL_SPEED="${GOTCHIBOT_TUI_SCROLL_SPEED:-4}"
      export GOTCHIBOT_TUI_COLLAPSE_SYSTEM="${GOTCHIBOT_TUI_COLLAPSE_SYSTEM:-1}"
      export GOTCHIBOT_TUI_PROSE_TTS="${GOTCHIBOT_TUI_PROSE_TTS:-1}"
      export GOTCHIBOT_TUI_LOAD_PROGRESS="${GOTCHIBOT_TUI_LOAD_PROGRESS:-1}"
      export GOTCHIBOT_TUI_PROMPT_LINES="${GOTCHIBOT_TUI_PROMPT_LINES:-5}"
      export COLORTERM="${COLORTERM:-truecolor}"
      TUI_ARGS=(tui --url "$WS" --session "$SESSION")
      if [ -n "${OPENCLAW_GATEWAY_TOKEN:-${GOTCHIBOT_OPENCLAW_TOKEN:-}}" ]; then
        TUI_ARGS+=(--token "${OPENCLAW_GATEWAY_TOKEN:-${GOTCHIBOT_OPENCLAW_TOKEN}}")
      fi
      if [ -n "${OPENCLAW_GATEWAY_PASSWORD:-${GOTCHIBOT_OPENCLAW_PASSWORD:-}}" ]; then
        TUI_ARGS+=(--password "${OPENCLAW_GATEWAY_PASSWORD:-${GOTCHIBOT_OPENCLAW_PASSWORD}}")
      fi
      if [ -n "${TMUX:-}" ]; then
        if [ "$AGENT_ID" = "$ORCH_ID" ]; then
          tmux set-option -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" pane-border-format " Gotchi (orch) " 2>/dev/null || true
        else
          tmux set-option -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" pane-border-format " ${AGENT_ID} (sub) " 2>/dev/null || true
        fi
      fi
      # GotchiBot slash commands: /orch /list /switch (patched OpenClaw TUI via openclaw-gotchi.sh)
      OPENCLAW_BIN="$ROOT/scripts/openclaw-gotchi.sh"
      if [ ! -x "$OPENCLAW_BIN" ]; then
        OPENCLAW_BIN=openclaw
      fi
      if [ -z "${NVIDIA_API_KEY:-}${OPENROUTER_API_KEY:-}${DEEPSEEK_API_KEY:-}" ] \
        && [ "${GOTCHIBOT_SKIP_ABRA:-}" != "1" ] \
        && command -v abra >/dev/null 2>&1; then
        exec abra run gotchibot -- "$OPENCLAW_BIN" "${TUI_ARGS[@]}"
      fi
      exec "$OPENCLAW_BIN" "${TUI_ARGS[@]}"
    fi
  fi
fi

args=(--agent "$AGENT" -m "$MODEL")
# Replay keeps prior turns visible + scrollable in mini mode (do not pass --no-replay).
if [ "$REPLAY" != "1" ]; then
  args+=(--no-replay)
fi
if [ -n "$REPLAY_LIMIT" ]; then
  args+=(--replay-limit "$REPLAY_LIMIT")
fi
[ "$MINI" = 1 ] && args=(--mini "${args[@]}")

# Pane title reflects primary agent (gotchi | ask | plan | build).
if [ -n "${TMUX:-}" ]; then
  case "$AGENT" in
    ask) border=" Ask " ;;
    plan) border=" Plan " ;;
    build) border=" Build " ;;
    *) border=" Gotchi " ;;
  esac
  tmux set-option -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" pane-border-format "$border" 2>/dev/null || true
  "$ROOT/scripts/tmux-chat-focus-hook.sh" 2>/dev/null || true
fi

# Inject NVIDIA/OpenRouter/etc via abracadabra when keys aren't already in env.
# Without this, NIM models fail with "Missing Authentication header".
if [ -z "${NVIDIA_API_KEY:-}${OPENROUTER_API_KEY:-}${DEEPSEEK_API_KEY:-}" ] \
  && [ "${GOTCHIBOT_SKIP_ABRA:-}" != "1" ] \
  && command -v abra >/dev/null 2>&1; then
  exec abra run gotchibot -- opencode "${args[@]}" "$ROOT"
fi

exec opencode "${args[@]}" "$ROOT"
