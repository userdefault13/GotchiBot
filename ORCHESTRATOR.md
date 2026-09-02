# GotchiBot Orchestrator

The GotchiBot orchestrator is a Cursor CLI agent wearing an Aavegotchi identity
("the gotchi"). It routes work to parallel sub-agents, monitors them all,
manages the skill registry, and handles context handoffs between sessions.

## Architecture

```
┌─ Terminal (you) ──── interactive opencode sessions ──┐
│   prompt any agent directly                          │
│                                                      │
│   Cursor CLI = Gotchi ORCHESTRATOR                   │
│     • gotchi persona + rules (.cursor/ + AGENTS.md)  │
│     • routes tasks, monitors all agents              │
│     • skill-request → you vet → approve/deny         │
│                                                      │
│   OpenClaw gateway (Docker: MBP now, iMac later)     │
│     • hosts OpenCode sub-agent dispatch              │
│     • DeepSeek tiers: Flash → Pro esc → R1 fallback  │
│     • TTS opt-in per session (orchestrator+subs)     │
│     • Cloudflare tunnel + Access after migration     │
│                                                      │
│   AarcadeGh-t infra = identity layer                 │
│     • "gotchibot" cartridge entry                    │
│     • CPortal VRF mints every agent's avatar         │
│     • official previewAavegotchi SVGs                │
│     • service-key auth for machine callers           │
│                                                      │
│   abracadabra = secrets gate (Touch ID per request)  │
│   Envio indexers (local) = data (no Goldsky)         │
└──────────────────────────────────────────────────────┘
```

## Agent Roster

| Agent | Runtime | Model | Role |
|---|---|---|---|
| **gotchi** | Cursor CLI | (orchestrator persona; model per `.cursor` config) | Intake, routing, monitoring, skill vetting, handoffs |
| **sub-coder** | `opencode run` headless | `deepseek/deepseek-v4-flash` | Volume coding tasks |
| **sub-hard** | `opencode run` headless | `deepseek/deepseek-v4-pro` | Escalation: hard reasoning/coding |
| **sub-local** | `opencode run` headless | `ollama/deepseek-r1:8b` on iMac | Offline/private fallback |
| *(any)* | interactive `opencode` | user's choice | You prompt sub-agents directly in terminal tabs |

## Responsibilities

### 1. Intake & routing
- User describes a task to the gotchi.
- The gotchi decomposes it and decides: single sub-agent, parallel fan-out, or
  answer directly.
- Routing rules:
  - Default coding tasks → `sub-coder` (V4 Flash)
  - Tasks flagged hard (multi-step reasoning, architecture, gnarly bugs) →
    escalate to `sub-hard` (V4 Pro)
  - API unavailable or user marks task private → `sub-local` (R1 on iMac Ollama)
  - **`/model @claudemode`** → Hub VS Code Claude via Desk proxy `:45680`
    (skill `gotchibot-bridge`) — not a Tab agent mode / not a sub-agent spawn

### 2. Parallel execution & monitoring
- Sub-agents are spawned via `scripts/opencode-dispatch.sh`, one process per
  task, each writing output under `sessions/<id>/`.
- The gotchi polls running sessions (`sessions/` state files), aggregates
  results, reports progress, and merges outputs when a fan-out completes.
- You can open your own interactive `opencode` session at any time — the
  gotchi sees externally-created sessions too (shared `sessions/` dir).

### 3. Skill registry (vetted additions only)
- Registry lives at `skills/registry.json`. Seeded with:
  - `abracadabra` (local MCP secrets vault)
  - entries from `~/Dev/aavegotchi-agent-skills`
- Sub-agents never install anything autonomously. When a sub-agent needs a
  skill that isn't approved, it files a request through its session state →
  the gotchi surfaces it to you → you approve/deny → only then is it injected
  into future spawns.

### 4. Context engine
- **Unifier**: cron job scans project dirs for `*.md` (AGENTS.md, plans,
  notes), dedupes into a per-project `KNOWLEDGE.md`.
- **Handoff**: before starting any new agent session, the gotchi summarizes
  the prior session transcript + relevant `KNOWLEDGE.md` sections into a
  `HANDOFF.md`, which seeds the new session's first prompt.
- Handoff summaries are also written back to the cartridge as checkpoints
  (inspectable in AarcadeGh-t dashboards).

### 5. Secrets via abracadabra
- All credentials flow through `abra mcp` (`get_secrets` / `generate_wallet`).
- Every request pops a Touch ID dialog naming the requesting agent.
- `DEEPSEEK_API_KEY` lives in abracadabra, not in dotfiles.

### 6. Identity
- Every agent (gotchi + each spawned sub-agent) has a minted cAavegotchi
  identity from the `gotchibot` cartridge. See `IDENTITY_SYSTEM.md`.
- Avatars render in the terminal via Midnight Commander + chafa panes.

## Files

```
GotchiBot/
├── DEPLOYMENT.md            # runbook (install → migrate)
├── ORCHESTRATOR.md          # this file
├── IDENTITY_SYSTEM.md       # avatar minting design
├── AGENTS.md                # instructions injected into agent sessions
├── docker/
│   └── compose.override.yml # cloudflared service + volume mounts
├── config/
│   ├── openclaw.agents.json5
│   ├── tts.personas.json5   # off by default; /tts opts in
│   └── mcp.abracadabra.json
├── scripts/
│   ├── opencode-dispatch.sh # parallel headless spawn wrapper
│   ├── fetch-gotchi-svg.mjs # local Envio Hasura :8084 → SVG
│   ├── avatar-pane.sh       # tmux live-avatar watcher
│   └── unify-md.sh          # KNOWLEDGE.md unifier cron job
├── skills/
│   └── registry.json        # vetted skills; additions require approval
└── sessions/                # runtime state (gitignored)
    └── <session-id>/        # prompt, output, status, skill requests
```

## Model tiers (DeepSeek)

| Tier | Model ID | Input $/M | Output $/M | Use |
|---|---|---|---|---|
| default | `deepseek-v4-flash` | 0.14 | 0.28 | routine coding |
| escalation | `deepseek-v4-pro` | 0.435 | 0.87 | hard reasoning |
| fallback | `deepseek-r1:8b` (Ollama on iMac) | free | free | offline/private |

> Note: `deepseek-chat`/`deepseek-reasoner` aliases were retired 2026-07-24.
> DeepSeek has signaled a future price increase; verify rates before relying
> on the table above.

## Security posture

- Secrets: Touch ID-gated via abracadabra, never in env files or prompts.
- Skills: allowlist-only, human-vetted additions.
- Sub-agents: sandboxed per OpenClaw tool policy; no autonomous installs.
- Remote access (post-migration): Cloudflare Access policy gates the hostname;
  gateway token as second layer.
