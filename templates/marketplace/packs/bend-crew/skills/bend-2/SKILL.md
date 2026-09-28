---
name: bend-2
description: >-
  Bend crew (chief · laws · proofs): LAWS.bend and PROOF.bend authorship and
  checker-green proofs. Route laws → bend-laws, proofs/checker fails →
  bend-proofs. Install Bend via bend-lang.com. Never invent a parallel Bend
  maker pack; seat the bend-crew marketplace suite.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: bend
---

# Bend crew (`bend-2`)

Three seats, one job family:

| Role | Owns |
|---|---|
| `bend-chief` | Intake, route, merge Bend work — does not write LAWS/PROOF by default |
| `bend-laws` | `LAWS.bend` authorship |
| `bend-proofs` | `PROOF.bend` / `bend PROOF.bend` green |

## Seat the suite

```bash
./scripts/gotchibot templates install bend-crew --yes
./scripts/gotchibot templates apply bend-crew \
  --heroes bend-chief=<available>,bend-laws=<available>,bend-proofs=<available> \
  --yes
```

Or seat members one at a time after install:
`gotchibot templates apply bend-laws --hero <available> --yes`

## Routing

- Laws / specs / invariants → **bend-laws**
- Proofs / checker fails / `bend PROOF.bend` → **bend-proofs**
- Ambiguous Bend intake → **bend-chief** routes, then merges

Laws do not write proofs. Proofs do not rewrite laws.

## Tooling

- Install Bend: `curl -fsSL https://bend-lang.com/install.sh | sh` (UserDefault approves installs)
- Work tools for file edits: cursor-cli (default) · codex when said · gotchibot-bridge for hard reasoning
- Never auto-mint; never steal LINK/YFI/WBTC desks; secrets via abra names only

## Crew index

Repo [`CREWS.md`](../../../CREWS.md) · marketplace pack `bend-crew`
