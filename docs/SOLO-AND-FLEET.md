# Solo and Fleet topology

GotchiBot has two spawn-host topologies. The file `sessions/.topology.json`
(`{ "mode": "solo"|"fleet", "updatedAt": … }`) decides where sub-agents land.
`GOTCHIBOT_TOPOLOGY=solo|fleet` in the env overrides the file.

## Solo (default for new users)

- `spawn --host auto` stays **local**. No Tailscale preference.
- Explicit `--host imac` still probes remote (power users / tests).
- `./scripts/gotchibot setup` writes solo **only on a fresh install**
  (no topology file, no `REMOTE_*` in env). Otherwise it prints status and
  asks you to run `gotchibot topology solo` explicitly. Init also writes solo
  on first successful run when not fleetish — never if `REMOTE_*` is set.

## Fleet (Julius's template)

- MBP / iPhone are clients; the iMac is the always-on orchestrator
  (`opencode serve` + sub-agents over Tailscale SSH).
- `topology=fleet` restores today's behavior: `spawn --host auto` probes
  Tailscale SSH and prefers the iMac when reachable.
- Setup path: `gotchibot remote-setup`, then `gotchibot topology fleet`.
- `gotchibot doctor` adds a fleet-only remote probe (warn, never fail).

## Legacy: no file, no env

Callers keep today's probe-and-prefer-remote behavior — nothing changes on
existing installs until you write the file.

## Models (BYO)

Solo setups use your own keys. `OPENCODE_API_KEY` lives in abra, never in
files. The referral config (`config/opencode.referral.json`) is printed by
`gotchibot doctor` and `gotchibot setup`.

## Where infra lives

- **DigitalOcean** hosts the subgraph + Aarcade API (see DO-INFRA-CUTOVER).
- **Vercel** hosts the SPA only.
- **OpenClaw/OpenCode** stays on your machine. Never on DO.

## Solo install auth

Solo friends run one command after clone:

```bash
./scripts/gotchibot onboard
```

That connects a wallet (MetaMask), registers the install, saves
`GOTCHIBOT_INFRA_TOKEN` in abra, mints the cartridge, and runs doctor.

Julius's desk keeps operator secrets in abra with no install token. Rollout:
[docs/FRIENDS-BETA-ROLLOUT.md](./FRIENDS-BETA-ROLLOUT.md).

**Friends beta:** Julius adds the friend's `0x` to Vercel `GOTCHIBOT_INSTALL_ALLOWLIST`,
then the friend runs `onboard`. Invite / revoke / cost-usage steps live in that
rollout doc. Golden/Silver airdrops and paid Infra Pass are deferred until usage
costs are measured.
