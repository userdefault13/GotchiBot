#!/usr/bin/env bash
# SwiftBar / xbar plugin — menu bar ghost + running agent count.
#
# Install:
#   ./scripts/gotchibot menubar install
# Requires SwiftBar (brew install --cask swiftbar). Do not install autonomously.
#
# Counts live OpenCode processes on this Mac that target GotchiBot
# (orchestrator chat + spawned agents), plus remote iMac sessions from
# the last focus-list cache. Skips dead session PIDs / abra wrappers.
#
# SwiftBar metadata:
# <xbar.title>GotchiBot Agents</xbar.title>
# <xbar.version>1.1</xbar.version>
# <xbar.author>GotchiBot</xbar.author>
# <xbar.desc>Ghost + count of live GotchiBot agents</xbar.desc>
# <xbar.dependencies>bash</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>

set -euo pipefail

# Resolve repo root even when SwiftBar runs a symlink.
_SRC="${BASH_SOURCE[0]}"
while [ -L "$_SRC" ]; do
  _TARGET="$(readlink "$_SRC")"
  case "$_TARGET" in
    /*) _SRC="$_TARGET" ;;
    *) _SRC="$(cd "$(dirname "$_SRC")" && pwd)/$_TARGET" ;;
  esac
done
ROOT="$(cd "$(dirname "$_SRC")/.." && pwd)"
SESSIONS="$ROOT/sessions"
GHOST="${GOTCHIBOT_MENUBAR_GHOST:-👻}"

# Live local OpenCode agent processes (not abra wrapper / not this plugin).
count_local_opencode() {
  ps -ax -o pid= -o args= 2>/dev/null | awk -v root="$ROOT" '
    index($0, root) == 0 { next }
    /abra run/ { next }
    /menubar-agents/ { next }
    /(^|[[:space:]\/])opencode([[:space:]]|$)/ {
      print $1
    }
  ' | wc -l | tr -d ' '
}

# Spawn sessions marked running whose pid is still alive (covers non-opencode runners).
count_live_sessions() {
  local n=0 d pid
  shopt -s nullglob
  for d in "$SESSIONS"/s*/state.env; do
    grep -q '^status=running' "$d" 2>/dev/null || continue
    pid="$(grep -E '^pid=' "$d" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    # If this pid is already an opencode GotchiBot process, local_opencode counted it.
    if ps -p "$pid" -o args= 2>/dev/null | grep -qE '(^|[[:space:]/])opencode([[:space:]]|$)'; then
      continue
    fi
    n=$((n + 1))
  done
  echo "$n"
}

count_remote() {
  if [ ! -f "$SESSIONS/.focus-list.json" ] || ! command -v node >/dev/null; then
    echo 0
    return
  fi
  node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let n = 0;
      for (const e of j.entries || []) {
        if (e.kind === "session" && e.host === "imac" && e.status === "running") n++;
      }
      process.stdout.write(String(n));
    } catch { process.stdout.write("0"); }
  ' "$SESSIONS/.focus-list.json" 2>/dev/null || echo 0
}

local_n="$(count_local_opencode)"
sess_n="$(count_live_sessions)"
remote_n="$(count_remote)"
running=$((local_n + sess_n + remote_n))
mbp_n=$((local_n + sess_n))

# Title line (menu bar) — per-host counts at a glance: 👻 MBP 2 · iMac 1
printf '%s MBP %d · iMac %d\n' "$GHOST" "$mbp_n" "$remote_n"
echo "---"
echo "GotchiBot agents: $running running"
echo "MBP: $mbp_n (OpenCode $local_n + sessions $sess_n) | iMac: $remote_n"
echo "Open orchestrator | bash='$ROOT/scripts/gotchibot' param1=tmux terminal=false"
echo "Mesh status | bash='$ROOT/scripts/gotchibot' param1=mesh terminal=true"
echo "List sessions | bash='$ROOT/scripts/gotchibot' param1=list terminal=true"
echo "Refresh | refresh=true"
