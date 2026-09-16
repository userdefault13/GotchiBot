---
description: Start/cancel a GotchiBot ralph loop — same prompt fed back until promise or max iterations
argument-hint: [<goal> | status | cancel | list]
allowed-tools: Bash(./scripts/gotchibot ralph:*), Bash(node scripts/ralph-orch.mjs:*), Bash(./scripts/delegate-pick.mjs:*), Read, Grep
---

Load and follow **ralph** now:

1. Read `.opencode/skills/ralph/SKILL.md` in full (Cursor pointer: `.cursor/skills/ralph`).
2. You are the **chief** (owned-954) — frame the loop prompt, the completion promise, and max-iterations (default 20, never unlimited).
3. Start the loop:
   ```bash
   ./scripts/gotchibot ralph start --prompt "…" --max-iterations 20 --completion-promise "DONE"
   ```
4. Delegate each iteration to a worker hero (prefer spare DAI; never steal LINK/YFI/WBTC desks):
   ```bash
   ./scripts/delegate-pick.mjs --json "…"
   ```
5. The worker outputs `<promise>DONE</promise>` ONLY when genuinely true → capture hook writes the done flag → loop ends. VERIFY the real artifact before reporting done.

Arguments (if any): `$ARGUMENTS`

- Empty → ask Julius for the goal + completion promise (one short question), or continue the active loop if one is running.
- `status` / `cancel` / `list` → `./scripts/gotchibot ralph $ARGUMENTS`.
- Otherwise treat `$ARGUMENTS` as the goal and start with a safe max-iterations.

Store: `sessions/ralph/<slug>/`. Skill: **ralph**.