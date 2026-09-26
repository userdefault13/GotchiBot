#!/usr/bin/env bash
# Phase 1 of docs/GOTCHIBOT-VM-2020.md: boot one hand-built Debian 12 guest on
# the 2020 iMac (KVM, user-mode NAT, SSH on 127.0.0.1:2222 only).
#
#   scripts/vm-phase1-test.sh up     # download base, build overlay + seed, boot
#   scripts/vm-phase1-test.sh check  # SSH in, report resources + host reachability
#   scripts/vm-phase1-test.sh keytest  # (human, vault password) keyed secret fetch from guest
#   scripts/vm-phase1-test.sh down   # power off (disk kept)
#   scripts/vm-phase1-test.sh rm     # power off and delete the test VM
set -euo pipefail

CACHE="$HOME/.cache/gotchibot-vm"
VM="$CACHE/test1"
IMG="debian-12-genericcloud-amd64.qcow2"
URL="https://cloud.debian.org/images/cloud/bookworm/latest"
KEY="$HOME/.ssh/gotchibot-vm"
PORT=2222

vm_ssh() {
  ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$VM/known_hosts" \
    gotchi@127.0.0.1 "$@"
}

running() { [ -f "$VM/qemu.pid" ] && kill -0 "$(cat "$VM/qemu.pid")" 2>/dev/null; }

cmd_up() {
  [ -w /dev/kvm ] || { echo "/dev/kvm not writable" >&2; exit 1; }
  running && { echo "already running (pid $(cat "$VM/qemu.pid"))"; return; }
  mkdir -p "$VM"

  if [ ! -f "$CACHE/$IMG" ]; then
    echo "Downloading $IMG"
    curl -fL --progress-bar -o "$CACHE/$IMG.part" "$URL/$IMG"
    curl -fsSL -o "$CACHE/SHA512SUMS" "$URL/SHA512SUMS"
    want=$(awk -v f="$IMG" '$2 == f {print $1}' "$CACHE/SHA512SUMS")
    got=$(sha512sum "$CACHE/$IMG.part" | awk '{print $1}')
    [ -n "$want" ] && [ "$want" = "$got" ] || { rm -f "$CACHE/$IMG.part"; echo "checksum mismatch" >&2; exit 1; }
    mv "$CACHE/$IMG.part" "$CACHE/$IMG"
    chmod a-w "$CACHE/$IMG"
    echo "Checksum OK"
  fi

  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "gotchibot-vm@$(hostname)" -f "$KEY"

  if [ ! -f "$VM/disk.qcow2" ]; then
    qemu-img create -q -f qcow2 -F qcow2 -b "$CACHE/$IMG" "$VM/disk.qcow2" 20G
  fi

  cat >"$VM/user-data" <<EOF
#cloud-config
hostname: gbvm-test1
users:
  - name: gotchi
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$KEY.pub")
ssh_pwauth: false
EOF
  printf 'instance-id: gbvm-test1\nlocal-hostname: gbvm-test1\n' >"$VM/meta-data"
  cloud-localds "$VM/seed.iso" "$VM/user-data" "$VM/meta-data"

  qemu-system-x86_64 -name gbvm-test1 \
    -machine q35,accel=kvm -cpu host -smp 2 -m 2048 \
    -drive file="$VM/disk.qcow2",if=virtio,format=qcow2 \
    -drive file="$VM/seed.iso",if=virtio,format=raw,readonly=on \
    -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$PORT-:22 \
    -device virtio-net-pci,netdev=n0 \
    -display none -serial file:"$VM/serial.log" \
    -pidfile "$VM/qemu.pid" -daemonize
  echo "Booted (pid $(cat "$VM/qemu.pid")). Waiting for SSH on 127.0.0.1:$PORT"

  for _ in $(seq 1 60); do
    vm_ssh true 2>/dev/null && { echo "SSH ready"; return; }
    sleep 3
  done
  echo "SSH not ready after 180s; see $VM/serial.log" >&2
  exit 1
}

cmd_check() {
  vm_ssh 'echo "guest: $(hostname) $(uname -r)"; echo "cpus: $(nproc)"; free -m | awk "/Mem/{print \"mem MiB: \"\$2}"; df -h / | awk "NR==2{print \"disk: \"\$2\" (\"\$4\" free)\"}"; echo "host abra dash: $(curl -s -o /dev/null -w %{http_code} http://10.0.2.2:7331/)"; echo "keyless /secret: $(curl -s -o /dev/null -w %{http_code} -X POST -H content-type:application/json -d "{\"project\":\"gotchibot\",\"keys\":[\"GOTCHIBOT_SANDBOX_ABRA_KEY\"]}" http://10.0.2.2:7331/secret)"; echo "internet: $(curl -s -o /dev/null -w %{http_code} https://deb.debian.org/)"'
}

cmd_keytest() {
  export PATH="$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin 2>/dev/null | tail -1):$PATH"
  local key code
  key=$(abra get gotchibot GOTCHIBOT_SANDBOX_ABRA_KEY)
  code=$(printf '%s\n' "$key" | vm_ssh 'read -r k; curl -s -o /dev/null -w %{http_code} -X POST -H content-type:application/json -H "Authorization: Bearer $k" -d "{\"project\":\"gotchibot\",\"keys\":[\"GOTCHIBOT_SANDBOX_ABRA_KEY\"]}" http://10.0.2.2:7331/secret')
  unset key
  echo "keyed /secret from guest: $code (200 = key works)"
}

cmd_down() {
  if running; then
    vm_ssh 'sudo systemctl poweroff' 2>/dev/null || kill "$(cat "$VM/qemu.pid")"
    for _ in $(seq 1 30); do running || break; sleep 1; done
    running && kill "$(cat "$VM/qemu.pid")"
  fi
  rm -f "$VM/qemu.pid"
  echo "stopped"
}

case "${1:-}" in
  up) cmd_up ;;
  check) cmd_check ;;
  keytest) cmd_keytest ;;
  down) cmd_down ;;
  rm) cmd_down; rm -rf "$VM"; echo "removed $VM (base image kept)" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
