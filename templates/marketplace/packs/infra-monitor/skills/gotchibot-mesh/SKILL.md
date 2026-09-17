---
name: gotchibot-mesh
description: Cross-machine GotchiBot agent status — quick agent count + per-session status across the MBP and iMac orchestrators over Tailscale SSH. Read-only. Use when the user asks "how many agents are running", "what's the agent status on the iMac/MBP", or "is the iMac orchestrator up".
type: skill
---

# gotchibot-mesh

Read-only cross-machine status for the GotchiBot swarm. The MBP orchestrator
already scans the iMac over Tailscale SSH (`agent-focus.mjs scanRemoteSessionsAsync`);
this skill packages that into a compact **count + status** view and a **reachability**
probe. It does NOT spawn or control the peer — status only.

## When to use
- "How many agents are running right now?" / "agent count on MBP vs iMac"
- "What's the status of the iMac agent?" / "is the iMac orchestrator up?"
- "ping the iMac" / "can the MBP reach the iMac?"

## Commands
All route through `./scripts/gotchibot mesh` (which execs `scripts/mesh-status.mjs`):

```
gotchibot mesh                # instant view from sessions/.focus-list.json cache
gotchibot mesh --live         # re-scan the iMac peer over Tailscale SSH (fresh)
gotchibot mesh --json         # machine-readable payload
gotchibot mesh ping           # Tailscale + SSH reachability probe (wraps remote-status.mjs)
```

Run directly (no abra needed if env is local):
```
node scripts/mesh-status.mjs [ping] [--live] [--json]
```

## How it works (reuse, not rebuild)
- `mesh` reads `sessions/.focus-list.json`, which `agent-focus.mjs buildRoster()`
  already maintains. Entries carry a `host` field: `"local"` (MBP) or `"imac"`.
- `--live` re-runs `agent-focus.mjs list` to rebuild that cache via the SSH scan.
- Groups `entries` by `host`, counts by `status` (running/done/failed/…), prints
  MBP and iMac blocks. If the iMac is unreachable, the block shows
  `unreachable — <reason>` and MBP rows still print.

## Prerequisites
Tailscale SSH to the iMac must be configured (same as `gotchibot remote`):
- `REMOTE_HOST` — Tailscale MagicDNS or `100.x` address of the iMac
- `REMOTE_USER` — iMac macOS username
- `SSH_PRIVATE_KEY` — ed25519 key (via abra: `abra keygen ssh gotchibot`)
- iMac: Remote Login on, pubkey in `authorized_keys`, `~/Dev/GotchiBot` present

If any are missing, `mesh ping` reports the exact blockers (same as `remote-status.mjs`).

## JSON schema (`--json`)
```json
{
  "at": "<iso8601 cache time>",
  "remoteReachable": true,
  "hosts": {
    "local": { "label": "MBP", "total": 2, "byStatus": {"running":1,"done":1}, "entries": [...] },
    "imac":  { "label": "iMac", "total": 1, "byStatus": {"done":1}, "reachable": true, "reason": null, "entries": [...] },
    "cartridge": { "heroes": ["owned-954","starter-link-h1-1"] }
  }
}
```

## Notes / limits
- MB<->iMac only (MBP reads iMac). Symmetric or sim-broker transport is future work.
- Status is read-only; to spawn on the iMac use `gotchibot spawn --host imac` or
  `gotchibot remote -- <cmd>`.
- The menu bar plugin (`gotchibot menubar`) reflects the same per-host counts.
