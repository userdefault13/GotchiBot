Status: Phase 0 approved 2026-09-26. No packages installed.

Decisions (UserDefault, 2026-09-26):

- Backend: QEMU/KVM full VM, driven by a Node script, no libvirt.
- First slot: 2 vCPU / 2 GiB RAM / 20G disk.
- Fix the port 7331 open item before Phase 1: run `abra serve` on
  127.0.0.1 only (user unit `abra-serve`). A VM reaches it at `10.0.2.2:7331`.
  The Docker sandbox on the 2020 iMac cannot (on Linux,
  `host.docker.internal` is the bridge, not loopback) and stays without
  secrets. `--lan` was rejected: it exposes the vault API on Wi-Fi/Tailscale.
- Add Docker sandbox limits now (section 7), independent of the VM work.

# GotchiBot VM sandbox on the 2020 iMac

This doc proposes running GotchiBot sandbox jobs inside real virtual machines
on the **2020 iMac** instead of (or alongside) today's Docker sandbox. It is a
design only. Nothing here has been installed or run.

- **Host:** 2020 iMac, Tailscale host `imacomarchy`, user `user_default`.
- **Client:** MBP (UserDefault's MacBook). The MBP does not run VMs.
- **Owner of decisions:** UserDefault. Every package and every phase needs
  sign-off.

## Host facts (measured 2026-09-26)

| Item | Value |
|---|---|
| CPU | Intel i7-10700K, 8 cores / 16 threads |
| Virtualization | VT-x present (vmx + ept), `/dev/kvm` mode `crw-rw-rw-` |
| RAM | 7.6 GiB total, ~2.5 GiB used, ~5.2 GiB available |
| Disk | 464G, 419G free, btrfs on encrypted root |
| OS | Omarchy (Arch-based), kernel `linux-t2` 7.2.4 |
| Mode | Headless, `multi-user.target`, no desktop |
| VM tooling | None: no qemu, libvirt, firecracker, cloud-hypervisor |
| Docker | 29.7.2, ~940 MiB of containers running |
| Firewall | UFW on, `DEFAULT_FORWARD_POLICY="DROP"`, `ip_forward=1` |
| Tailscale | On |
| Repo | `~/dev/GotchiBot` (lowercase `dev`) on `main` |

Running Docker containers: aarcade acartridge indexer + graphql + postgres,
aarcade-mongo, callthegame-mongo, cartridge postgres.

GotchiBot services run as `systemd --user` units: `gotchibot-api`,
`gotchibot-hub-runner`, `gotchibot-templates-cdn`.

Two facts shape this whole design:

1. **RAM is tight.** 7.6 GiB total is the limiting resource, not CPU or disk.
2. **UFW is fragile here.** A console login was recently broken by UFW log
   spam. Anything that adds bridge interfaces or forward rules is off the
   table.

## Today's Docker sandbox (baseline)

`scripts/sandbox.mjs` is the current sandbox. Verbs: `ensure-image`, `up`,
`exec`, `status`, `models`, `promote`, `rm`.

The `docker run` call uses:

- `--security-opt no-new-privileges`
- `--network bridge`
- `--add-host host.docker.internal:host-gateway`
- bind mounts: `/work` (rw), `/session` (rw)
- read-only mounts: `AGENTS.md` and the skills registry
- NOT mounted: `docker.sock`, `~/Dev`, `~/.abra`

**Gap: there is no `--memory`, `--cpus`, or `--pids-limit`.** A single
sandbox job can use the whole host: all RAM, all CPU, unlimited processes.
On a 7.6 GiB box that also runs the Aarcade stack, one runaway job can take
everything down. See "Side fix worth doing regardless" below.

Image: `docker/sandbox/Dockerfile`, based on `node:22-bookworm-slim`, plus
git, build-essential, python3, and the OpenCode CLI.

Secrets: `sandbox-abra-fetch` POSTs to `http://$ABRA_HOST:7331/secret` with
`ABRA_KEY`.

Spawn path: `gotchi-orchestrate.mjs spawn --sandbox`, or env
`GOTCHIBOT_SANDBOX=1`. The hero must be `available`.

**Open item: port 7331.** The abra vault agent runs on the 2020 iMac (user
unit `abra-agent`), but nothing listens on port 7331. Sandboxed jobs on the
2020 iMac cannot fetch secrets today, in Docker or in a VM.

## 1. Why a VM (vs today's Docker sandbox)

What a VM gives us:

- **Its own kernel.** A container shares the host kernel. A kernel bug or a
  container escape reaches the host directly. A VM guest has to break out of
  KVM and QEMU as well.
- **Hard CPU and RAM caps.** A guest gets a fixed number of vCPUs and a fixed
  amount of RAM. It cannot grow past that. (Docker can do this too, but only
  if the flags are set, and today they are not.)
- **Safe for untrusted code.** Running a stranger's build script or an
  agent's unreviewed code is much less risky with a separate kernel.
- **Fits Host Network slots later.** A slot job with `maxCoreMinutes` maps
  cleanly onto a VM with fixed vCPUs and a lifetime.

What it costs:

- **RAM per guest.** Each VM reserves its RAM up front. A 2 GiB guest is
  2 GiB the host cannot use for anything else. On this box that is the real
  price.
- **Slower start.** A full VM boots an OS. Expect seconds, not the sub-second
  start of a container.
- **More moving parts.** Base images, overlays, cloud-init seeds, SSH keys,
  port forwards, a guest OS to patch. More things to break.

## 2. Options matrix

| Option | Isolation | RAM overhead | Boot time | Arch packaging | `sandbox.mjs` change |
|---|---|---|---|---|---|
| QEMU/KVM full VM | Strong (own kernel) | Full guest RAM | Seconds | Official repo | New backend script |
| Firecracker microVM | Strong (own kernel) | Guest RAM, small VMM | Fast | Verify in Phase 1 | New backend script |
| gVisor (`runsc`) | Medium (user-space kernel) | Near zero | Container-fast | AUR, verify | Add `--runtime` flag |
| Kata Containers | Strong (VM per container) | Guest RAM per box | Seconds | AUR, verify | Docker runtime config |

Packaging entries marked "verify" have not been checked on this host. They
must be confirmed in Phase 1 before any request goes to UserDefault.

**QEMU/KVM full VM.** A normal virtual machine with its own kernel and OS.
The most flexible and best understood option. Runs any guest image, including
the Debian image that matches our Docker base. Costs the full guest RAM. Can
be driven directly from a Node script without libvirt.

**Firecracker microVM.** Minimal VMM built for fast, small VMs. Strong
isolation with less overhead than QEMU. Needs a special kernel and rootfs
setup, has no general-purpose device model, and brings its own tooling to
learn. More work to get a Debian-like environment than QEMU.

**gVisor (`runsc`) as a Docker runtime.** Intercepts syscalls in a user-space
kernel, so containers do not talk to the host kernel directly. **It keeps the
existing Docker flow and costs almost no extra RAM**, which matters a lot on
a 7.6 GiB box. Isolation is weaker than a real VM, and some syscalls or
workloads may not be supported. The change to `sandbox.mjs` is small.

**Kata Containers.** Runs each container inside a lightweight VM, behind the
Docker/OCI interface. Strong isolation while keeping container ergonomics.
Heaviest to set up of the four, and still pays guest RAM per container.

## 3. Recommendation

**Proposed, needs UserDefault sign-off.**

Use **QEMU/KVM driven directly by a Node script**, with **no libvirt**.

Why no libvirt: libvirt's default network creates a bridge (`virbr0`) and
installs its own forward and NAT rules. On the 2020 iMac that would fight UFW
(forward policy `DROP`) and the ufw-docker rules, and risk repeating the
recent log-spam lockout. Driving QEMU directly lets us use user-mode
networking with no host network changes at all.

**Fallback: gVisor.** If RAM turns out to be the blocker (for example, the
Aarcade stack grows, or one 2 GiB guest leaves too little headroom), switch
to gVisor as a Docker runtime. It keeps today's sandbox flow and adds almost
no memory cost, at the price of weaker isolation than a real VM.

## 4. Proposed shape

### Guest

- Debian 12 (bookworm) `genericcloud` image. This matches the Docker image
  base (`node:22-bookworm-slim`), so the same packages and habits carry over.
- cloud-init NoCloud seed for the user account and SSH public key.

### Slot size (start with one)

- 2 vCPU
- 2 GiB RAM
- 20G qcow2 overlay on a shared, read-only base image

The base image is never written to. Each VM gets its own overlay, and
deleting the VM deletes the overlay.

### Networking

- QEMU user-mode NAT (passt or slirp). No bridge, no tap device.
- SSH via `hostfwd`, bound to `127.0.0.1` only. Not reachable from the LAN or
  Tailscale.
- **No UFW changes. No forward rules. No new interfaces.**
- The guest reaches the host at `10.0.2.2`.

### Files

- Version 1: copy `/work` into the guest and back out over SSH/rsync.
- Later: virtiofs for a shared mount, once the basics are solid.

### Secrets

- Same model as Docker: `ABRA_KEY` plus the host endpoint.
- From inside the guest, the endpoint is `10.0.2.2:7331`.
- Scoped API key `gotchibot-vm` (project `gotchibot` only), stored in the
  vault as `GOTCHIBOT_SANDBOX_ABRA_KEY`. `gotchibot-vm.mjs` passes it into
  the guest as `ABRA_KEY`. Done 2026-09-26. Rotate with
  `~/bin/abra-key-store gotchibot-vm gotchibot GOTCHIBOT_SANDBOX_ABRA_KEY`.

### Paths

| What | Where |
|---|---|
| Base images | `~/.cache/gotchibot-vm/` |
| Per-VM state | `~/dev/GotchiBot/vms/<id>/` (gitignored) |

### CLI

- New script: `scripts/gotchibot-vm.mjs`.
- Same verbs as `sandbox.mjs`: `ensure-image`, `up`, `exec`, `status`,
  `models`, `promote`, `rm`.
- Orchestrate picks the backend with
  `GOTCHIBOT_SANDBOX_BACKEND=docker|vm`. Default stays `docker`.

Example use once built, on the 2020 iMac:

```bash
node scripts/gotchibot-vm.mjs up demo
```

```bash
node scripts/gotchibot-vm.mjs exec demo -- uname -a
```

```bash
node scripts/gotchibot-vm.mjs rm demo
```

## 5. RAM budget

| Item | GiB |
|---|---|
| Host total | 7.6 |
| Docker stack (Aarcade containers) | ~0.9 |
| GotchiBot services + OS | ~1.6 |
| One VM guest | 2.0 |
| **Headroom left** | **~3.1** |

The ~3.1 GiB headroom is before QEMU's own process overhead (not yet
measured) and before the host page cache, btrfs, and any Docker sandbox jobs
that still run. A second 2 GiB guest would cut headroom to about 1 GiB, which
is not safe for a box that also serves databases.

**Conclusion: only one VM can run at a time on the 2020 iMac.** The CLI
should refuse to start a second VM rather than let the host swap.

## 6. Phases

### Phase 0: design

This document.

**Done when:** UserDefault approves this doc, including the recommendation
and the open questions below.

### Phase 1: packages approved, one manual guest

**Package request (not an install).** The following are candidates, to be
verified against Arch/Omarchy repos in Phase 1 before anything is installed:

- `qemu-base`, which provides `qemu-system-x86_64` and `qemu-img`
- A cloud-init seed ISO tool: `cloud-image-utils`, or `libisoburn`
  (xorriso)

Nothing is installed until UserDefault approves the exact package list.

**Result (2026-09-26).** Approved and installed: `qemu-base` +
`cloud-image-utils` (24 packages, ~25 MB; `cloud-image-utils` pulls
`cdrtools`, so `libisoburn` is not needed). Test guest via
`scripts/vm-phase1-test.sh` (on the 2020 as `~/bin/vm-phase1-test`), state
in `~/.cache/gotchibot-vm/test1`, guest SSH key `~/.ssh/gotchibot-vm`:
boots to SSH in ~20 s; 2 vCPU / 1979 MiB / 20G; reaches `10.0.2.2:7331`
(200) and the internet; keyless `/secret` from the guest is refused (403),
because loopback requests without a key need an interactive vault approval.
Keyed fetch from the guest with `GOTCHIBOT_SANDBOX_ABRA_KEY` works (abra-serve
log: served 1 var to API key `gotchibot-vm`). Phase 1 done.

Then, by hand, on the 2020 iMac: download the Debian 12 `genericcloud`
image, create an overlay, build a seed ISO, boot one guest with user-mode
networking and a localhost SSH forward.

Check KVM access, on the 2020 iMac:

```bash
ls -l /dev/kvm
```

Check the guest answers, on the 2020 iMac:

```bash
ssh -p 2222 debian@127.0.0.1 uname -a
```

**Done when:** one guest boots and answers SSH from the 2020 iMac, and
`ufw status` shows no new rules.

### Phase 2: `gotchibot-vm.mjs`

Build the Node script with `up`, `exec`, `status`, `promote`, `rm` (plus
`ensure-image`). Wire secrets once port 7331 is fixed.

**Done when:** a VM can be created, run a command, return files via
`promote`, and be removed, all through the script, with no leftover state.

**Built (2026-09-26).** `scripts/gotchibot-vm.mjs` exists with `ensure-image`,
`up`, `exec`, `status`, `models`, `promote`, `rm`. `up` refuses a second VM
(exit 4) while another guest's qemu is alive. Secrets are piped over SSH
stdin into a 0600 `/etc/gotchibot/sandbox.env`; only names reach
`meta.json`. State lives in `vms/<id>/` (gitignored) and the shared
read-only base in `~/.cache/gotchibot-vm/`.

**Smoke test on the 2020 iMac (2026-09-26): passed.** `up demo` to SSH-ready
and work pushed in 13 s; `up demo2` refused with exit 4; `exec` ran as
`gotchi` in `/work` (kernel 6.1, 2 vCPU), `/rules/*` root-owned 0444,
`sandbox.env` 0600; `models` exits 1 with the Phase 3 message; `promote`
pulled a guest-written file back (scp path: the guest has no rsync);
`rm --purge` stopped qemu and removed `vms/demo/`, no qemu left running.
Credential forwarding was not exercised (no key in the test shell); the keyed
fetch itself was proven in Phase 1. `up` leaves an empty `sessions/<id>/`, the
same as `sandbox.mjs`. Phase 2 done.

### Phase 3: orchestrate backend switch

Teach `gotchi-orchestrate.mjs spawn --sandbox` to honor
`GOTCHIBOT_SANDBOX_BACKEND=vm`.

**Done when:** a spawn smoke test runs one sandbox job end to end in a VM
and writes `output.md`, with `docker` still the default.

### Phase 4 (later): Host Network slots on VMs

Run Host Network slot jobs (`config/host-network.slot-job.schema.json`:
jobId, maxCoreMinutes, artifact put/get URLs, promptHash; bodies never stored
by Arcade) inside VMs.

The Host Network doc is **parked** for privacy reasons. This phase only
starts if that doc is un-parked. VM work must stand on its own for local
sandbox use first.

**Done when:** defined when Host Network is un-parked.

## 7. Side fix worth doing regardless

Add resource limits to the Docker sandbox in `scripts/sandbox.mjs`:

- `--memory` (for example 2g, to match the VM slot)
- `--cpus` (for example 2)
- `--pids-limit` (to stop fork bombs)

This is cheap: a few flags on the existing `docker run` call, no new
packages, no new host network changes. It closes the "a job can use the
whole host" gap today, while the VM work goes through approval and phases.
It is worth doing even if the VM plan is rejected.

## 8. Open questions for UserDefault

1. **QEMU/KVM or gVisor?** Approve QEMU/KVM (stronger, more RAM) or go
   straight to gVisor (lighter, weaker)?
2. **Guest size.** Is 2 vCPU / 2 GiB RAM / 20G disk ok for the first slot?
3. **Port 7331.** Fix the abra endpoint on the 2020 iMac first, or during
   Phase 2?
4. **Trim Docker stacks?** Should any Aarcade containers be stopped or
   slimmed to free RAM for a guest?
