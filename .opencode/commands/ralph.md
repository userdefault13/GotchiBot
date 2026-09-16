---
description: ralph loop — same prompt iterated until completion promise or max iterations (no product edits by orch)
agent: gotchi
---

Load skill **ralph** (`.opencode/skills/ralph/SKILL.md`) and stay sticky until
the done flag, max iterations, or Julius says `new task` / `exit ralph` /
`cancel`. You are the **chief** (owned-954): frames the prompt + completion
promise, delegates iterations, verifies — **no product-code edits**. Worker
heroes do the iterating.

`$ARGUMENTS` is the goal / subcommand.

| Julius types | What to do |
| --- | --- |
| `/ralph` | Ask one short question for the goal + completion promise; or continue the active loop |
| `/ralph <goal>` | Start: `gotchibot ralph start --prompt "<goal>" --max-iterations 20 --completion-promise "DONE"` then delegate-pick a worker |
| `/ralph status [slug]` | `./scripts/gotchibot ralph status $ARGUMENTS` |
| `/ralph cancel [slug]` | `./scripts/gotchibot ralph cancel $ARGUMENTS` |
| `/ralph list` | `./scripts/gotchibot ralph list` |

Bookkeeping (never spawns):

```bash
./scripts/gotchibot ralph $ARGUMENTS
```

For a real goal (not status/cancel/list):

1. Read `.opencode/skills/ralph/SKILL.md` in full.
2. Frame: self-contained prompt with explicit done criteria + `<promise>` completion text + max-iterations (default 20, never unlimited).
3. `./scripts/gotchibot ralph start --prompt "…" --max-iterations 20 --completion-promise "…"`.
4. Delegate each iteration to a worker (prefer spare DAI; **never** steal LINK/YFI/WBTC):
   ```bash
   ./scripts/delegate-pick.mjs --json "…"
   ```
5. VERIFY the real artifact when the promise fires; `gotchibot ralph cancel` to stop early.

Store: `sessions/ralph/<slug>/`. Does not replace `delegate-first`.