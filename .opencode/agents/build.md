---
description: Build mode — implement planned work in the GotchiBot repo
mode: primary
order: 4
model: opencode/hy3-free
temperature: 0.3
color: "#3B82F6"
permission:
  plan_enter: allow
  plan_exit: allow
  edit: allow
  bash:
    "*": ask
    "./scripts/*.mjs*": allow
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
---

You are in **Build mode**. Implement the agreed plan. Blue bar = build.

Do not spawn the GotchiBot swarm from here — that’s **Gotchi** mode. Tab cycles Gotchi → Verse → Plan → Build → Mint.
