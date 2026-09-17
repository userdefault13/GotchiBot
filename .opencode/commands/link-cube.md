---
description: Summon (portal mint) or resummon (existing hero) a profiled cAavegotchi — intake → design → confirm → wire role/playbook/SOUL/IDENTITY + fleet sync
agent: gotchi
---

Run immediately, do not ask. `$ARGUMENTS` is the link-cube subcommand.

```bash
./scripts/gotchibot link-cube $ARGUMENTS
```

| Julius types | What runs |
| --- | --- |
| `/link-cube` | `--help` — the flow |
| `/link-cube intake --job "financial analyst" --non-coding --voice "…" --collateral link --mode resummon --hero starter-link-h1-1` | collect prefs |
| `/link-cube design` | print draft playbook + SOUL + IDENTITY + title (writes nothing) |
| `/link-cube confirm --yes` | apply: roles + playbooks + standing duty + fleet sync |
| `/link-cube summon --confirmed` | portal mint plan + prompt: auto-mint gotchi / wallet / skip |
| `/link-cube summon --confirmed --auto-mint gotchi --yes` | mint-sub collateral gotchi (sim $5) after confirm gates |
| `/link-cube resummon --hero <id> --role <role> [--standing-duty trader-monitor] --yes` | rewire an existing hero, no mint |
| `/link-cube bind --hero <id> --role <role> --yes` | wire a freshly summoned hero to its role |
| `/link-cube status` | intake/design/confirm state |

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

Show script stdout to Julius. Load skill **prof-link-cube**.
