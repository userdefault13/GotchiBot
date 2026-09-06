---
name: infra-recover
description: Recovery runbook for home iMac Docker/subgraph/tunnel infrastructure — detect and restart failed Docker containers (esp. aavegotchi-monolith-base-graphql-proxy-1 on :8787), the AarcadeGh-t subgraph gateway, Cloudflare tunnel (cloudflared), and Hasura. Use when the subgraph is unreachable, the tunnel is down, or Docker containers are exited/unhealthy.
type: skill
---

# infra-recover

Home-stack recovery runbook. The iMac runs the Aavegotchi data plane: a Docker
monolith (graphql-proxy on :8787), the AarcadeGh-t subgraph gateway (exposed via
Cloudflare tunnel at `subgraph.aarcadeghst.com`), `cloudflared`, and Hasura. This
skill is the **paper-only, non-destructive** path to bring it back when a piece
falls over.

## Scope
- **Docker containers on the iMac** — especially
  `aavegotchi-monolith-base-graphql-proxy-1` (the :8787 GraphQL proxy).
- **Subgraph gateway** — `subgraph.aarcadeghst.com` via the AarcadeGh-t tunnel
  (see `config/subgraph.endpoints.json`). Local equivalent is `127.0.0.1:8787`.
- **Cloudflare tunnel** — `cloudflared` on the iMac (UserDefaultTunnel).
- **Hasura** — if part of the monolith stack.

Out of scope: chain re-indexing from scratch, secret rotation, code deploys,
anything that touches volumes or writes to mainnet.

## Detection
Run from the iMac (where Docker and :8787 live):

```bash
# 1. Container health — find exited / restarting / unhealthy
docker ps -a --format '{{.Names}} {{.Status}}'

# 2. Local subgraph proxy on :8787
curl -sS -m 8 -X POST http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ _meta { block { number } } }"}'

# 3. Tunnel (public reachability)
node scripts/tunnel-health.mjs
```

Interpretation:
- Any container whose status does **not** start with `Up` is a problem
  (e.g. `Exited (1) 2 hours ago`, `Restarting (1) 3 seconds ago`). A status of
  `Up … (unhealthy)` is also flagged — the container is up but failing its probe.
- The :8787 curl should return JSON with `data._meta.block.number`. A Cloudflare
  `530` / non-JSON response means the tunnel or proxy is down.
- `tunnel-health.mjs` exits `0` when the public gateway answers, `1` when down.

## Recovery steps
Work top-down; **verify after each step** before moving on.

1. **Restart the failed container** (only the one that is down):
   ```bash
   docker restart <container_id_or_name>
   ```
   Re-run the `docker ps` check. If it comes back `Up` and healthy, stop here.

2. **If the subgraph is still unreachable**, restart the graphql-proxy container
   specifically (it owns :8787):
   ```bash
   docker restart aavegotchi-monolith-base-graphql-proxy-1
   ```
   Re-run the :8787 curl.

3. **If the tunnel is down** (public `subgraph.aarcadeghst.com` fails but local
   :8787 works), restart cloudflared on the iMac:
   ```bash
   abra run gotchibot -- node scripts/remote-tunnel-restart.mjs
   ```
   This SSHes to the iMac, `launchctl kickstart`s cloudflared, and waits for the
   public tunnel to recover. Verify with `node scripts/tunnel-health.mjs`.

4. **Hasura** — if Hasura is a separate container and down, `docker restart` it
   the same way; it depends on the Postgres it ships with, so restart both if
   Postgres is also exited.

## Escalation
If the stack is **not recovered after 3 restart attempts** (or the tunnel
restart reports "still down after restart"), escalate:
- Append a dated alert to `sessions/infra-alerts.md`:
  ```markdown
  ## <ISO8601> — infra-recover escalation
  - failed checks: <docker|subgraph|tunnel>
  - attempts: 3
  - last error: <message>
  - action: notify orchestrator
  ```
- Notify the orchestrator (`owned-954`) so a human/agent can inspect iMac logs
  (`/Library/Logs/com.cloudflare.cloudflared.err.log`) or home-network QUIC
  blocking (a common cause of tunnel loss).

## Host-level recovery (when restarting containers is not enough)

Everything above restarts **containers**. Sometimes the host is the problem —
Docker Desktop itself is down, or the machine needs a reboot. Two rules decide
what you do next, and knowing which is which is the difference between fixing it
and handing the user a chore.

### You can do these yourself

| Symptom | Action |
|---|---|
| Containers do not come back after a reboot | Docker Desktop's autostart is off. It is a settings key, not a GUI-only checkbox: `~/Library/Group Containers/group.com.docker/settings-store.json` → `"AutoStart": true`. Back the file up first. Docker may rewrite it when it quits, so verify after any Docker restart |
| One container does not come back but others do | Its restart policy. `docker inspect <c> --format '{{.HostConfig.RestartPolicy.Name}}'` — `no` means nothing will ever restart it. `docker update --restart unless-stopped <c>` |
| `docker restart` reports success but `StartedAt` does not move | The container has an unreapable child: *"PID N is zombie and can not be killed"*. Use `docker kill` then `docker start`. The real fix is recreating it with `--init`, which the compose file must set |
| Every `abra` call dies with `Cannot find package '<x>' imported from ~/Dev/abracadabra/dist/index.js` | abracadabra's `node_modules` is missing, which silently takes out SSH to the hub, the fleet and every secret. `cd ~/Dev/abracadabra && npm install --omit=dev`. This is a lockfile restore, not a new dependency, so it is allowed |

### Only the user can do these

- **Reboot the host.** `sudo shutdown -r now` needs a password; there is no
  NOPASSWD rule on the iMac, so no agent — YFI included — can reboot it.
  Reassigning the task to another agent does not help; it hits the same wall.
- Anything needing the login keychain in a non-interactive session (Docker
  credential helper, `abra` on the iMac over SSH).

When you hit one of these, say exactly that: what you already did, the one thing
left, and the literal command. Do not describe an editable config file as
something only a human can change — check whether it is a file first.

## Safety
- **Never delete volumes.** No `docker volume rm`, no `-v` wipes.
- **Never `docker rm -f` without confirming** the container is the failed one.
  Prefer `docker restart`; only remove if a container is wedged AND you have
  confirmed its id/name against `docker ps`.
- **Paper-only.** No mainnet writes, no re-index from genesis, no config edits
  that change data.
- **Secrets via abracadabra only.** If a restart needs a credential (e.g. tunnel
  token), ask the orchestrator to fetch it through abra
  (`abra run gotchibot -- ...`). Never read or log secret values.
- **No autonomous installs.** If a tool is missing, request it; don't `npm i`.
