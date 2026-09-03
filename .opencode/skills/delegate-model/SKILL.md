---
name: delegate-model
description: >
  Ensures sub-agent delegation follows a free OpenCode Zen priority chain:
  big-pickle → mimo → lightning → ultra, then optional cursor-cli.
  When delegating a task to a sub-agent, the orchestrator resolves the
  best available free Zen model instead of paid OpenCode Go by default.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

# Sub-Agent Model Priority

**Policy:** skill **model-policy** / `config/model-policy.json` (`working-models-only`).
This skill is the spawn-chain detail; policy is the hard rule for all scopes.

When you delegate a task to a sub-agent (via `gotchi-orchestrate.mjs spawn`,
`opencode-dispatch.sh new`, `agent-focus.mjs chat`, `gotchi-multitask.mjs run`,
or `remote-spawn.mjs`), the sub-agent's model is resolved according to
this priority chain (free OpenCode Zen first):

1. **big-pickle** (`opencode/big-pickle`) — default free Zen (fast, reliable)
2. **MiMo free** (`opencode/mimo-v2.5-free`)
3. **Lightning free** (`opencode/nemotron-3.5-lightning-free`)
4. **Ultra free** (`opencode/nemotron-3-ultra-free`)
5. **cursor-cli** — if no Zen model is usable and `cursor-agent` is installed
6. **Fallback** — `subagentFallback` in `config/models.auto.json` (big-pickle)

Paid OpenCode Go models (`opencode-go/*`) are **not** the default sub-agent
path. Use `--model go` / an explicit `opencode-go/...` id when Julius wants Go.

## How the chain is enforced

The `sub` model alias resolves the chain via `node scripts/model-auto.mjs subagent`:

- **`--model sub`** (spawn default): walk `subagentPrefer` (free Zen). Skip
  `opencode-go/*` unless an OpenCode Go key is present.
- **Explicit `--model <id>`** (e.g. `--model nim`, `--model pro`, `--model local`,
  or a full provider/model ID) bypasses the chain.
- **`--model nim` / `pickle` / `fast`** → `opencode/big-pickle`
- **`--model auto`** uses the free `prefer` list (also Zen-first).

Example JSON:
```json
{"route":"spawn","model":"opencode/big-pickle","reason":"subagent-prefer-zen-free"}
```

## Configuration

Edit `config/models.auto.json`:

```json
"subagentPrefer": [
  "opencode/big-pickle",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3-ultra-free"
],
"subagentFallback": "opencode/big-pickle"
```

## Usage

```bash
# Default — free Zen chain:
gotchi-orchestrate.mjs spawn "Write a test suite for the trader"

# Explicit free alias:
gotchi-orchestrate.mjs spawn --model nim "…"

# On iMac via Tailscale:
GOTCHIBOT_SPAWN_HOST=imac gotchi-orchestrate.mjs spawn "…"
```

## Model tiers (orchestrator talk)

Orchestrator talk/route defaults to **`opencode/big-pickle`** (free Zen).
This skill governs **sub-agent** selection; Desk chat-pane uses the same
default unless `GOTCHIBOT_OPENCODE_MODEL` is set.
