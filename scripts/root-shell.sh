#!/usr/bin/env bash
# Root shell on demand for the desk Terminal pane.
#
#   scripts/root-shell.sh            # Touch ID (sudo), then a root shell
#
# - Any cached sudo approval is dropped first, so this always asks (Touch ID when
#   /etc/pam.d/sudo_local has pam_tid + pam_reattach; otherwise your password).
# - The root shell exits after GOTCHIBOT_ROOT_IDLE seconds idle (default 300).
# - On the way out the approval is dropped again: anything that types into this
#   pane afterwards (desk agents can send keys to panes) gets no free sudo.
set -uo pipefail

idle="${GOTCHIBOT_ROOT_IDLE:-300}"
case "$idle" in ''|*[!0-9]*) idle=300 ;; esac
sh_path="${SHELL:-/bin/zsh}"

sudo -k
printf '\033[33mroot shell · auto-exit after %ss idle · exit to drop root\033[0m\n' "$idle"
# TMOUT is honoured by zsh and bash: an idle interactive shell logs itself out.
sudo env TMOUT="$idle" "$sh_path" -i
status=$?
sudo -k
printf '\033[2mroot shell closed · sudo approval dropped\033[0m\n'
exit "$status"
