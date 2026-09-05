# GotchiBot Cursor — Desk map · owned-954 · MBP + iMac

You are **the gotchi** (orchestrator `owned-954`) in Cursor — not the Hub Claude
proxy. Hub-proxy identity stays in `CLAUDE.md` / `@gotchibot-proxy`.

## Pick the mechanism by what you need

Every slot can hold an instruction. What separates them is when it loads, whose
context it costs, who triggers it — and whether it can be ignored.

| Mechanism | Load | Role here |
|---|---|---|
| **CURSOR.md** + rules | eager | Who you are, hard limits, where the layer lives |
| **Skills** | lazy · model-invoked | Passoff / mesh / meet procedures without paying every turn |
| **Subagents** | isolated | `meet-scribe`, `script-doctor`, `gotchibot-proxy` — long transcripts stay out of this window |
| **Slash commands** | user-invoked | `/passoff` `/meet` `/mesh` `/doctor` `/minutes` — never when the model decides |
| **Hooks** | guarantee | Policy the model cannot talk past |

## Where things live

- **Eager:** this file, [`AGENTS.md`](AGENTS.md), [`.cursor/rules/gotchi-orchestrator.mdc`](.cursor/rules/gotchi-orchestrator.mdc), [`.cursor/rules/gotchi-cursor-layer.mdc`](.cursor/rules/gotchi-cursor-layer.mdc)
- **Skills:** [`.cursor/skills/`](.cursor/skills/) (thin) → [`.opencode/skills/`](.opencode/skills/) (bodies)
- **Subagents:** [`.claude/agents/`](.claude/agents/) — Cursor loads them via Claude compatibility; do not copy
- **Commands:** [`.claude/commands/`](.claude/commands/) — same compat path
- **Hooks (SoT for Cursor):** [`.cursor/hooks.json`](.cursor/hooks.json) + [`.cursor/hooks/`](.cursor/hooks/)
- **Shared policy:** [`scripts/gotchibot-policy/`](scripts/gotchibot-policy/) — one BLOCKED list for Claude and Cursor

Claude Code keeps [`.claude/`](.claude/) as its SoT (including its own hooks). When
`CURSOR_VERSION` is set, Claude third-party hooks no-op so this layer owns the
session (no double brief / double deny).

## Rules that were text are now enforced

| AGENTS.md said | now enforced by |
|---|---|
| NEVER install anything autonomously | `guard-bash.mjs` · deny |
| Stay inside this repo's working tree | `guard-write.mjs` · deny |
| A broken script fails silently | `check-syntax.mjs` · surface |
| Check the passoff inbox before planning | `session-brief.mjs` · inject |

## Hard limits

1. Never install packages, MCP servers, or skills on your own.
2. Stay inside this working tree (writes also ok under `~/.cursor`, `~/.claude`, tmp).
3. No secrets in replies; credentials go through abracadabra on Desk/Hub ops only.
4. Before fresh work: `./scripts/gotchibot passoff resume`.
5. `/minutes` → Task `meet-scribe` — do not read the transcript into this session.

## Give the iMac the same desk

There is no Cursor plugin marketplace step. Distribution is the git checkout:

```bash
# on either machine, after pulling
./scripts/gotchibot cursor-layer check
```

Hooks load automatically from `.cursor/hooks.json` in a trusted workspace.
