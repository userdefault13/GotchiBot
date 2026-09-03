---
name: colabo
description: >-
  In an open GotchiBot meeting, one user prompt → every invited agent replies
  (Colabo round). Load for /colabo, meet colabo, all-hands opinions.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: meet
---

# Colabo

One prompt, all agents answer inside the open meeting transcript.

```bash
./scripts/gotchibot meet colabo "Should we ship the trader retune today?"
# meet room:
/colabo Should we ship the trader retune today?
```

Requires an **open meeting** with agent participants (`invite` / `invite all`).

Replies are posted as `[colabo · <hero>]` turns. Prefer OpenClaw chat; falls back to a short local spawn if gateway/quota fails.

## MCP

`gotchibot-meet` → `meet_colabo`

## Forbidden

- Running Colabo outside a meeting (start `/meet` first)
- Inventing agent opinions without the script
