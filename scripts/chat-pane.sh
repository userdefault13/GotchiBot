#!/usr/bin/env bash
# Interactive OpenCode TUI — the GotchiBot chat pane (native OpenCode UX).
# Gotchi mode (default): agent=gotchi orchestrates via OpenClaw spawn/relay env;
# OpenCode TUI stays on a local model (openclaw/* as -m hangs when relay stalls).
# Ask/plan/build/sub/verse stay local OpenCode agents (no OpenClaw relay).
# Legacy OpenClaw native TUI: GOTCHIBOT_OPENCLAW_TUI=1
# Scroll past responses: replay on by default (GOTCHIBOT_OPENCODE_REPLAY=1).
# Mouse wheel scrolls message history (OpenClaw: GOTCHIBOT_TUI_MOUSE=1; OpenCode: config/tui.json).
# Tab/F2 cycle agents in tmux (gotchi-chat key table). OpenCode native Tab also works in full TUI.
# Disable tmux Tab hook: GOTCHIBOT_TAB_TMUX=0. Mini mode: GOTCHIBOT_OPENCODE_MINI=1
# Fallback: `./scripts/gotchibot mode cycle --restart` | Ctrl+X A agent menu
# Copy: /copy or Ctrl+Y (last assistant reply → clipboard). Shift+drag selects text in terminal.
# Disable OpenCode mouse: GOTCHIBOT_OPENCODE_MOUSE=0
# Full OpenCode TUI (not mini): GOTCHIBOT_OPENCODE_MINI=0
# Resume last session: GOTCHIBOT_OPENCODE_CONTINUE=1 (default). Fresh chat: =0
# Pin a session: GOTCHIBOT_OPENCODE_SESSION=ses_…
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GOTCHIBOT_ROOT="$ROOT"
export PATH="${HOME}/.openclaw/bin:${PATH}"
# Persisted remote gateway (iMac) — sessions/.openclaw-gateway.json
# shellcheck source=/dev/null
[ -f "$ROOT/scripts/openclaw-gateway-env.sh" ] && source "$ROOT/scripts/openclaw-gateway-env.sh"
# Keep OpenCode Go catalog registered so /models shows the OpenCode Go group.
node "$ROOT/scripts/sync-opencode-go-provider.mjs" >/dev/null 2>&1 || true
if [ -z "${GOTCHIBOT_OPENCODE_MODEL:-}" ]; then
  MODEL="$(node "$ROOT/scripts/model-auto.mjs" pick 2>/dev/null || echo opencode-go/kimi-k3)"
  export GOTCHIBOT_OPENCODE_MODEL="$MODEL"
else
  MODEL="$GOTCHIBOT_OPENCODE_MODEL"
fi
# Prefer OpenCode Go over Zen when OPENCODE_API_KEY is present.
if command -v node >/dev/null 2>&1; then
  eval "$(node "$ROOT/scripts/model-go-guard.mjs" env "$MODEL" 2>/dev/null)" || true
  MODEL="${GOTCHIBOT_OPENCODE_MODEL:-$MODEL}"
fi
mkdir -p "$ROOT/sessions"
# Cockpit Settings → sessions/.tui-prefs.json (do not override explicit env).
if [ -f "$ROOT/sessions/.tui-prefs.json" ] && command -v node >/dev/null; then
  eval "$(node -e "
    const s=require('$ROOT/sessions/.tui-prefs.json');
    if (!process.env.GOTCHIBOT_OPENCODE_MOUSE && s.mouse != null)
      console.log('export GOTCHIBOT_OPENCODE_MOUSE=' + (s.mouse ? '1' : '0'));
    if (!process.env.GOTCHIBOT_OPENCODE_REPLAY && s.replay != null)
      console.log('export GOTCHIBOT_OPENCODE_REPLAY=' + (s.replay ? '1' : '0'));
  " 2>/dev/null || true)"
fi
printf "%s\n" "$MODEL" > "$ROOT/sessions/.chat-model"
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

refresh_avatar_pane() {
  if [ -n "${TMUX:-}" ]; then
    local pid
    pid="$(tmux display -p -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.2" '#{pane_pid}' 2>/dev/null || true)"
    [ -n "$pid" ] && kill -USR1 "$pid" 2>/dev/null || true
  fi
}

poke_meet_channel_pane() {
  if [ -n "${TMUX:-}" ]; then
    local pid
    pid="$(tmux display -p -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.2" '#{pane_pid}' 2>/dev/null || true)"
    [ -n "$pid" ] && kill -USR1 "$pid" 2>/dev/null || true
  fi
}

onboarding_complete() {
  node "$ROOT/scripts/onboarding-lib.mjs" check 2>/dev/null
}

quit_to_terminal() {
  # Exit this pane only — never kill the whole gotchibot session (that left Julius
  # with a dead desk whenever OpenCode/abra exited).
  exit 0
}

run_onboarding_gate() {
  set +e
  GOTCHIBOT_IN_CHAT_PANE=1 node "$ROOT/scripts/onboarding-gate.mjs" "$@"
  local st=$?
  set -e
  if [ "$st" -eq 2 ]; then
    quit_to_terminal
  fi
  # 4 = cockpit finished meet setup; caller switches to meet room layout.
  if [ "$st" -eq 4 ]; then
    return 4
  fi
  if [ "$st" -ne 0 ]; then
    exit "$st"
  fi
  return 0
}

enter_meet_room() {
  export GOTCHIBOT_SKIP_COCKPIT=1
  export GOTCHIBOT_SKIP_ONBOARDING=1
  if [ -n "${TMUX:-}" ]; then
    local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
    tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess\" \"$ROOT/scripts/orchestrator-layout.sh\" enter-meet-gallery" || {
      echo "gotchibot: meet layout failed (window too small?)" >&2
    }
    # If layout respawned work.1 we never reach here; otherwise start room in-place.
    exec "$ROOT/scripts/meet-room-pane.sh"
  fi
  exec "$ROOT/scripts/meet-room-pane.sh"
}

show_cockpit() {
  if [ ! -t 0 ]; then
    echo "GotchiBot cockpit needs an interactive terminal." >&2
    exit 1
  fi
  set +e
  run_onboarding_gate --cockpit
  local st=$?
  set -e
  refresh_avatar_pane
  if [ "$st" -eq 4 ]; then
    enter_meet_room
  elif [ "$st" -ne 0 ]; then
    exit "$st"
  fi
  ensure_desk_after_cockpit
}

# If cockpit/meet left a broken 1-pane window, rebuild via tmux server then exit so
# the respawned chat-pane continues (do not launch OpenCode full-bleed on Files).
ensure_desk_after_cockpit() {
  [ -n "${TMUX:-}" ] || return 0
  local sess="${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
  local count c1 c2
  count="$(tmux list-panes -t "$sess:work" 2>/dev/null | wc -l | tr -d ' ')"
  c1="$(tmux display -p -t "$sess:work.1" '#{pane_start_command}' 2>/dev/null || true)"
  c2="$(tmux display -p -t "$sess:work.2" '#{pane_start_command}' 2>/dev/null || true)"
  if [ "${count:-0}" -eq 3 ] && [[ "$c1" == *chat-pane* ]] && [[ "$c2" == *avatar-pane* ]]; then
    return 0
  fi
  # Meet gallery is a valid 3-pane state — do not force desk refresh over it.
  if [ "${count:-0}" -eq 3 ] && [[ "$c1" == *meet-room* ]] && [[ "$c2" == *meet-channel* ]]; then
    return 0
  fi
  tmux run-shell "cd \"$ROOT\" && GOTCHIBOT_LAYOUT_SAFE=1 GOTCHIBOT_TMUX_SESSION=\"$sess\" \"$ROOT/scripts/orchestrator-layout.sh\" refresh"
  exit 0
}

# /cockpit — mint cAavegotchi · change orchestrator avatar (in chat pane).
if [ "${GOTCHIBOT_COCKPIT:-}" = "1" ]; then
  show_cockpit
  export GOTCHIBOT_SKIP_COCKPIT=1
fi

show_meet() {
  if [ ! -t 0 ]; then
    echo "GotchiBot meeting room needs an interactive terminal." >&2
    exit 1
  fi
  set +e
  run_onboarding_gate --meet
  local st=$?
  set -e
  if [ "$st" -eq 4 ]; then
    enter_meet_room
  elif [ "$st" -ne 0 ]; then
    exit "$st"
  fi
}

# /meet — shared meeting room (setup in chat pane, then meet room UI).
if [ "${GOTCHIBOT_MEET:-}" = "1" ]; then
  show_meet
fi

# Welcome / sign-in gate until onboarding is complete.
if [ "${GOTCHIBOT_SKIP_ONBOARDING:-}" != "1" ]; then
  if ! onboarding_complete; then
    if [ ! -t 0 ]; then
      echo "GotchiBot onboarding needs an interactive terminal." >&2
      echo "Attach tmux and select the center (Gotchi) pane: ./scripts/gotchibot tmux" >&2
      exit 1
    fi
    run_onboarding_gate
    export GOTCHIBOT_SKIP_COCKPIT=1
    refresh_avatar_pane
  fi
fi

# Default: open cockpit menu before chat when onboarding is already complete.
if [ "${GOTCHIBOT_SKIP_COCKPIT:-}" != "1" ] && [ -t 0 ] && onboarding_complete; then
  show_cockpit
fi

# Chat runtime: opencode (default) or openclaw TUI.
RUNTIME_FILE="$ROOT/sessions/.chat-runtime"
if [ -z "${GOTCHIBOT_CHAT_RUNTIME:-}" ] && [ -f "$RUNTIME_FILE" ]; then
  GOTCHIBOT_CHAT_RUNTIME="$(tr -d "[:space:]" < "$RUNTIME_FILE")"
fi
export GOTCHIBOT_CHAT_RUNTIME="${GOTCHIBOT_CHAT_RUNTIME:-opencode}"

# Legacy OpenClaw pi-tui (patched) — opt-in only.
if [ "${GOTCHIBOT_CHAT_RUNTIME}" != "opencode" ] && [ "${GOTCHIBOT_OPENCLAW_TUI:-0}" = "1" ] && [ "${GOTCHIBOT_OPENCLAW:-1}" != "0" ]; then
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
      # GotchiBot slash commands: /orch /list /switch /cockpit (patched OpenClaw TUI via openclaw-gotchi.sh)
      OPENCLAW_BIN="$ROOT/scripts/openclaw-gotchi.sh"
      if [ ! -x "$OPENCLAW_BIN" ]; then
        OPENCLAW_BIN=openclaw
      fi
      if [ -z "${NVIDIA_API_KEY:-}${OPENROUTER_API_KEY:-}${DEEPSEEK_API_KEY:-}${OPENCODE_API_KEY:-}${OPENCODE_ZEN_API_KEY:-}" ] \
        && [ "${GOTCHIBOT_SKIP_ABRA:-}" != "1" ] \
        && command -v abra >/dev/null 2>&1; then
        if abra run gotchibot -- "$OPENCLAW_BIN" "${TUI_ARGS[@]}"; then
          quit_to_terminal
        fi
        echo "gotchibot: abra inject failed — launching OpenClaw TUI without vault keys" >&2
      fi
      "$OPENCLAW_BIN" "${TUI_ARGS[@]}" || true
      quit_to_terminal
    fi
  fi
fi

# Resolve model/backend: OpenClaw swarm orchestration is reserved for gotchi mode.
# Build / ask / plan / sub / verse always use a local OpenCode agent + model.
# Gotchi keeps a local OpenCode TUI model (stable); OpenClaw env is for spawn/relay,
# not as OpenCode's -m (openclaw/orchestrator hangs the desk when the relay stalls).
if [ "$AGENT" = "gotchi" ] && command -v node >/dev/null 2>&1; then
  eval "$(node "$ROOT/scripts/opencode-gotchi-mode.mjs" env 2>/dev/null)" || true
  if [ -n "${GOTCHIBOT_GOTCHI_MODEL:-}" ]; then
    MODEL="$GOTCHIBOT_GOTCHI_MODEL"
  else
    MODEL="${GOTCHIBOT_OPENCODE_MODEL:-opencode/nemotron-3.5-lightning-free}"
  fi
  # Never boot the TUI on openclaw/* — that path times out and suicides the session.
  case "$MODEL" in
    openclaw/*) MODEL="${GOTCHIBOT_OPENCODE_MODEL:-opencode-go/kimi-k3}" ;;
  esac
  if [ "${GOTCHIBOT_GOTCHI_BACKEND:-}" = "openclaw-gateway" ] && [ -n "${TMUX:-}" ]; then
    tmux set-option -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" pane-border-format " Gotchi (OpenClaw) " 2>/dev/null || true
  fi
else
  unset GOTCHIBOT_GOTCHI_BACKEND GOTCHIBOT_GOTCHI_MODEL GOTCHIBOT_GOTCHI_RELAY \
    GOTCHIBOT_OPENCLAW_HTTP_V1 GOTCHIBOT_OPENCLAW_SESSION_KEY GOTCHIBOT_OPENCLAW_ORCH_ID \
    GOTCHIBOT_OPENCLAW_OPENCODE_MODEL
  export GOTCHIBOT_GOTCHI_BACKEND=local
  # Strip any sticky OpenClaw model from a prior gotchi session / continue.
  case "$MODEL" in
    openclaw/*)
      MODEL="$(node "$ROOT/scripts/model-auto.mjs" pick 2>/dev/null || true)"
      if [[ "$MODEL" == *"\"model\""* ]]; then
        MODEL="$(node -e "try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.model||'')}catch{process.stdout.write('')}" "$MODEL")"
      fi
      MODEL="${MODEL:-opencode/nemotron-3.5-lightning-free}"
      ;;
  esac
fi

args=(--agent "$AGENT" -m "$MODEL")
# Resume last OpenCode session (`opencode --continue`). Fresh: GOTCHIBOT_OPENCODE_CONTINUE=0
# Pin a session: GOTCHIBOT_OPENCODE_SESSION=<id>
# Non-gotchi: fresh session so build/ask/plan do not resume a gotchi transcript.
if [ -n "${GOTCHIBOT_OPENCODE_SESSION:-}" ]; then
  args+=(--session "$GOTCHIBOT_OPENCODE_SESSION")
elif [ "$AGENT" != "gotchi" ]; then
  :
elif [ "${GOTCHIBOT_OPENCODE_CONTINUE:-1}" = "1" ]; then
  args+=(--continue)
fi
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
  if [ "$AGENT" = "gotchi" ] && [ "${GOTCHIBOT_GOTCHI_BACKEND:-}" = "openclaw-gateway" ]; then
    border=" Gotchi (OpenClaw) "
  fi
  tmux set-option -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" pane-border-format "$border" 2>/dev/null || true
  "$ROOT/scripts/tmux-chat-focus-hook.sh" 2>/dev/null || true
fi

# Inject NVIDIA/OpenRouter/etc via abracadabra when keys aren't already in env.
# Without this, NIM models fail with "Missing Authentication header".
# If abra fails (keychain / no GUI), fall through to bare opencode — never
# kill the tmux session before the TUI has actually started.
if [ -z "${NVIDIA_API_KEY:-}${OPENROUTER_API_KEY:-}${DEEPSEEK_API_KEY:-}${OPENCODE_API_KEY:-}${OPENCODE_ZEN_API_KEY:-}" ] \
  && [ "${GOTCHIBOT_SKIP_ABRA:-}" != "1" ] \
  && command -v abra >/dev/null 2>&1; then
  if abra run gotchibot -- opencode "${args[@]}" "$ROOT"; then
    quit_to_terminal
  fi
  echo "gotchibot: abra inject failed — launching opencode without vault keys" >&2
fi

opencode "${args[@]}" "$ROOT" || true
quit_to_terminal
