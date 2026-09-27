#!/usr/bin/env bash
# abra-key-store — issue an abra HTTP API key and save it straight into the
# vault. The key is never printed, so nobody has to copy, type or photograph it.
#
#   scripts/abra-key-store.sh <key-name> <scope> <VAR> [--into <project>] [--expires-in <days>]
#
#   key-name  label for the key (abra keys ls shows it)
#   scope     comma-separated projects the key may read
#   VAR       vault var that receives the key
#   --into    project that holds VAR (default: first project in scope)
#
# Older keys with the same name are revoked after the new one is saved.
# Humans run this in a terminal; agents do not run abra on the host.
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage 0
[ $# -ge 3 ] || usage 1

name=$1 scope=$2 var=$3
shift 3
into=${scope%%,*}
expires=0
while [ $# -gt 0 ]; do
  case $1 in
    --into) into=${2:?--into needs a project}; shift 2 ;;
    --expires-in) expires=${2:?--expires-in needs days}; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

if ! command -v abra >/dev/null 2>&1; then
  for d in "$HOME"/.local/share/mise/installs/node/*/bin; do
    [ -x "$d/abra" ] && PATH="$d:$PATH"
  done
  export PATH
fi
command -v abra >/dev/null 2>&1 || { echo "abra not found on PATH" >&2; exit 1; }

if [ "$(uname)" = Linux ]; then
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  export XDG_RUNTIME_DIR
fi

old_ids=$(abra keys ls 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' |
  awk -v n="$name" '$2 == n { for (i = 1; i < NF; i++) if ($i == "id") print $(i + 1) }')

echo "Issuing key \"$name\" for $scope (vault password prompt follows)"
out=$(abra keys new "$name" -p "$scope" --expires-in "$expires")
key=$(printf '%s\n' "$out" | grep -o 'abra_[A-Za-z0-9_-]*' | head -1 || true)
unset out
if [ -z "$key" ]; then
  echo "No key captured; nothing saved, nothing revoked." >&2
  exit 1
fi

printf '%s' "$key" | abra set "$into" "$var" --stdin
unset key
echo "Saved $var in project $into (value never shown)."

for id in $old_ids; do
  printf 'y\n' | abra keys rm "$id" >/dev/null
  echo "Revoked old \"$name\" key $id."
done

abra keys ls
