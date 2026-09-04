---
description: Hand live work to another cAavegotchi, or pick up what was handed to you
argument-hint: [send <hero> | list | resume | show <id> | drop <id>]
allowed-tools: Bash(./scripts/gotchibot passoff:*), Bash(node scripts/passoff.mjs:*)
---

Run this now, do not ask first:

```bash
./scripts/gotchibot passoff $ARGUMENTS
```

Rules:

- No arguments → `list` (what is waiting). A bare hero name → `send <hero>`.
- When **you** are the one handing off, always add the two things the packet
  cannot read off disk: `--note "what is already done"` and `--next "the next
  concrete step"`. Everything else (branch, dirty files, warm session, anchor,
  open meeting) is captured for you.
- Use `--dry-run` first when you are unsure what will be sent; it delivers
  nothing and saves nothing.
- Delivery goes through the OpenClaw gateway. If it fails, the packet stays
  pending — report that plainly and offer `--via spawn` or
  `passoff resume --as <hero>` on the other side. Do not retry in a loop.
- Targets resolve on the `/switch` roster (n, hero id, name, collateral).
  Unknown name is an error. **Never invent an agent.**

After `accept` / `resume`: verify the packet against the tree before building on
it, continue from `Next step`, and do not redo what `Done so far` lists.

Skill: **passoff**.
