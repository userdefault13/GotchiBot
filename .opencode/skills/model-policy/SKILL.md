---
name: model-policy
description: >-
  Working-models-only policy for GotchiBot. Load when picking models, meeting
  turns, Colabo, spawn --model sub, or fixing gateway-http-402. Enforced by
  scripts/model-policy.mjs + config/model-policy.json.
license: MIT
compatibility: opencode
metadata:
  audience: everyone
  workflow: models
---

# Model policy — working models only

**Hard rule:** always select a **working** model. Cool down 402/429/quota
failures. Do not leave meet/colabo stuck on OpenClaw `openclaw/default`.

Claude is a **tool** (`claudemode` / Hub pane), not the orch model.

## Source of truth

| File | Role |
| --- | --- |
| `config/model-policy.json` | Policy (scopes, openclaw fallback, probe) |
| `config/models.auto.json` | Prefer / skip / subagent chains |
| `scripts/model-policy.mjs` | Enforce + walk candidates |
| `scripts/model-auto.mjs` | Pick + cooldown cache |

```bash
node ./scripts/model-policy.mjs show
node ./scripts/model-policy.mjs pick meet --probe --json
node ./scripts/model-policy.mjs candidates meet
node ./scripts/model-policy.mjs enforce meet
```

## Scopes

| Scope | Primary | OpenClaw |
| --- | --- | --- |
| `meet` | model-auto working chain | fallback only |
| `colabo` | same | fallback only |
| `spawn` | `--model sub` chain | never |
| `orch` / `chat` | prefer + pin | never |

## Caller API

```js
import { completeWithPolicy, pickFor, candidatesFor } from "./model-policy.mjs";

const r = await completeWithPolicy("meet", async (model) => {
  // return { ok, text } or { ok:false, reason:"model-limit" }
});
```

## Do not

- Hard-code a single paid / gateway-default model for meet replies
- Ignore 402 and print `(unreachable: gateway-http-402)` without walking the chain
- Set `GOTCHIBOT_MEET_SKIP_MODEL_AUTO=1` under this policy
- `/model` the orch to Claude — use Claude as a tool

## Related

Skill **delegate-model** — spawn `--model sub` chain details.
