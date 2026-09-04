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
  opencode-dispatch.sh new [--model auto|flash|pro|local|<provider/model>] [--sandbox] "PROMPT"
  opencode-dispatch.sh list
  opencode-dispatch.sh status <id>...
  opencode-dispatch.sh wait [<id>...]
  opencode-dispatch.sh output <id>
  opencode-dispatch.sh export [<id>] [--out PATH] [--log] [--yes]
                              save a session transcript as Markdown
                              (prompts for a folder; ~/Downloads by default)
  opencode-dispatch.sh requests   show pending skill requests

Sandbox (GOTCHIBOT_SANDBOX=1 or --sandbox): Docker box; cwd /work; abra only in-box via ABRA_KEY.
EOF
  exit 2
}


dispatch_runtime() {
  echo opencode
}

model_for() {
  case "$1" in
    auto|free) node "$ROOT/scripts/model-auto.mjs" pick ;;
    nim) echo "opencode/big-pickle" ;;
    pickle) echo "opencode/big-pickle" ;;
    ultra) echo "opencode/nemotron-3-ultra-free" ;;
    # Prefer NIM when key present; else OpenCode Zen free (big-pickle).
    lightning)
      if [ -n "${NVIDIA_API_KEY:-}" ]; then
        echo "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b"
      else
        echo "opencode/nemotron-3.5-lightning-free"
      fi
      ;;
    flash) echo "deepseek/deepseek-v4-flash" ;;
    pro) echo "deepseek/deepseek-v4-pro" ;;
    local) echo "ollama/qwen2.5:3b" ;;
    sub) node "$ROOT/scripts/model-auto.mjs" subagent ;;
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
  local model="free" prompt id dir runner sandbox=0
  # shellcheck source=scripts/progress-bar.sh
  source "$PROGRESS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) model="$2"; shift 2 ;;
      --sandbox) sandbox=1; shift ;;
      *) prompt="${1:-}"; shift ;;
    esac
  done
  [ -n "${prompt:-}" ] || usage
  if [ "${GOTCHIBOT_SANDBOX:-}" = "1" ]; then sandbox=1; fi

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
    echo "model=$(model_for "$model")"
    echo "tier=$model"
    echo "runtime=$RUNTIME"
    echo "status=running"
    echo "started=$(date -u +%FT%TZ)"
    echo "pid="
    echo "sandbox=$sandbox"
  } > "$dir/state.env"

  if [ "$sandbox" = "1" ]; then
    cat > "$dir/bootstrap.txt" <<EOF

--- session bootstrap (DOCKER SANDBOX) ---
You are this cAavegotchi, session $id in an isolated GotchiBot sandbox container.
Speak in first person (I, me, my). You are not the orchestrator.
Work ONLY under /work. Session files are under /session.
Write your deliverable to /session/output.md.
Do NOT touch host ~/Dev, GotchiBot source, or docker.sock — they are not mounted.
Secrets: use sandbox-abra-fetch / ABRA_KEY → host.docker.internal:7331 only. Never abra run. Never print secrets.
Do NOT call cursor-cli / cursor-agent (host escape). Coding = opencode in this container.
Never mint / bind / steal assigned desks. Never install tools on the host.
If you need a skill not in /rules/skills-registry.json, append JSON to /session/skill-requests.jsonl.
EOF
  else
    cat > "$dir/bootstrap.txt" <<EOF

--- session bootstrap ---
You are this cAavegotchi, session $id in the GotchiBot swarm. Speak in first person (I, me, my). You are not the orchestrator and you do not narrate yourself in the third person.
Session dir: $dir
Write your deliverable to $dir/output.md.
You exist because the cartridge has a cAavegotchi — sub-agents cannot spawn without one.
If you need a skill not in skills/registry.json, append a JSON request to
$dir/skill-requests.jsonl and continue without it. Never install anything.
Never call abra / abracadabra on the host. Secrets belong in Docker sandbox jobs only.
EOF
  fi

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

  if [ "$sandbox" = "1" ]; then
    if ! node "$ROOT/scripts/sandbox.mjs" up "$id"; then
      echo "sandbox up failed" >&2
      set_field "$dir" status failed
      exit 1
    fi
    set_field "$dir" sandboxContainer "gotchibot-sandbox-$id"
  fi

  runner="$dir/runner.sh"
  RUNTIME="$(dispatch_runtime)"
  if [ "$sandbox" = "1" ]; then
    cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
PROMPT="\$(cat "$dir/prompt.txt")\$(cat "$dir/bootstrap.txt")"
MODEL="$(model_for "$model")"
FREE_MODEL="\$(node "$ROOT/scripts/model-fallback.mjs" free-model 2>/dev/null || echo opencode/big-pickle)"
HERO="\$(grep -E '^hero=' "$dir/state.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
CTN="gotchibot-sandbox-$id"
ST="$(standing_status "$(head -c 200 "$dir/prompt.txt" | tr '\n' ' ')")"
if [ -n "\$HERO" ]; then
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
  # Abra is sandbox-only: secrets already injected as env into the container.
  # Never abra run / cursor-cli on the host from this path.
  docker exec -w /work \
    -e GOTCHIBOT_SANDBOX=1 \
    -e GOTCHIBOT_SKIP_ABRA=1 \
    "\$CTN" \
    opencode run -m "\$m" --title "gotchibot:$id" --dir /work "\${AUTO_FLAGS[@]}" "\$PROMPT" \
    > "$dir/output.md" 2> "$dir/output.log"
}
run_opencode "\$MODEL"
ec=\$?
if [ \$ec -ne 0 ] && [ "\$MODEL" != "\$FREE_MODEL" ] && node "$ROOT/scripts/model-fallback.mjs" check-log "$dir/output.log" "$dir/output.md"; then
  echo "[gotchibot] model limit hit — retrying with \$FREE_MODEL" >> "$dir/output.log"
  MODEL="\$FREE_MODEL"
  { grep -vE '^model=' "$dir/state.env"; echo "model=\$FREE_MODEL"; } > "$dir/.state.tmp"
  mv "$dir/.state.tmp" "$dir/state.env"
  run_opencode "\$FREE_MODEL"
  ec=\$?
fi
exit \$ec
RUNNER
  else
    cat > "$runner" <<RUNNER
#!/usr/bin/env bash
cd "$ROOT"
PROMPT="\$(cat "$dir/prompt.txt")\$(cat "$dir/bootstrap.txt")"
MODEL="$(model_for "$model")"
FREE_MODEL="\$(node "$ROOT/scripts/model-fallback.mjs" free-model 2>/dev/null || echo opencode/big-pickle)"
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
  # Host agents must NOT call abra. Keys must already be in env (Julius wrapped spawn).
  opencode run -m "\$m" --title "gotchibot:$id" --dir "$ROOT" "\${AUTO_FLAGS[@]}" "\$PROMPT" \
    > "$dir/output.md" 2> "$dir/output.log"
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
      if [ "$(field sandbox "$dir")" = "1" ]; then
        node "$ROOT/scripts/sandbox.mjs" rm "$id" >/dev/null 2>&1 || true
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
      if [ "$(field sandbox "$dir")" = "1" ]; then
        node "$ROOT/scripts/sandbox.mjs" rm "$id" >/dev/null 2>&1 || true
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

# --- transcript export -----------------------------------------------------
# Where the last export went. sessions/ is gitignored, so this is per-install
# user state, next to .onboarding.json — not a repo-tracked config.
EXPORT_PREFS="$SESSIONS/.export.json"
EXPORT_DEFAULT_DIR="$HOME/Downloads"

export_saved_dir() {
  [ -f "$EXPORT_PREFS" ] || return 0
  node -e '
    const fs=require("fs");
    try {
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if (j.dir) console.log(j.dir);
    } catch {}
  ' "$EXPORT_PREFS" 2>/dev/null || true
}

export_save_dir() {
  mkdir -p "$SESSIONS"
  node -e '
    const fs=require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({ dir: process.argv[2] }, null, 2) + "\n");
  ' "$EXPORT_PREFS" "$1" 2>/dev/null || true
}

# ~/x and $HOME/x -> absolute. Leaves everything else alone.
expand_tilde() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Shortest unambiguous display form: $HOME/Downloads -> ~/Downloads
tildify() {
  case "$1" in
    "$HOME"/*) printf '~/%s\n' "${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

latest_session() {
  local d last=""
  for d in "$SESSIONS"/s*/; do
    [ -f "$d/state.env" ] || continue
    last="$d"
  done
  [ -n "$last" ] || return 1
  basename "$last"
}

# Never clobber: gotchibot-<id>.md, then -2, -3, …
unique_path() {
  local base="$1" ext="$2" n=2 try="$1$2"
  while [ -e "$try" ]; do
    try="${base}-${n}${ext}"
    n=$((n + 1))
  done
  printf '%s\n' "$try"
}

render_transcript() {
  local id="$1" d="$SESSIONS/$1" with_log="$2"
  printf '# GotchiBot session %s\n\n' "$id"
  local k v
  for k in hero status model runtime started ended; do
    v="$(field "$k" "$d" 2>/dev/null || true)"
    # bash 3.2 printf parses a format starting with "-" as an option: lead with %s.
    [ -n "$v" ] && printf '%s\n' "- **$k:** $v"
  done
  printf '%s\n' "- **exported:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -f "$d/prompt.txt" ]; then
    printf '\n---\n\n## Prompt\n\n'
    cat "$d/prompt.txt"
  fi
  if [ -f "$d/output.md" ]; then
    printf '\n---\n\n## Output\n\n'
    cat "$d/output.md"
  fi
  if [ "$with_log" = 1 ] && [ -f "$d/output.log" ]; then
    printf '\n---\n\n## Runner log\n\n```\n'
    cat "$d/output.log"
    printf '```\n'
  fi
}

cmd_export() {
  local id="" out="" with_log=0 assume_yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
      --log) with_log=1; shift ;;
      --yes|-y) assume_yes=1; shift ;;
      -*) usage ;;
      *) [ -z "$id" ] || usage; id="$1"; shift ;;
    esac
  done

  if [ -z "$id" ]; then
    id="$(latest_session)" || { echo "no sessions to export" >&2; exit 1; }
    echo "session: $id (most recent)" >&2
  fi
  [ -f "$SESSIONS/$id/state.env" ] || { echo "unknown session: $id" >&2; exit 1; }
  [ -f "$SESSIONS/$id/output.md" ] || [ -f "$SESSIONS/$id/prompt.txt" ] || {
    echo "nothing to export yet: $id" >&2; exit 1; }

  local dest_dir dest_file default_dir
  if [ -n "$out" ]; then
    # --out wins outright: no prompt, honour the exact path given.
    out="$(expand_tilde "$out")"
    # Deterministic: ends in .md -> that exact file; anything else -> a folder.
    # (Not "does it exist yet", which would make --out behave differently on a
    # first run than on a second.)
    case "$out" in
      *.md) dest_dir="$(dirname "$out")"; dest_file="$(basename "$out")" ;;
      *) dest_dir="${out%/}"; dest_file="" ;;
    esac
  else
    default_dir="$(export_saved_dir)"
    [ -n "$default_dir" ] || default_dir="$EXPORT_DEFAULT_DIR"
    if [ "$assume_yes" = 1 ] || [ ! -t 0 ]; then
      dest_dir="$default_dir"
      dest_file=""
    else
      local reply=""
      printf '\n  Save transcript to [%s]: ' "$(tildify "$default_dir")" >&2
      IFS= read -r reply || reply=""
      reply="$(printf '%s' "$reply" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      if [ -z "$reply" ]; then
        dest_dir="$default_dir"
        dest_file=""
      else
        reply="$(expand_tilde "$reply")"
        case "$reply" in
          *.md) dest_dir="$(dirname "$reply")"; dest_file="$(basename "$reply")" ;;
          *) dest_dir="${reply%/}"; dest_file="" ;;
        esac
      fi
    fi
  fi

  mkdir -p "$dest_dir" || { echo "cannot create: $dest_dir" >&2; exit 1; }
  [ -w "$dest_dir" ] || { echo "not writable: $dest_dir" >&2; exit 1; }

  local target
  if [ -n "$dest_file" ]; then
    target="$dest_dir/$dest_file"
    [ -e "$target" ] && target="$(unique_path "${target%.md}" ".md")"
  else
    target="$(unique_path "$dest_dir/gotchibot-$id" ".md")"
  fi

  render_transcript "$id" "$with_log" > "$target"

  # Remember the directory, not the filename — only when we prompted for it.
  [ -n "$out" ] || export_save_dir "$dest_dir"

  printf '  → %s\n' "$(tildify "$target")" >&2
  printf '%s\n' "$target"
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
  export) cmd_export "$@" ;;
  requests) cmd_requests ;;
  *) usage ;;
esac
