---
name: prof-link-cube
description: >-
  Hatch (mint) or rehatch (existing hero) a profiled cAavegotchi: intake prefs →
  design playbook+SOUL+IDENTITY+title → Julius confirms → hatch (mint-sub, never
  auto) or rehatch (no mint) → wire agent-roles + playbooks + standing duty +
  fleet sync. Load for /link-cube, /hatch, "spin up a financial analyst", or
  re-profiling an existing hero onto a new role while keeping a standing duty.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: onboarding
---

# prof.link-cube

**Hatch or rehatch a profiled gotchi.** One flow, two endings:

```
intake → design → confirm → hatch(mint) OR rehatch(existing) → wire role/playbook/SOUL/IDENTITY + fleet sync
```

## When to load

- Julius says: `/link-cube`, `/hatch`, "spin up a financial analyst", "make LINK
  a financial analyst", "hatch a new gotchi for this job".
- A named collateral is involved and the hero does not exist yet (hatch path).

## Flow

1. **intake** — `./scripts/gotchibot link-cube intake --job "financial analyst" --non-coding --voice "…" --anti-jobs "a; b" --collateral link --mode rehatch --hero starter-link-h1-1`
   (or `--mode hatch` for a new hero; flags or interactive).
2. **design** — `./scripts/gotchibot link-cube design [--dry-run]` prints the
   playbook + SOUL + IDENTITY + title. **Never writes target configs.**
3. **confirm** — `./scripts/gotchibot link-cube confirm [--yes]` applies:
   agent-roles.json, agent-role-playbooks.json, agent-standing-duties.json, then
   `openclaw-fleet.mjs sync` re-renders the workspace files. Refuses without
   `--yes` / `GOTCHIBOT_AUTO_APPROVE=1` / interactive y.
4a. **hatch** — `./scripts/gotchibot link-cube hatch --confirmed` prints the
    mint-sub plan only. **This CLI never auto-mints.** The actual mint goes
    through the `/spawn` overlay (cartridge sim :8791, `mint-sub <spiritId>`,
    $5 sim). After the hero exists: `link-cube bind --hero <id> --role <role> --yes`.
4b. **rehatch** — `./scripts/gotchibot link-cube rehatch --hero <id> --role <role> [--standing-duty <key>] [--yes]`
    rewires an existing hero, no mint, no wallet writes.

## Standing duties (config/agent-standing-duties.json)

A per-hero standing duty rides on top of the role: extra skills + a rendered
AGENTS.md section + a driven desk window. Keys today: `trader-monitor`
(Gotchi-Trader paper desk — skills, reportCmd/cycleCmd/scheduleCmd, decision
table, risk rules, live gate, schedule truth). Rehatching LINK to
financial-analyst keeps `trader-monitor` so the trader desk never drops.

## Safety (hard)

- design never writes; confirm needs approval; hatch never auto-mints; rehatch/bind never mint.
- No installs, no secrets, no Blockscout, no token-id hunting.
- Never steal YFI/WBTC standing desks; LINK's trader desk is a standing duty, not a free seat.

## Bot-template marketplace

Browse/install full-desk packs (role + playbook + AGENTS + vendored skills + standing-duty + cron hints):

```
./scripts/gotchibot templates list
./scripts/gotchibot templates show <id>
./scripts/gotchibot templates install <id|path|url> [--yes]
./scripts/gotchibot templates apply <id> --hero <hero> [--yes] [--standing-duty <key>]
```

`templates apply` installs if needed, then runs:
`link-cube resummon --role <roleId> --keep-playbook --hero <hero> [--yes]`.

Catalog: `templates/marketplace/catalog.json`. Web browse page: `templates/marketplace/web/index.html` (publish under aarcadeghst.com/gotchibot-templates).

Product name is **Prof. Link-Cube** / `link-cube` / `prof-link-cube` — **never Eggbot**.
