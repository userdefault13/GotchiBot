---
name: delegate-model
description: >
  Ensures sub-agent delegation follows a model priority chain:
  GLM 5.2 → Grok 4.6 → GPT 5 → cursor-cli → Nemotron fallback.
  When delegating a task to a sub-agent, the orchestrator resolves the
  best available model instead of defaulting to Nemotron immediately.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

# Sub-Agent Model Priority

When you delegate a task to a sub-agent (via `gotchi-orchestrate.mjs spawn`,
`opencode-dispatch.sh new`, `agent-focus.mjs chat`, `gotchi-multitask.mjs run`,
or `remote-spawn.mjs`), the sub-agent's model is now resolved according to
this priority chain:

1. **GLM 5.2** (`opencode-go/glm-5.2`) — first preference when OpenCode Go key is present
2. **Grok 4.6** (`opencode-go/grok-4.6`) — second preference
3. **GPT 5** (`opencode-go/gpt-5.6-luna`) — third preference
4. **cursor-cli** — before falling to Nemotron, pass the prompt through the
   cursor-cli skill (`./scripts/cursor-cli.mjs run "<prompt>"`) and work off
   the cursor-agent's output. The agent's session output is written to
   `sessions/c<id>/output.md`; resume via `cursor-cli.mjs resume "<chatId>"`.
5. **Nemotron fallback** (`opencode/nemotron-3.5-lightning-free`) — used when
   no OpenCode Go key is present, no premium models are available, or the
   cursor-agent binary is not installed/logged-in.

## How the chain is enforced

The `sub` model alias (added to `model-auto.mjs`) resolves the chain
automatically:

- **`--model sub`** (or default, since spawn now defaults to `sub`):
  - If OpenCode Go key (`OPENCODE_API_KEY`) is present → first available of
    GLM 5.2, Grok 4.6, GPT 5.6-luna (from `config/models.auto.json`
    `subagentPrefer` list).
  - If no Go key → check if `$HOME/.local/bin/cursor-agent` exists and is
    functional → route to **cursor-cli** (run `./scripts/cursor-cli.mjs run
    "<prompt>" --cwd <cwd>`).
  - If cursor-agent also unavailable → spawn on Nemotron
    (`opencode/nemotron-3.5-lightning-free`).

- **Explicit `--model <id>`** (e.g. `--model nim`, `--model pro`,
  `--model local`, or a full provider/model ID) bypasses the chain and uses
  the specified model directly (power-user override).

- **`--model auto`** also triggers the subagent chain (backward-compatible
  with existing callers that pass `auto`).

The resolution runs `node scripts/model-auto.mjs subagent --json`, which
outputs a JSON object like:
```json
{"route":"spawn","model":"opencode-go/glm-5.2","reason":"subagent-prefer"}
```
or `{"route":"cursor-cli","reason":"cursor-available"}` or
`{"route":"spawn","model":"opencode/nemotron-3.5-lightning-free","reason":"subagent-fallback"}`.

## Configuration

Edit `config/models.auto.json` to adjust the priority:

```json
"subagentPrefer": [
  "opencode-go/glm-5.2",
  "opencode-go/grok-4.6",
  "opencode-go/gpt-5.6-luna"
],
"subagentFallback": "opencode/nemotron-3.5-lightning-free"
```

- `subagentPrefer`: order of premium models to try (Go key required).
- `subagentFallback`: model used when no premium model is available.

## Usage

**Delegating a task (orchestrator spawn):**

```bash
# Default — resolves via the priority chain:
gotchi-orchestrate.mjs spawn "Write a test suite for the trader"

# Explicit model (bypass chain):
gotchi-orchestrate.mjs spawn --model nim "…"

# On iMac via Tailscale (if reachable):
GOTCHIBOT_SPAWN_HOST=imac gotchi-orchestrate.mjs spawn "…"
```

**Focus/chat escalation (sub focus):**

```bash
./scripts/agent-focus.mjs chat "User task…"
```

This now uses `--model sub` internally (per the agent-focus updates).

**Parallel tasks (multitask):**

```bash
gotchi-multitask.mjs run --tasks "task A" "task B" "task C"
```

Tasks default to model `sub`; override with `--model sub` or `--model nim`.

## Skill loading

This skill is auto-loaded by OpenCode when any delegation/spawn operation
occurs. It does not need explicit `load skill` invocation — it is part of
the orchestrator's default skill set (like `delegate-first`).

If you need to tune the model order, edit `config/models.auto.json` and
restart the orchestrator (or run `gotchi-orchestrate.mjs gate` to re-evaluate).

## Exceptions (answer yourself, no delegate needed)

- One-sentence factual answer, clarifying question, or session status query.
- User explicitly says `"you answer"` / `"don't spawn"` / Ask mode.
- No file edits, no installs, no long investigation required.

## Model tiers (unchanged for the orchestrator itself)

The orchestrator's own talk/route model stays on `opencode/nemotron-3.5-lightning-free`
(pinned via `sessions/.gotchi-model.env`). This skill only governs **sub-agent
delegation**, not the orchestrator's personal model.