#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$ROOT/sessions"
mkdir -p "$SESSIONS"

usage() {
  cat >&2 <<'EOF'
usage:
  opencode-dispatch.sh new [--model flash|pro|local|<provider/model>] "PROMPT"
  opencode-dispatch.sh list
  opencode-dispatch.sh status <id>...
  opencode-dispatch.sh wait [<id>...]
  opencode-dispatch.sh output <id>
  opencode-dispatch.sh requests   show pending skill requests
EOF
  exit 2
}

model_for() {
  case "$1" in
    free) echo "openrouter/stealth/ox-alpha" ;;
    nim) echo "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b" ;;
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
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) model="$2"; shift 2 ;;
      *) prompt="${1:-}"; shift ;;
    esac
  done
  [ -n "${prompt:-}" ] || usage

  id="s$(date +%Y%m%d-%H%M%S)-$$"
  dir="$SESSIONS/$id"
  mkdir -p "$dir"

  printf '%s\n' "$prompt" > "$dir/prompt.txt"

  {
    echo "model=$(model_for "$model")"
    echo "tier=$model"
    echo "status=running"
    echo "started=$(date -u +%FT%TZ)"
    echo "pid="
  } > "$dir/state.env"

  cat > "$dir/bootstrap.txt" <<EOF

--- session bootstrap ---
You are sub-agent $id in the GotchiBot swarm.
Session dir: $dir
Write your deliverable to $dir/output.md.
If you need a skill not in skills/registry.json, append a JSON request to
$dir/skill-requests.jsonl and continue without it. Never install anything.
Never handle secrets directly; ask the orchestrator to fetch them via abracadabra.
EOF

  if [ -n "${AARCADE_GOTCHIBOT_SERVICE_SECRET:-}" ]; then
    hero="$(node "$ROOT/scripts/identity.mjs" bind --session "$id" 2>/dev/null | tail -1)" || hero=""
    if [ -n "$hero" ]; then
      set_field "$dir" hero "$hero"
      echo "Your gotchi identity: $hero" >> "$dir/bootstrap.txt"
    fi
  fi

  runner="$dir/runner.sh"
  cat > "$runner" <<RUNNER
#!/usr/bin/env bash
cd "$ROOT"
opencode run -m "$(model_for "$model")" --title "gotchibot:$id" \
  "\$(cat "$dir/prompt.txt")\$(cat "$dir/bootstrap.txt")" \
  > "$dir/output.md" \
  2> "$dir/output.log"
RUNNER
  chmod +x "$runner"

  ( if "$runner"; then set_field "$dir" status done
      "$ROOT/scripts/tts.sh" "Sub agent $id finished."
    else set_field "$dir" status failed
      "$ROOT/scripts/tts.sh" "Sub agent $id failed."
    fi
    set_field "$dir" ended "$(date -u +%FT%TZ)" ) >/dev/null 2>&1 </dev/null &
  echo $! > "$dir/pid"
  set_field "$dir" pid "$!"
  echo "$id"
}

cmd_list() {
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
  if [ $# -eq 0 ]; then
    set -- $(for d in "$SESSIONS"/s*/state.env; do
      grep -q '^status=running' "$d" 2>/dev/null && basename "$(dirname "$d")"
    done)
    [ $# -gt 0 ] || return 0
  fi
  for id in "$@"; do
    d="$SESSIONS/$id"
    while [ ! -f "$d/output.md" ] || grep -q '^status=running' "$d/state.env" 2>/dev/null; do
      sleep 1
    done
    field status "$d"
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
