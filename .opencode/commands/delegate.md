---
description: Pick the next available local/remote cAavegotchi agent (delegate-first)
agent: gotchi
---

Run the delegate-first picker and follow its action. Do not start implementing the
user's task yourself until you have assigned it.

```bash
abra run gotchibot -- ./scripts/delegate-pick.mjs $ARGUMENTS
```

If abracadabra is unavailable:

```bash
./scripts/delegate-pick.mjs $ARGUMENTS
```

Use `--json` when you need machine-readable output:

```bash
abra run gotchibot -- ./scripts/delegate-pick.mjs --json $ARGUMENTS
```

Then:
- `action=chat` → `./scripts/agent-focus.mjs chat "…"`
- `action=spawn` → run `focusFirst` if printed, then the printed spawn `command`
  (when `host=imac` this is Tailscale SSH — do not substitute a local spawn)
- `action=blocked` → tell the user the gate fix; do not DIY

Prefer iMac when the picker says so. Load skill **delegate-first**.
