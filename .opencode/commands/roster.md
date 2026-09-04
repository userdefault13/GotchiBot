---
description: Legacy CLI alias — prefer /switch modal for @LINK @WBTC roster
---

**Prefer `/switch`** — it opens the cAavegotchi roster modal (`@LINK`, `@WBTC`, …).

This command is the headless CLI path if the modal is unavailable.

## No argument — list everyone

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch
```

## With argument — switch now

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch $ARGUMENTS
```

After switch: avatar pinned, further messages →
`./scripts/agent-focus.mjs chat --sub "…"`, `/orch` to return.
Do not invent agents.

OpenCode Tab agents (Gotchi / Sandbox / …) stay on **`/agents`**.
