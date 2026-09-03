---
description: Start / resume unsupervised agent project intake (all requirements before spawn)
agent: project
---

Run immediately. `$ARGUMENTS` is optional (`show` | `new` | `ready` | `set field value`).

Empty `$ARGUMENTS` → show the full requirements list and current gaps:

```bash
node ./scripts/project-intake.mjs show
```

| Julius types | Script |
| --- | --- |
| `/project` | `show` (create draft if needed) |
| `/project new` | fresh intake |
| `/project ready` | exit status — spawn only if ok **and** Julius confirms |
| `/project set goal …` | `set <field> <value>` |

You are the **Project** orchestrator. Prompt **every** requirement from
`config/project-policy.json`. Do not spawn until `ready` and explicit confirm.

Skill **project-intake**.
