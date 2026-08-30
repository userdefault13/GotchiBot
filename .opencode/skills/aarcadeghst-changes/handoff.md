# Handoff protocol — AarcadeGh-t changes → owned-22899

Consumer: **DAI** (`owned-22899`, source token `22899`).
Author: usually orchestrator `owned-954` or a coding Cursor session.

## When to hand off

- A My Paarcels UI change landed (or is ready) in AarcadeGh-t and BTC bot must
  review, continue, or verify it.
- BTC bot needs prior UI context after a new OpenClaw / dispatch session.
- Orchestrator finishes a Cursor coding pass and wants fleet continuity.

## Protocol 1 — Record then notify (default)

1. **Author** appends an entry to
   `.opencode/skills/aarcadeghst-changes/changes.json` (`status: pending`).
2. **Author** focuses BTC bot and chats the entry id:

   ```bash
   ./scripts/agent-focus.mjs select owned-22899
   ./scripts/agent-focus.mjs chat "aarcadeghst-changes: pending <id>. Read skill + changes.json. Ack and continue."
   ```

3. **DAI** reads skill + entry, sets `acked` / `in_progress`, does the work,
   sets `done` (or `blocked` + notes).
4. **DAI** (if dispatched) writes a short summary to `sessions/<id>/output.md`.

## Protocol 2 — Spawned sync

Use when DAI is idle and the job is self-contained:

```bash
./scripts/wallet-gate.mjs
GOTCHIBOT_HERO_ID=owned-22899 abra run gotchibot -- \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim \
  "Skill: aarcadeghst-changes. Process all pending entries in changes.json. Ack each, verify files under /Users/juliuswong/Dev/AarcadeGh-t, update statuses, write merge summary to output.md."
```

Prefer iMac via `--host auto` when Tailscale is up.

## Protocol 3 — BTC bot requests sync

When DAI discovers drift (disk ≠ log) or needs upstream help:

1. Patch the entry: `status: "blocked"`, `notes` with blocker.
2. Escalate to orchestrator — do not fan out yourself:

   ```bash
   ./scripts/agent-focus.mjs select owned-954
   # or from SUB: agent-focus.mjs chat "…" (escalates when needed)
   ```

3. Optional session bridge: `./scripts/gotchibot handoff` before a large new
   session; `./scripts/gotchibot checkpoint <session> aarcadeghst-ui-<id>` at
   milestones.

## Status machine

```
pending → acked → in_progress → done
                 ↘ blocked  (orchestrator unblocks → in_progress or pending)
                 ↘ wontfix (terminal; keep notes)
```

Only one agent should mutate a given entry at a time. Prefer short notes over
rewriting `summary`.

## Prompt template (self-contained spawn)

```
You are DAI (owned-22899). Use skill aarcadeghst-changes.
1. Read .opencode/skills/aarcadeghst-changes/SKILL.md and changes.json
2. Process entry <ID> (or all pending)
3. Open listed files under /Users/juliuswong/Dev/AarcadeGh-t
4. Update entry status/ack/notes in changes.json
5. Write result to output.md
Constraints: no installs, no secrets, no registry edits, new skill files only if extending this skill.
```

## Do not

- Skip the JSON log and rely on chat memory alone
- Post tweets or touch `aarcade-comms` endpoints for UI handoffs
- Modify `skills/registry.json` without Julius approval
- Kill stuck sessions older than 30m — flag Julius instead
