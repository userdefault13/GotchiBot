---
name: colabo
description: >-
  In an open GotchiBot meeting, one user prompt → invited agents reply (Colabo).
  Prefer --ring for CoS rounds (design = architect + optional infra-monitor).
  Load for /colabo, meet colabo, scoped opinion rounds — not default all-hands.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: meet
---

# Colabo

One prompt, agents in the room answer. **CoS prefers named rings** over all-hands.

```bash
# Design ring (recommended for architecture / topology asks)
./scripts/gotchibot meet colabo --ring design "Should we keep Envio on the M1?"

# Bare (legacy): if the room is empty, invites everyone — avoid for CoS
./scripts/gotchibot meet colabo "Should we ship the trader retune today?"
```

Meet room: `/colabo --ring design …` when supported; else CLI above.

## Rings (`config/colabo-rings.json`)

| ring | who replies | when |
|---|---|---|
| `design` | `architect` (required), `infra-monitor` (optional) | topology, options matrix, structure |

CoS (`owned-954`) chairs the meet and does **not** reply as an agent in the round.
Default path for CoS remains **delegate-first / inbox / graph** — Colabo only for real opinion rounds.

Requires an **open meeting**. Replies: `[colabo · <hero>]`. Model policy scope: `colabo`.

## MCP

`gotchibot-meet` → `meet_colabo` (pass ring when the tool supports it)

## Forbidden

- Running Colabo outside a meeting
- CoS defaulting to bare all-hands for design asks
- Inventing agent opinions without the script
