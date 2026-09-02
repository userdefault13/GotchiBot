---
description: Select OpenCode model @claudemode (Hub VS Code Claude via bridge proxy)
---

Ensure the claudemode proxy is up, then switch the OpenCode model.

```bash
./scripts/gotchibot claudemode-proxy --check || ./scripts/gotchibot claudemode-proxy
```

Tell Julius to run in chat:

```
/model @claudemode
```

If `$ARGUMENTS` is a prompt (not just a model switch), after confirming the model
path, one-shot:

```bash
abra run gotchibot -- ./scripts/gotchibot bridge $ARGUMENTS
```

Do not use Tab agent modes for this. Do not invent Claude replies.
