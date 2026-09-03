---
name: claude-pane-proxy
description: >-
  On new Hub VS Code Claude pane init, always set up the GotchiBot Hub proxy
  agent (CLAUDE.md + @gotchibot-proxy). Load when Julius says proxy agent,
  create-agent, Claude has no role, or before first claude_submit on a cold pane.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: desk-hub
---

# Claude pane proxy init (weak-model runbook)

**Do not reason.** New VS Code Claude pane on Hub = always run proxy init.

## Exact command

```bash
abra run gotchibot -- ./scripts/gotchibot claude-pane-init
# or MCP hub_claude_pane_init
# check only:
abra run gotchibot -- ./scripts/gotchibot claude-pane-init --check --json
```

What it writes into the GotchiBot workspace:

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Always-on Hub Claude proxy HARD RULE |
| `.claude/agents/gotchibot-proxy.md` | Named Claude Code subagent `@gotchibot-proxy` |

## Decision table

| Symptom | First command | Then |
| --- | --- | --- |
| New / cold Claude pane | `claude-pane-init` | `claude_submit` / `claude_ask` |
| Julius: “set up proxy agent” / `/create-agent` | `claude-pane-init` | Done (files + identity) |
| “Claude doesn’t know it’s GotchiBot” | `claude-pane-init` | Retry submit |
| Before first long Claude job this session | `claude-pane-init` then `claude_submit` | Collect on wake |

## Identity HARD RULE (copy)

1. Hub Claude is the **proxy**, not orch.
2. **Reports to** assigned hero (`GOTCHIBOT_HERO_ID`) or orch `owned-954`.
3. Pane → Terminal fallback → + headless for Desk text (see **gotchibot-bridge**).
4. Templates live in `config/claude-pane-proxy/`; init copies them.

## Forbidden

- Invent Claude identity / skip init “because headless”
- Say Anthropic extension conflicts with the bridge
- Ask Julius to manually `/create-agent` without running `claude-pane-init`

## Related

- Skill **gotchibot-bridge** — UI + submit/collect
- Skill **hub-sop** — bridge-ensure when pane/bridge down
