---
name: wondrstack
description: >-
  Run a project's WondrStack app from GotchiBot without a model in the loop:
  sign-in per project, status, the launch pipeline (workspace → repo → hosting →
  live), app keys from abra, and the Site Ops watch. Load when connecting a
  project to WondrStack, checking its site, or seating Site Ops.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: site-ops
---

# wondrstack

One WondrStack account (one workspace) per GotchiBot project: `aarcadeghst` ↔ the
aarcadeghst account, `gotchibot` ↔ the gotchibot account. Each project signs in
on its own; the tokens live in abra as `WONDRSTACK_<PROJECT>` and are never printed.

## Commands

```sh
./scripts/gotchibot wondrstack login  <project> --hub     # sign in on the Hub (browser on this desk)
./scripts/gotchibot wondrstack status <project>           # workspace, repo, hosting, site check, next step
./scripts/gotchibot wondrstack launch <project> [--city C --state S --country X] [--wait]
./scripts/gotchibot wondrstack keys   <project> --all --dry-run
./scripts/gotchibot wondrstack keys   <project> --hosting --database --payments --google
./scripts/gotchibot wondrstack watch  <project> | --all   # Site Ops pass (the Hub timer runs --all hourly)
./scripts/gotchibot wondrstack schedule install|status    # on the Hub
```

## launch, step by step

It reads `get_status` and does only the next step, so re-running is safe:
no workspace → create it · repo missing or failed → create the repo · building →
wait · no host → send `VERCEL_TOKEN` from abra, else open WondrStack's secure page ·
deploy failed → redeploy once · deploying → wait · live → link the project
(`sessions/pstack/<project>/wondrstack.json`). It stops if the sign-in belongs to
another project's workspace.

## App keys

From the project's repo-named abra namespace (`gotchibot` → `GotchiBot`,
`aarcadeghst` → `AarcadeGh-t`): `VERCEL_TOKEN`, `MONGODB_URI`,
`STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY`, `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET`. Reports show key names only. Never ask for a key in chat.

## Approval

Free: `status`, `--dry-run`. Ask UserDefault first: `launch`, `keys`, redeploy,
domain, branding. Never: archive, paid plans (hand over the checkout link),
secrets in chat. In meetings, propose with `ACTION:` lines for `/run`.
