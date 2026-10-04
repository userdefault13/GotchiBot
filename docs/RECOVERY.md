# Hub and desk recovery

Run `./scripts/gotchibot recovery setup` **on the Linux/Omarchy Hub first**, then on each desk. The six-step terminal wizard preserves existing pairing and supports pausing with `q`. It walks through role/runtime, Tailscale, SSH access, recovery settings, startup services and a real recovery cycle. Rerunning rechecks the current machine; it does not revoke or remint desk credentials.

Commands:

```sh
./scripts/gotchibot recovery setup
./scripts/gotchibot recovery status
./scripts/gotchibot recovery once
./scripts/gotchibot recovery-service-plan
```

`status` is read-only and exits nonzero for missing, degraded or expired readiness. `once` performs repair and synchronization. The service plan command only prints a definition.

## What recovery does

The Hub restores its existing Tailscale connection, checks SSH on loopback and its tailnet address, checks the API/database, and reapplies an absent Tailscale Serve mapping. It leaves occupied mappings alone. It checks the selected runtime and bridge, repairs configured local services, then probes again. A repair command succeeding is never proof of health.

Every paired desk runs its own supervisor. After a Hub outage, the desk reconnects over Tailscale, verifies SSH and API reachability, authenticates with its persisted desk token, pulls paginated chat data and the open project's state, and runs all required health checks. This pull-based reconciliation brings previously paired desks back when they return online; the Hub does not invent new tokens or need inbound access to desks. Offline desks are not certified healthy by the Hub.

OpenCode/OpenClaw and bridge checks run over SSH against Hub loopback listeners. Desks also check their local receiver and Wisp proxy. The runtime is selected explicitly: an OpenCode installation does not need an unused OpenClaw gateway to pass. Extra `healthUrls` are additive and must use loopback or tailnet addresses. Failures stay degraded. Retries have bounded commands and exponential delays; the supervisor continues future cycles. Saved readiness expires after the next expected interval plus five seconds. Chat startup waits and retries instead of exiting when the Hub is temporarily unavailable.

The Hub's `repairServices` maps failed checks to existing service units. The wizard supplies the API and OpenCode defaults and asks for the bridge/runtime unit. A blank custom unit means detection only. Database recovery remains owned by its existing service/container supervisor: configure that supervisor for boot and restart, or add the appropriate local service repair. Recovery does not install missing applications or recreate a database.

## SSH approval on another device

Choose browser approval in the wizard if you want to retain Tailscale SSH check mode. Run the displayed SSH command in a second terminal; open its approval link on any device and authenticate as the authorized user. Return to the wizard and press Enter to retry. The wizard does not relay links to another unit or store browser sessions. This mode requires a person again when approval expires.

For unattended access, the wizard displays a policy fragment limited to `tag:gotchibot-recovery` → `tag:gotchibot-hub`, TCP 22, and one named non-root account. An administrator defines tag owners and assigns these tags only to the intended devices. Merge the fragment into the existing policy and preserve the Hub API grants. Review other access affected by tagging. Matching `check` rules take precedence over `accept`, so narrow overlapping check rules for the recovery path. An alternative is dedicated-key OpenSSH over Tailscale with a suitably restricted account. Policy changes are performed by the human in the admin console; the wizard verifies SSH reachability, not the entire tailnet policy. See [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh).

## Boot and repair permissions

On Linux/Omarchy the wizard, after confirmation:

1. Enables existing `tailscaled` and (on the Hub) `sshd` system services.
2. Enables lingering for the current user, so user services start without an interactive login.
3. Validates and installs a sudoers fragment allowing only `/usr/bin/systemctl start tailscaled` and, on the Hub, `/usr/bin/systemctl start sshd` without a password. It also sets the current user as Tailscale operator, allowing that account to manage this node's Tailscale settings. These changes have their own confirmation.
4. Installs/enables `~/.config/systemd/user/gotchibot-recovery.service` using the current checkout and Node path.

Inspect with `systemctl --user status gotchibot-recovery.service` and `journalctl --user -u gotchibot-recovery.service`. The recovery unit belongs to the same user as the Hub API/runtime units. On distributions naming SSH `ssh.service`, adapt the system service and exact sudoers command and set `sshService` in the config. The supplied wizard targets Omarchy's `sshd`.

On macOS the wizard installs a recurring LaunchAgent and explicitly reports login-level startup. Pre-login operation needs a separately reviewed system Tailscale daemon and LaunchDaemon arrangement. A user LaunchAgent cannot unlock FileVault or run before login. See [Tailscale unattended operation](https://tailscale.com/docs/how-to/run-unattended). Persistent Serve mappings use `--bg`; see [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Configuration

`config/recovery.json` is local and ignored by git. Example for an Omarchy Hub:

```json
{
  "role": "hub",
  "runtime": "opencode",
  "attempts": 4,
  "backoffMs": 1000,
  "intervalMs": 30000,
  "sshService": "sshd",
  "repairServices": {
    "apiDatabase": { "manager": "systemd-user", "unit": "gotchibot-api.service" },
    "opencode": { "manager": "systemd-user", "unit": "gotchibot-opencode.service" }
  }
}
```

Add `bridge` with its actual service name. Desks persist `sshUser`, optionally `sshIdentityFile`, and `remoteNode` (absolute Hub Node path if it is absent from noninteractive SSH PATH). `healthUrls` adds checks or overrides a named service URL. Local repairs support `systemd-user`, `systemd` (noninteractive sudo), and `launchd` with an exact unit/target. Configure only services this machine owns. Configured repairs are limited to once per minute per service within a running supervisor. Desk checks never restart Hub services remotely.

## Legacy routing

LAN/direct transport selection is legacy. Remote SSH, pairing, bridge and gateway paths require Tailscale by default. `GOTCHIBOT_LEGACY_DIRECT_ROUTING=1` is an explicit compatibility option for interactive legacy clients; recovery ignores it. Existing task/model routing is outside this transport change.

## Validation and remaining deployment

Automated tests cover retry/reconnect order, pairing rejection, partial sync, health failures, service repair/reprobe, short-name startup, Serve ownership, stale readiness, tailnet-only transport, pagination, and wizard confirmation/cancellation/approval retry. They use injected transports and do not reboot machines.

After deploying the checkout and completing setup on each machine, test during a maintenance window: restart the Hub, stop/restart its API and SSH service, disconnect/reconnect a desk, then restart a desk. Confirm every required check is true via `recovery status`, chat/project state catches up, and no pairing step is repeated. A check-mode approval, expired/revoked Tailscale credentials, removed SSH trust, unmounted encrypted disk, unavailable power/network, or missing applications cannot be repaired by pretending authentication or health passed.

The live SSH probe from this desk on 2026-10-04 reached the Hub but required Tailscale browser approval. This change has not been deployed to that Hub or live reboot-tested.
