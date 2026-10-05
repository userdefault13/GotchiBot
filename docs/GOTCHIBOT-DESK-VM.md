# GotchiBot desk VM

Sandbox work on a **powerful desk** runs in a VM on that desk's own CPU, not
on the Hub's. The macOS twin of the Hub's QEMU guest (`docs/GOTCHIBOT-VM-2020.md`).

Decisions (UserDefault, 2026-10-05):

- **Scope: both.** On a qualifying desk, the pink Sandbox mode runs inside the
  VM, and spawned sandbox workers run there too.
- **Gate: auto-detect + opt-in.** The desk must meet a hardware floor and its
  owner must run `gotchibot desk-vm enable`.
- **Backend: Lima with Apple's Virtualization framework (`vmType: vz`).**
- **Fallback: Docker.** A job that wants the desk VM but cannot have it runs in
  the Docker sandbox, and the graph edge records why. It never falls back to the
  Hub VM.

## Gate and size

`gotchibot desk-vm check` compares the desk with `config/desk-vm.json`:

| Setting | Default | Meaning |
|---|---|---|
| `minCores` / `minMemGB` | 12 / 32 | the floor |
| `cpuShare` / `maxCpus` | 0.5 / 8 | guest vCPUs |
| `memShare` / `maxMemGB` | 0.25 / 16 | guest RAM |
| `diskGB` | 40 | guest disk |
| `modePort` | 41097 | desk loopback port for the sandbox-mode server |

It also requires Apple Silicon, macOS 13+, and `limactl`.
`GOTCHIBOT_DESK_VM_FORCE=1` skips the floor (a 2 vCPU / 2 GiB guest) for
testing on a small Mac. The MacBook (M2, 8 cores, 8 GB) does not qualify and
cannot run the VM, so it stays on Docker.

Available = qualifies + enabled + the guest created by `ensure-image`.

## Guest

One Lima instance, `gbdesk`, built by `gotchibot desk-vm ensure-image` (run by
UserDefault: it downloads Debian 12 and installs Node 22 and OpenCode inside
the guest).

Isolation:

- based on `template:_images/debian-12` only; `template:debian-12` would add
  Lima's default home-directory mount
- `mounts: []`, no ssh-agent or X11 forwarding, no host ssh keys loaded
- every guest port ignored except one: guest `127.0.0.1:4097` (the sandbox-mode
  OpenCode server) → the desk's `127.0.0.1:41097`
- jobs run as the unprivileged `gotchi` user, each in `/jobs/<id>/{work,session}`
- secrets: the forwarded env file (`/etc/gotchibot/sandbox.env`, 0600, written
  over stdin), and `abra serve` on the desk loopback at `host.lima.internal:7331`

## Spawned workers

`opencode-dispatch.sh` defaults to `GOTCHIBOT_SANDBOX_BACKEND=auto`:
desk VM if available, else Docker (`vm` and `desk-vm` force a backend).
`state.env` records `sandboxBackend` and `sandboxFallback`, and the spawn edge
title in the agent graph carries both. On a desk that offers a VM, sandboxed
`--host auto` spawns stay on that desk instead of going to the iMac.

## Sandbox mode

On an available desk VM, switching to the pink mode runs
`desk-vm mode-up`:

1. first time only (or `--fresh`): copy the project into `/jobs/mode/work`,
   leaving out `node_modules`, `sessions/` (the Hub desk token lives there),
   `.env*`, `*.pem`, `*.key`, `.abra`, and VM/sandbox state;
2. commit a baseline in the guest copy (tag `gotchibot-baseline`);
3. start `opencode serve` in the guest with a fresh password (kept in
   `desk-vms/mode/serve.json`, 0600, and passed to the chat via env, never argv).

The chat pane attaches (`opencode attach`) and is titled ` Sandbox · VM `.
Anywhere it cannot, the mode is the local playground, titled ` Sandbox · local `
(`GOTCHIBOT_SANDBOX_LOCAL=1` forces that).

Bringing work back: `gotchibot desk-vm mode-promote` builds a patch of
everything changed since the baseline and shows it; `--yes` applies it to the
project (refused if it no longer applies cleanly), then the baseline moves
forward. `mode-down` stops the server and keeps the guest copy.

## Status

- Phase 1 (backend, gate, spawn routing) and phase 2 (sandbox mode) are built
  and unit-tested. Lima accepts the generated config.
- **Not yet run on a real guest:** no desk here can run the VM. The first
  qualifying desk should verify: the guest sees no host files, reaches
  `abra serve`, one sandboxed spawn completes, and one sandbox-mode chat plus
  `mode-promote` round-trips.
