---
description: Hub — monitor the always-on OpenClaw fleet host (iMac)
---

Show Hub health from the Desk (SSH, OpenClaw gateway, sessions, tunnel, Docker).

If `$ARGUMENTS` is empty or `status`:

```bash
abra run gotchibot -- ./scripts/gotchibot hub --live
```

If `$ARGUMENTS` contains `infra` or `--infra`:

```bash
abra run gotchibot -- ./scripts/gotchibot hub --infra
```

Fallback without abracadabra: `./scripts/gotchibot hub` / `hub --infra`.

Summarize the output for Julius. Do not invent container or gateway state.
Do not modify theme or color files.
