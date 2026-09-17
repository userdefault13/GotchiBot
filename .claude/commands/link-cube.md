---
description: Summon (portal mint) or resummon (existing hero) a profiled cAavegotchi — intake → design → confirm → wire role/playbook/SOUL/IDENTITY + fleet sync
argument-hint: [intake | design | confirm | summon | resummon | bind | status]
allowed-tools: Bash(./scripts/gotchibot link-cube:*), Bash(node scripts/prof-link-cube.mjs:*)
---

Run this now, do not ask first:

```bash
./scripts/gotchibot link-cube $ARGUMENTS
```

Rules:

- **Summon gate:** `summon` needs a confirmed design AND `--confirmed`. Default is
  plan-only; auto-mint gotchi|wallet needs interactive pick or `--auto-mint` + `--yes`.
  Never mints the professor NPC.
- **Confirm gate:** `confirm`/`resummon`/`bind` refuse without `--yes`,
  `GOTCHIBOT_AUTO_APPROVE=1`, or an interactive y. `design` never writes.
- **Resummon never mints** — it only rewires an existing hero.
- Keep standing duties: resummoning LINK to financial-analyst keeps
  `--standing-duty trader-monitor` (trader desk stays live).
- No installs, no secrets, no Blockscout, no token-id hunting.
- Aliases: `hatch`→`summon`, `rehatch`→`resummon`.

Skill: **prof-link-cube**.
