---
description: Hand live work to another cAavegotchi — packet + message, they pick up mid-stride
agent: gotchi
---

Run immediately, do not ask. `$ARGUMENTS` is the passoff subcommand.

```bash
./scripts/gotchibot passoff $ARGUMENTS
```

| Julius types | What runs |
| --- | --- |
| `/passoff LINK` | `send LINK` — capture + message LINK (bare name = send) |
| `/passoff send LINK --note "…" --next "…"` | full send with the human context |
| `/passoff send LINK --dry-run` | show the brief, send nothing |
| `/passoff send LINK --via spawn` | gateway down → spawn LINK on the brief |
| `/passoff` | `list` — packets waiting |
| `/passoff resume` | accept the newest packet addressed to me |
| `/passoff show <id>` | read a packet without accepting it |
| `/passoff drop <id>` | retire a packet |

A bare `/passoff <name>` means **send to that gotchi** — run
`./scripts/gotchibot passoff send <name>`. A bare `/passoff` means **list**.

Always add `--note` (what is already done) and `--next` (the next step) when you
are the outgoing agent — the rest of the packet is read off disk, that part is not.

Targets resolve on the `/switch` roster (n, hero id, name, collateral).
Unknown name → error. **Do not invent agents.**

If delivery fails the packet stays pending; say so and offer `--via spawn` or
`passoff resume --as <hero>` on the other side.

Show script stdout to Julius. Load skill **passoff**.
