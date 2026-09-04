---
description: Legacy alias of /roster — list cAavegotchis; optional select to focus
---

**Prefer `/roster` for cartridge heroes.** `/list` is the same roster for
compatibility — do not run both or give parallel instructions.

For OpenCode Tab agents (Gotchi / Sandbox / …), use **`/switch`** (agent modal).

If `$ARGUMENTS` is empty:

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs list
```

If `$ARGUMENTS` is a number or id, route through switch (SUB + direct chat):

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch $ARGUMENTS
```

Fallback without abracadabra: `./scripts/agent-focus.mjs list` / `switch $ARGUMENTS`.

After switch: avatar pinned, further messages →
`./scripts/agent-focus.mjs chat --sub "…"`, `/orch` to return.
Do not invent agents.
