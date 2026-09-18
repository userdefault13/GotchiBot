---
name: desk-wake
description: >-
  Common scheduled wake for every seated GotchiBot desk (grokbot-style autonomy).
  Load for /wake, "install the wake", "is merch running on its own", or when a
  desk needs a repeating OpenClaw chat / cycle. Dedicated trader/infra/moltbook/comms
  wakers stay on their own schedule CLIs (mode=defer).
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: scheduling
---

# desk-wake

Every hero gets this skill (`COMMON_SKILLS`). It is how desks that do **not** already
have a dedicated LaunchAgent start working on their own: a timer chats the OpenClaw
agent (or runs `cycleCmd`) with a bounded autonomy prompt.

## Commands

```bash
./scripts/gotchibot wake status [--json] [--role merch-desk]
./scripts/gotchibot wake list
./scripts/gotchibot wake run merch-desk          # one cycle now
./scripts/gotchibot wake install merch-desk      # launchd on this host (prefer iMac)
./scripts/gotchibot wake install --all           # every enabled non-defer seated desk
./scripts/gotchibot wake uninstall merch-desk
```

Catalog: `config/desk-wakes.json`. Logs: `sessions/desk-wake-logs/<hero>.jsonl`.

## When to load

- Julius: "wake the desks", "install the wake", "merch on its own like grokbot"
- Cron-manager coordinating wakes for marketplace desks
- A desk checking whether *it* is scheduled: `gotchibot wake status --role <my-role>`

## Rules

1. **Defer** trader / financial-analyst / infra / moltbook / comms — quote their
   `gotchibot <desk> schedule status` lines; do not double-install.
2. **No paid cron402** from this skill unless Julius explicitly confirms spend.
   Launchd on the iMac is the install path here.
3. Approve-gates stay: wakes may draft; they never send mail, post, or spend.
4. Never invent a schedule — only `wake status` / dedicated schedule status.
5. Address **UserDefault** in wake work product.

## Merch quick path

```bash
abra run gotchibot -- ./scripts/gotchibot wake install merch-desk   # on iMac
./scripts/gotchibot wake run merch-desk                             # first poke now
./scripts/gotchibot wake status --role merch-desk
```
