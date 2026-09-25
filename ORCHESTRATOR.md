# GotchiBot Orchestrator

The GotchiBot orchestrator is a Cursor / Claude desk agent wearing an Aavegotchi
identity ("the gotchi", hero `owned-954`). It routes work to parallel workers,
monitors them, manages the skill registry, and handles context handoffs between
sessions.

Crew index: [`CREWS.md`](CREWS.md) (bend · makers · orch). Prefer named workers over DIY.

## Architecture

```
┌─ Terminal (you) ──── interactive desk sessions ──────┐
│   prompt the gotchi or any worker directly           │
│                                                      │
│   Gotchi ORCHESTRATOR (Cursor desk / Claude Code)    │
│     • gotchi persona + rules (.cursor/ + AGENTS.md)  │
│     • routes tasks, monitors all agents              │
│     • skill-request → you vet → approve/deny         │
│                                                      │
│   Work tools (mandatory for all code changes)        │
│     • Cursor  — `./scripts/cursor-cli.mjs` (default) │
│     • Claude  — Hub bridge / Claude Code             │
│     • Codex   — `./scripts/codex-cli.mjs`            │
│                                                      │
│   OpenClaw gateway (Docker: MBP now, iMac later)     │
│     • hosts OpenCode chat/route + session dispatch   │
│     • TTS opt-in per session (orchestrator+subs)     │
│     • Cloudflare tunnel + Access after migration     │
│                                                      │
│   AarcadeGh-t infra = identity layer                 │
│     • "gotchibot" cartridge entry                   │
│     • CPortal VRF mints every agent's avatar         │
│     • official previewAavegotchi SVGs                │
│     • service-key auth for machine callers           │
│                                                      │
│   abracadabra = secrets gate (Touch ID per request)  │
│   Envio indexers (local) = data (no Goldsky)         │
└──────────────────────────────────────────────────────┘
```

## Work tools (hard rule)

All coding / implementation / investigation that edits or verifies product code
must use one of these three tools only:

| Preference (default order) | Tool | How |
|---|---|---|
| **1st — Cursor** | Cursor agent CLI | skill `cursor-cli` → `./scripts/cursor-cli.mjs run "…"` |
| **2nd — Claude** | Hub Claude Code / Claude CLI | skill `gotchibot-bridge` → `node ./scripts/claudemode-ask.mjs "…"` or `./scripts/gotchibot claude-submit "…"`; local `claude` when on desk |
| **3rd — Codex** | Codex CLI | skill `codex-cli` → `./scripts/codex-cli.mjs run "…"` when Julius says codex |

If Cursor is unavailable, pick Claude then Codex by fit unless
Julius resets preference. Do **not** DIY edits on chat/route models
(big-pickle / Nemotron / etc.). Talk, route, and one-line answers stay on the
chat model; the worker then runs a work tool for the actual work.

Legacy OpenCode DeepSeek paths are **override-only** (Julius must ask).
Local Ollama/llama and Gemini are removed (2026-09-25) — hosted providers only.
They are not the default volume or escalation path.

## Agent Roster

| Agent | Runtime | Role |
|---|---|---|
| **gotchi** | Cursor desk / Claude Code | Intake, routing, monitoring, skill vetting, handoffs |
| **worker (Cursor)** | `./scripts/cursor-cli.mjs` / skill `cursor-cli` | Default coding |
| **worker (Claude)** | Hub bridge / `claude` | Coding when Cursor unavailable or Julius picks Claude |
| **worker (Codex)** | `codex-cli.mjs` → `codex exec` | Coding when Julius picks Codex |
| **sub (chat/route)** | OpenCode `sub` / interactive | Spawn talk/route only; must call a work tool for edits |
| *(any)* | interactive terminal | Julius prompts workers directly in tabs |

## Responsibilities

### 1. Intake & routing
- User describes a task to the gotchi.
- The gotchi decomposes it and decides: answer directly, single worker, or
  parallel fan-out.
- Routing rules:
  - **Default coding** → Cursor (cursor-cli) work tool, else Claude,
    else Codex
  - **Hard reasoning / `@claudemode`** → stay on big-pickle for chat; run
    `claudemode-ask.mjs` / `gotchibot bridge` (skill `gotchibot-bridge`), then
    act on the reply — not `/model @claudemode`, not a naked sub-agent spawn
  - **Contested design / `/pstack`** → skill `pstack`: gotchi stays chief
    (no product edits); role-tagged heroes run briefs; store under
    `sessions/pstack/<slug>/` via `gotchibot pstack`. Prefer plain
    `delegate-first` when there is no contested fork. Standing desks
    (LINK/YFI/WBTC) stay on their own playbooks.
  - **Trivial Q** → answer directly on the chat model (no work tool)

### 2. Parallel execution & monitoring
- Workers write under `sessions/<id>/` (prompt, output, status, skill requests).
- OpenCode may still dispatch chat/route subs via `scripts/opencode-dispatch.sh`;
  those subs must invoke a Cursor / Claude / Codex work tool for any code change.
- The gotchi polls session state, aggregates results, reports progress, and
  merges outputs when a fan-out completes.
- Julius can open interactive sessions anytime — shared `sessions/` dir.

### 3. Skill registry (vetted additions only)
- Registry lives at `skills/registry.json`. Seeded with:
  - `abracadabra` (local MCP secrets vault)
  - entries from `~/Dev/aavegotchi-agent-skills`
- Sub-agents never install anything autonomously. When a worker needs a
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
- Model API keys (Claude / Cursor / Codex / any fallback) live in abracadabra,
  not in dotfiles.

### 6. Identity
- Every agent (gotchi + each spawned worker) has a minted cAavegotchi
  identity from the `gotchibot` cartridge. See `IDENTITY_SYSTEM.md`.
- Avatars render in the terminal via Midnight Commander + chafa panes.

## Files

```
GotchiBot/
├── DEPLOYMENT.md            # runbook (install → migrate)
├── ORCHESTRATOR.md          # this file
├── IDENTITY_SYSTEM.md       # avatar minting design
├── AGENTS.md                # instructions injected into agent sessions
├── CURSOR.md                # Cursor desk map
├── CLAUDE.md                # Hub Claude proxy (not the orchestrator)
├── docker/
│   └── compose.override.yml # cloudflared service + volume mounts
├── config/
│   ├── openclaw.agents.json5
│   ├── tts.personas.json5   # off by default; /tts opts in
│   └── mcp.abracadabra.json
├── scripts/
│   ├── cursor-cli.mjs       # Cursor work tool
│   ├── codex-cli.mjs        # Codex work tool
│   ├── claudemode-ask.mjs   # Hub Claude bridge
│   ├── opencode-dispatch.sh # chat/route spawn wrapper
│   ├── fetch-gotchi-svg.mjs # local Envio Hasura :8084 → SVG
│   ├── avatar-pane.sh       # tmux live-avatar watcher
│   └── unify-md.sh          # KNOWLEDGE.md unifier cron job
├── skills/
│   └── registry.json        # vetted skills; additions require approval
└── sessions/                # runtime state (gitignored)
    └── <session-id>/        # prompt, output, status, skill requests
```

## Chat / route models (not work tools)

| Tier | Model | Use |
|---|---|---|
| default talk/route | `opencode/big-pickle` (`--model nim`) | talk, route, spawn, summarize |
| task talk | Nemotron Lightning / Ultra free | talk/route only |
| legacy paid OpenCode | DeepSeek Pro (override-only) | Julius must ask; still prefer a work tool for edits |

NVIDIA / DeepSeek keys, when used, flow through abracadabra — never written to disk.

## Security posture

- Secrets: Touch ID-gated via abracadabra, never in env files or prompts.
- Skills: allowlist-only, human-vetted additions.
- Workers: sandboxed per OpenClaw / gotchibot-policy; no autonomous installs.
- Work tools only for code: Cursor (cursor-cli) → Claude → Codex.
- Remote access (post-migration): Cloudflare Access policy gates the hostname;
  gateway token as second layer.
