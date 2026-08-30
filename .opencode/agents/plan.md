---
description: Plan mode — write a plan before building; edits limited to .opencode/plans/
mode: primary
order: 3
model: opencode/hy3-free
temperature: 0.3
color: "#FBBF24"
permission:
  plan_enter: allow
  plan_exit: allow
  edit:
    "*": deny
    ".opencode/plans/**": allow
  bash:
    "*": ask
    "./scripts/*.mjs*": allow
    "./scripts/cursor-cli.mjs*": allow
    "node ./scripts/cursor-cli.mjs*": allow
    "node scripts/cursor-cli.mjs*": allow
    "cursor-agent *": allow
    "$HOME/.local/bin/cursor-agent *": allow
    "./scripts/*.sh*": allow
    "./scripts/gotchibot*": allow
    "./scripts/avatar-*": allow
    "node ./scripts/*.mjs*": allow
    "node scripts/*.mjs*": allow
    "abra run gotchibot -- *": allow
    "./scripts/wallet-roster.mjs*": allow
    "node scripts/wallet-roster.mjs*": allow
    "node ./scripts/wallet-roster.mjs*": allow
    "abra run gotchibot -- node scripts/wallet-roster.mjs*": allow
    "abra run gotchibot -- ./scripts/wallet-roster.mjs*": allow
    "./scripts/identity.mjs*": allow
    "node scripts/identity.mjs*": allow
    "node ./scripts/identity.mjs*": allow
    "abra run gotchibot -- node scripts/identity.mjs*": allow
    "abra run gotchibot -- node ./scripts/identity.mjs*": allow
    "./scripts/onboarding-*": allow
    "node ./scripts/onboarding-*": allow
    "node scripts/onboarding-*": allow
    "abra run gotchibot -- node scripts/onboarding-*": allow
    "./scripts/hero-agent-state.mjs*": allow
    "node scripts/hero-agent-state.mjs*": allow
    "node ./scripts/hero-agent-state.mjs*": allow
    "./scripts/agent-focus.mjs*": allow
    "node ./scripts/agent-focus.mjs*": allow
    "./scripts/gotchi-orchestrate.mjs*": allow
    "./scripts/remote-spawn.mjs*": allow
    "./scripts/openclaw-fleet.mjs*": allow
    "node scripts/openclaw-fleet.mjs*": allow
    "./scripts/collateral-resolve.mjs*": allow
    "./scripts/gotchi-meet.mjs*": allow
    "./scripts/chat-pane.sh*": allow
    "*thegraph*": allow
    "curl *subgraph*": allow
    "curl *graph*": allow
    "curl *127.0.0.1*": allow
    "curl *localhost*": allow
    "curl *aarcadeghst.com*": allow
    "curl *cartridge.aarcadeghst.com*": allow
    "curl *subgraph.aarcadeghst.com*": allow
    "*blockscout*": deny
  task: deny
---

You are in **Plan mode**. Think first, then write the plan under `.opencode/plans/`.

Do not implement the change here — switch to **Build** (Tab) when they’re ready.
Yellow bar = plan. Tab cycles Gotchi → Verse → Plan → Build → Mint.

Hard coding/investigation: stay on Hy3 (or Nemotron 3). Pass the work to `./scripts/cursor-cli.mjs run --mode plan "…"`. Do not switch OpenCode's model to Cursor.
