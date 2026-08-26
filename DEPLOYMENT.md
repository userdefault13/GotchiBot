# GotchiBot Deployment Runbook

Test on this MacBook Pro first, then migrate to the home iMac. Both gateways
stay running after migration.

## Topology

| Machine | Role |
|---|---|
| MacBook Pro (M2, 8GB) | Dev/test host now → later: Cursor CLI orchestrator, interactive opencode, abracadabra vault (Touch ID), Envio indexers |
| iMac (`192.168.1.162`) | Always-on OpenClaw gateway in Docker + Cloudflare tunnel + Access; already runs Ollama (`:11434`) |

## Phase 0 — Cloudflare (before iMac migration)

1. Create/verify a Cloudflare account
2. Add a domain to the account (free plan is sufficient)
3. Zero Trust dashboard → create a **named tunnel** for the iMac
4. Create an Access application on `openclaw.<domain>`:
   - Policy: your identity only (One-time PIN or SSO)
   - This gates the hostname before requests ever reach the gateway

## Phase 1 — Repo

```bash
git clone git@github.com:userdefault13/GotchiBot.git ~/Dev/GotchiBot
```

Docs live here; runtime state is gitignored.

## Phase 2 — MBP stack

### 2.1 OrbStack (free for personal use)

```bash
brew install orbstack
docker compose version   # verify v2
```

> Local source builds of OpenClaw need 6GB+ RAM — we always use the prebuilt
> image (~0.35GB compressed arm64), so 8GB machines are fine.

### 2.2 Gotchi data — home Envio via Cloudflare tunnel (no local indexers)

Gotchi data comes from the iMac's self-hosted Envio stack, already exposed
through AarcadeGh-t's existing tunnel. Nothing to run locally:

- Core: `https://subgraph.aarcadeghst.com/subgraphs/name/aavegotchi-core-base`
- SVG:  `https://subgraph.aarcadeghst.com/subgraphs/name/aavegotchi-svg-base`
- Config: `config/subgraph.endpoints.json` (verified working 2026-08-25)

OrbStack is reserved for OpenClaw only. Do not run the
`~/Dev/aavegotchi-envio-indexers` stacks here; if the tunnel is down, check the
iMac (`cloudflared` service) rather than starting local indexers.

### 2.3 OpenClaw gateway container

```bash
cd ~/Dev/openclaw
git clone https://github.com/openclaw/openclaw.git .   # if not already cloned
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./scripts/docker/setup.sh    # onboarding → writes token to .env → starts compose
curl -fsS http://127.0.0.1:18789/healthz   # expect ok
```

Control UI during testing: `http://127.0.0.1:18789/` (paste token from `.env`).

Notes:
- State persists via bind mounts (`OPENCLAW_CONFIG_DIR`, `OPENCLAW_WORKSPACE_DIR`)
- If EACCES errors appear: `chown -R 1000:1000 <config dir>` (image runs as uid 1000)
- Health probes: `/healthz` liveness, `/readyz` deep readiness

## Phase 3 — Identity system

First-run setup (idempotent — safe to rerun):

```bash
./scripts/gotchibot init        # step 1: connects MetaMask via localhost page
abra run gotchibot -- ./scripts/gotchibot init   # step 2: sim-mints cartridge
```

`init` walks through: wallet connect (signature-verified, address-only) →
gotchibot cartridge sim-mint on AarcadeGh-t → roster summary. State lives in
`sessions/.wallet.json` and `sessions/.identity.json`.

Agent identity lifecycle (each sub-agent role):

```bash
gotchibot identity mint / seal / unpack / open / bind / apply   # portals
gotchibot checkpoint <sessionId> <label>                        # milestones
```

See `IDENTITY_SYSTEM.md`. Summary:

1. Register the `gotchibot` cartridge game entry in AarcadeGh-t
   (`GET /rules/gotchibot`)  ✓ done 2026-08-25
2. Service-key auth on cartridge-sim routes  ✓ done (`84da68d3e`)
3. Mint the orchestrator identity (portal open + starter bind), then
   sub-agent identities at spawn time
4. Avatars: official `previewAavegotchi` SVG composition

## Phase 4 — Secrets & models

```bash
abra set gotchibot DEEPSEEK_API_KEY        # hidden input, AES-256-GCM
abra connect cloudflare                    # optional, for later tunnel setup
```

OpenCode provider config (`~/.config/opencode/opencode.json`) gains:

| Tier | Model | Notes |
|---|---|---|
| default | `deepseek-v4-flash` | volume coding work |
| escalation | `deepseek-v4-pro` | hard reasoning tasks |
| fallback | `ollama/deepseek-r1:8b` @ `192.168.1.162:11434` | offline/private |

(`deepseek-chat`/`deepseek-reasoner` aliases retired 2026-07-24 — do not use.)

## Phase 5 — Orchestration runtime

1. Cursor CLI persona/rules for the gotchi orchestrator (`.cursor/`, `AGENTS.md`)
2. Sub-agents: `scripts/opencode-dispatch.sh` spawns parallel headless
   `opencode run` sessions under `sessions/<id>/`
3. You can prompt sub-agents directly: open interactive `opencode` in any tab;
   the gotchi monitors shared session state either way

### 5.5 Terminal avatars (Midnight Commander + chafa)

```bash
brew install midnight-commander chafa tmux
mkdir -p ~/.config/mc && cp config/mc.ext.ini ~/.config/mc/
gotchibot tmux     # mc left | right pane: your gotchi (top), active sub-agent (bottom)
```

- F3 on any `.svg` in mc renders it via chafa
- The avatar pane auto-switches to whichever sub-agent is active
- Pin an agent: `gotchibot avatar <agentId>`

Apple Terminal renders chafa output as ANSI half-blocks — flat Aavegotchi art
looks good; no graphics protocol needed.

## Phase 6 — Context engine

- `scripts/unify-md.sh` (cron): scans project dirs → per-project `KNOWLEDGE.md`
- Handoff: summarize prior transcript + relevant KNOWLEDGE.md → `HANDOFF.md`
  seeds new sessions; checkpoints also written to the cartridge

## Phase 7 — Skills registry

- `skills/registry.json` seeded with abracadabra + entries from
  `~/Dev/aavegotchi-agent-skills`
- Agents request missing skills → you approve/deny → registry updates
- Nothing installs autonomously, ever

## Phase 8 — Voice (opt-in)

- TTS personas configured per agent in `config/tts.personas.json5`
- Global auto-TTS stays OFF; enable per session with `/tts chat on`
- Starter provider: Edge TTS (free, no key); upgrade path to ElevenLabs/OpenAI

## Phase 9 — Verify locally

End-to-end test checklist:

- [ ] Prompt gotchi → it fans out ≥2 parallel sub-agents on real tasks
- [ ] Monitor progress; results merge correctly
- [ ] Direct-prompt a sub-agent yourself while gotchi watches
- [ ] Skill request surfaces → approve → next spawn includes it
- [ ] Handoff: end session, start new one, confirm context carried over
- [ ] Avatar pane switches with active agent
- [ ] `openclaw security audit --deep` clean

## Phase 10 — iMac migration

```bash
# on MBP: package state
tar czf gotchibot-state.tgz -C ~ .openclaw Dev/GotchiBot/sessions

# on iMac (same steps as Phase 2):
brew install orbstack   # or Docker Desktop
# restore state dirs with ownership uid 1000
# run scripts/docker/setup.sh with OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
```

Then:

1. Install `cloudflared` on the iMac; attach the named tunnel from Phase 0
2. Route `openclaw.<domain>` → `http://openclaw-gateway:18789`
3. Confirm Cloudflare Access policy is active (strangers never reach the UI)
4. Pair the MBP as an **OpenClaw node** so the remote gateway can still drive
   local Cursor/opencode sessions
5. Verify end-to-end from cellular (not LAN)
6. Keep both gateways running; sync `sessions/` + workspace dirs as needed

## Troubleshooting

| Symptom | Fix |
|---|---|
| `openclaw: permission denied` on mounted dirs | `chown -R 1000:1000 <dir>` |
| Gateway unhealthy | `curl http://127.0.0.1:18789/healthz`; check `docker compose logs openclaw-gateway` |
| Control UI "Unauthorized" | `docker compose run --rm openclaw-cli dashboard --no-open`; approve device |
| Envio Hasura down | `cd ~/Dev/aavegotchi-envio-indexers && npm run docker:core`; port conflicts: see `.env.example` (core uses 8082 because gotchi-world takes 8080) |
| Cursor CLI flag drift | pin/probe `agent --version`; flags change between releases |
| DeepSeek 400 on model id | use `deepseek-v4-flash` / `deepseek-v4-pro`; old aliases dead since 2026-07-24 |
| chafa looks bad | increase cols (`--cols $(tput cols)`); Apple Terminal limits fidelity |
