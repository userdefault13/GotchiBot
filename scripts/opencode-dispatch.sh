#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

standing_status() {
  local t="$1"
  if echo "$t" | grep -Eiq '(cron|crontab|monitor|watch|watching|watcher|schedul|standing|trader|loop|daily|hourly)'; then
    echo assigned
  else
    echo working
  fi
}

SESSIONS="$ROOT/sessions"
PROGRESS="$ROOT/scripts/progress-bar.sh"
mkdir -p "$SESSIONS"

usage() {
  cat >&2 <<'EOF'
usage:
  opencode-dispatch.sh new [--model auto|flash|pro|local|<provider/model>] "PROMPT"
  opencode-dispatch.sh list
  opencode-dispatch.sh status <id>...
  opencode-dispatch.sh wait [<id>...]
  opencode-dispatch.sh output <id>
  opencode-dispatch.sh requests   show pending skill requests
EOF
  exit 2
}


dispatch_runtime() {
  if [ -n "${GOTCHIBOT_DISPATCH:-}" ]; then
    echo "$GOTCHIBOT_DISPATCH"
    return
  fi
  if [ "${GOTCHIBOT_CHAT_RUNTIME:-}" = "claude" ]; then
    echo claude
    return
  fi
  if [ -f "$SESSIONS/.chat-runtime" ]; then
    local r
    r="$(tr -d '[:space:]' < "$SESSIONS/.chat-runtime")"
    [ "$r" = "claude" ] && echo claude && return
  fi
  echo opencode
}

claude_model_for() {
  case "$1" in
    auto|free|nim|flash|sonnet|"") echo sonnet ;;
    pro|opus|ultra) echo opus ;;
    local) echo sonnet ;;
    *) echo "$1" ;;
  esac
}

model_for() {
  case "$1" in
    auto|free) node "$ROOT/scripts/model-auto.mjs" pick ;;
    nim) echo "opencode/hy3-free" ;;
    ultra) echo "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" ;;
    # OpenCode Zen lightning-free currently 404s; prefer NIM when key present.
    lightning)
      if [ -n "${NVIDIA_API_KEY:-}" ]; then
        echo "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b"
      else
        echo "opencode/hy3-free"
      fi
      ;;
    flash) echo "deepseek/deepseek-v4-flash" ;;
    pro) echo "deepseek/deepseek-v4-pro" ;;
    local) echo "ollama/qwen2.5:3b" ;;
    *) echo "$1" ;;
  esac
}

field() {
  grep -E "^${1}=" "$2/state.env" | head -1 | cut -d= -f2-
}

set_field() {
  local dir="$1" key="$2" val="$3" tmp
  tmp="$dir/.state.tmp.$$"
  { grep -vE "^${key}=" "$dir/state.env" || true; echo "${key}=${val}"; } > "$tmp"
  mv "$tmp" "$dir/state.env"
}

spawn() {
  local model="free" prompt id dir runner
  # shellcheck source=scripts/progress-bar.sh
  source "$PROGRESS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) model="$2"; shift 2 ;;
      *) prompt="${1:-}"; shift ;;
    esac
  done
  [ -n "${prompt:-}" ] || usage

  if [ "${GOTCHIBOT_SKIP_GATE:-}" != "1" ]; then
    if ! node "$ROOT/scripts/wallet-gate.mjs" >/dev/null 2>&1; then
      node "$ROOT/scripts/wallet-gate.mjs" >&2 || true
      exit 12
    fi
  fi

  progress_pulse "spawning sub-agent…" 0; progress_end

  id="s$(date +%Y%m%d-%H%M%S)-$$"
  dir="$SESSIONS/$id"
  mkdir -p "$dir"

  printf '%s\n' "$prompt" > "$dir/prompt.txt"

  {
    RUNTIME="$(dispatch_runtime)"
    if [ "$RUNTIME" = "claude" ]; then
      echo "model=$(claude_model_for "$model")"
    else
      echo "model=$(model_for "$model")"
    fi
    echo "tier=$model"
    echo "runtime=$RUNTIME"
    echo "status=running"
    echo "started=$(date -u +%FT%TZ)"
    echo "pid="
  } > "$dir/state.env"

  cat > "$dir/bootstrap.txt" <<EOF

--- session bootstrap ---
You are this cAavegotchi, session $id in the GotchiBot swarm. Speak in first person (I, me, my). You are not the orchestrator and you do not narrate yourself in the third person.
Session dir: $dir
Write your deliverable to $dir/output.md.
You exist because the cartridge has a cAavegotchi — sub-agents cannot spawn without one.
If you need a skill not in skills/registry.json, append a JSON request to
$dir/skill-requests.jsonl and continue without it. Never install anything.
Never handle secrets directly; ask the orchestrator to fetch them via abracadabra.
EOF

  if [ -n "${AARCADE_GOTCHIBOT_SERVICE_SECRET:-}" ]; then
    # Optional: GOTCHIBOT_HERO_ID pins an existing cAavegotchi (e.g. starter-link-h1-1)
    if [ -n "${GOTCHIBOT_HERO_ID:-}" ]; then
      hero="$(node "$ROOT/scripts/identity.mjs" bind --session "$id" --hero "$GOTCHIBOT_HERO_ID" 2>/dev/null | tail -1)" || hero=""
    else
      hero="$(node "$ROOT/scripts/identity.mjs" bind --session "$id" 2>/dev/null | tail -1)" || hero=""
    fi
    if [ -n "$hero" ]; then
      set_field "$dir" hero "$hero"
      echo "Your gotchi identity: $hero" >> "$dir/bootstrap.txt"
      # Sim: standing/cron → assigned, else active
      TASK_HINT="$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')"
      BIND_ST="$(standing_status "$TASK_HINT")"
      [ "$BIND_ST" = working ] && BIND_ST=active
      node "$ROOT/scripts/hero-agent-state.mjs" set "$hero" "$BIND_ST" \
        --session "$id" --task "$TASK_HINT" \
        --model "$(model_for "$model")" --host local >/dev/null 2>&1 || true
      "$ROOT/scripts/poke-avatar.sh" >/dev/null 2>&1 || true
    fi
  fi

  runner="$dir/runner.sh"
  RUNTIME="$(dispatch_runtime)"
  if [ "$RUNTIME" = "claude" ]; then
    CLAUDE_MODEL="$(claude_model_for "$model")"
    cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT"
PROMPT="\$(cat "$dir/prompt.txt")\$(cat "$dir/bootstrap.txt")"
MODEL="$CLAUDE_MODEL"
HERO="\$(grep -E '^hero=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "\$HERO" ]; then
  ST="$(standing_status "$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')")"
  node "$ROOT/scripts/hero-agent-state.mjs" set "\$HERO" "\$ST" \\
    --session "$id" --task "\$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')" \\
    --model "\$MODEL" --host local >/dev/null 2>&1 || true
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not on PATH" >> "$dir/output.log"
  exit 127
fi
PERM="\${GOTCHIBOT_CLAUDE_PERMISSION:-acceptEdits}"
IDE_FLAGS=()
if [ "\${GOTCHIBOT_CLAUDE_IDE:-1}" != "0" ]; then
  IDE_FLAGS+=(--ide)
fi
claude -p --output-format text --permission-mode "\$PERM" --model "\$MODEL" -n "gotchibot:$id" "\${IDE_FLAGS[@]}" -- "\$PROMPT" \\
  > "$dir/output.md" 2> "$dir/output.log"
exit \$?
RUNNER
  else
  cat > "$runner" <<RUNNER
#!/usr/bin/env bash
cd "$ROOT"
PROMPT="\$(cat "$dir/prompt.txt")\$(cat "$dir/bootstrap.txt")"
MODEL="$(model_for "$model")"
FREE_MODEL="\$(node "$ROOT/scripts/model-fallback.mjs" free-model 2>/dev/null || echo opencode/hy3-free)"
HERO="\$(grep -E '^hero=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "\$HERO" ]; then
  ST="$(standing_status "$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')")"
      node "$ROOT/scripts/hero-agent-state.mjs" set "\$HERO" "\$ST" \
    --session "$id" --task "\$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')" \
    --model "\$MODEL" --host local >/dev/null 2>&1 || true
fi
AUTO_FLAGS=()
if [ "\${GOTCHIBOT_AUTO_APPROVE:-1}" = "1" ]; then
  AUTO_FLAGS+=(--auto)
fi
run_opencode() {
  local m="\$1"
  if [ "\${GOTCHIBOT_SKIP_ABRA:-}" = "1" ] || [ -n "\${NVIDIA_API_KEY:-}\${OPENROUTER_API_KEY:-}\${DEEPSEEK_API_KEY:-}" ]; then
    opencode run -m "\$m" --title "gotchibot:$id" --dir "$ROOT" "\${AUTO_FLAGS[@]}" "\$PROMPT" \
      > "$dir/output.md" 2> "$dir/output.log"
  elif command -v abra >/dev/null 2>&1; then
    abra run gotchibot -- opencode run -m "\$m" --title "gotchibot:$id" --dir "$ROOT" "\${AUTO_FLAGS[@]}" "\$PROMPT" \
      > "$dir/output.md" 2> "$dir/output.log"
  else
    opencode run -m "\$m" --title "gotchibot:$id" --dir "$ROOT" "\${AUTO_FLAGS[@]}" "\$PROMPT" \
      > "$dir/output.md" 2> "$dir/output.log"
  fi
}
run_opencode "\$MODEL"
ec=\$?
if [ \$ec -ne 0 ] && [ "\$MODEL" != "\$FREE_MODEL" ] && node "$ROOT/scripts/model-fallback.mjs" check-log "$dir/output.log" "$dir/output.md"; then
  echo "[gotchibot] model limit hit — retrying with \$FREE_MODEL" >> "$dir/output.log"
  MODEL="\$FREE_MODEL"
  { grep -vE '^model=' "$dir/state.env"; echo "model=\$FREE_MODEL"; } > "$dir/.state.tmp"
  mv "$dir/.state.tmp" "$dir/state.env"
  if [ -n "\$HERO" ]; then
        node "$ROOT/scripts/hero-agent-state.mjs" set "\$HERO" "\$ST" \
      --session "$id" --task "\$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')" \
      --model "\$FREE_MODEL" --host local >/dev/null 2>&1 || true
  fi
  run_opencode "\$FREE_MODEL"
  ec=\$?
fi
exit \$ec
RUNNER
  fi
  chmod +x "$runner"

  ( if "$runner"; then set_field "$dir" status done
      HERO="$(grep -E '^hero=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
      if [ -n "$HERO" ]; then
        END_ST="$(standing_status "$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')")"
        [ "$END_ST" = working ] && END_ST=available
        node "$ROOT/scripts/hero-agent-state.mjs" set "$HERO" "$END_ST" --host local >/dev/null 2>&1 || true
      fi
      "$ROOT/scripts/poke-avatar.sh" >/dev/null 2>&1 || true
      GOTCHIBOT_TTS_PERSONA=sub "$ROOT/scripts/tts.sh" "Sub agent $id finished."
    else set_field "$dir" status failed
      HERO="$(grep -E '^hero=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
      if [ -n "$HERO" ]; then
        END_ST="$(standing_status "$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')")"
        [ "$END_ST" = working ] && END_ST=available
        node "$ROOT/scripts/hero-agent-state.mjs" set "$HERO" "$END_ST" --host local >/dev/null 2>&1 || true
      fi
      "$ROOT/scripts/poke-avatar.sh" >/dev/null 2>&1 || true
      GOTCHIBOT_TTS_PERSONA=sub "$ROOT/scripts/tts.sh" "Sub agent $id failed."
    fi
    set_field "$dir" ended "$(date -u +%FT%TZ)" ) >/dev/null 2>&1 </dev/null &
  echo $! > "$dir/pid"
  set_field "$dir" pid "$!"
  echo "$id"
}

cmd_list() {
  local cols="${GOTCHIBOT_LIST_COLS:-$(tput cols 2>/dev/null || echo 80)}"
  if [ "$cols" -lt 70 ]; then
    printf '%-18s %-8s\n' ID STATUS
    for d in "$SESSIONS"/s*/; do
      [ -f "$d/state.env" ] || continue
      local id status
      id="$(basename "$d")"
      status="$(field status "$d" || echo '?')"
      printf '%-18s %-8s\n' "$id" "$status"
    done
    return
  fi
  printf '%-24s %-8s %-32s %s\n' ID STATUS MODEL STARTED
  for d in "$SESSIONS"/s*/; do
    [ -f "$d/state.env" ] || continue
    local id status model started
    id="$(basename "$d")"
    status="$(field status "$d" || echo '?')"
    model="$(field model "$d" || echo '?')"
    started="$(field started "$d" || echo '?')"
    printf '%-24s %-8s %-32s %s\n' "$id" "$status" "$model" "$started"
  done
}

cmd_status() {
  for id in "$@"; do
    d="$SESSIONS/$id"
    [ -f "$d/state.env" ] || { echo "unknown session: $id" >&2; exit 1; }
    sed 's/^/  /' "$d/state.env"
  done
}

cmd_wait() {
  # shellcheck source=scripts/progress-bar.sh
  source "$PROGRESS"
  if [ $# -eq 0 ]; then
    set -- $(for d in "$SESSIONS"/s*/state.env; do
      grep -q '^status=running' "$d" 2>/dev/null && basename "$(dirname "$d")"
    done)
    [ $# -gt 0 ] || return 0
  fi
  for id in "$@"; do
    progress_wait_session "$id" "$ROOT"
  done
}

cmd_output() {
  [ -f "$SESSIONS/$1/output.md" ] || { echo "no output yet: $1" >&2; exit 1; }
  cat "$SESSIONS/$1/output.md"
}

cmd_requests() {
  found=0
  for f in "$SESSIONS"/s*/skill-requests.jsonl; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "$(basename "$(dirname "$f")"): $line"
      found=1
    done < "$f"
  done
  [ "$found" -eq 1 ] || echo "no skill requests"
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  new) spawn "$@" ;;
  list) cmd_list ;;
  status) [ $# -ge 1 ] || usage; cmd_status "$@" ;;
  wait) cmd_wait "$@" ;;
  output) [ $# -eq 1 ] || usage; cmd_output "$1" ;;
  requests) cmd_requests ;;
  *) usage ;;
esac
