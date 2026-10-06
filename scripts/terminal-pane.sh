#!/usr/bin/env bash
# Desk Terminal pane: your normal login shell in the current project's folder
# (else the repo). A project switch restarts it there if it is idle (project-sync).
# Root on demand: Ctrl+Space then R runs scripts/root-shell.sh here (Touch ID via
# sudo, auto-exits when idle, sudo approval dropped on the way out).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/project-dir.sh
. "$ROOT/scripts/lib/project-dir.sh"
DIR="$(project_dir "$ROOT")"
cd "$DIR" || cd "$ROOT" || exit 1

printf '\033[2mTerminal · %s\033[0m\n' "$DIR"
printf '\033[2mCtrl+Space R → root shell (Touch ID · exits after %s min idle)\033[0m\n\n' \
  "$(( ${GOTCHIBOT_ROOT_IDLE:-300} / 60 ))"

exec "${SHELL:-/bin/zsh}" -l
