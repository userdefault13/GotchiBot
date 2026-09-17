---
name: gotchibot-meet
description: >-
  GotchiBot meeting room — status, say, colabo, invite, end. Use when Julius
  mentions a meeting, /meet, colabo, or inviting gotchis to talk — without
  loading the full transcript into this session.
---

# gotchibot-meet (Cursor)

Drive meetings only through the CLI. Do not invent agents or turns.

```bash
./scripts/gotchibot meet                  # status (default)
./scripts/gotchibot meet say "…"          # @mentions pick who answers
./scripts/gotchibot meet edit last "…"    # fix your own last message (no re-say)
./scripts/gotchibot meet colabo "…"       # every invited agent answers
./scripts/gotchibot meet invite LINK      # or: invite all
./scripts/gotchibot meet end              # minutes + handoff
```

`edit <ts|last> "text"` rewrites Julius's own user-role turn in place (stamps
`editedAt`, keeps the original `ts`) — it never re-says and never wakes agents.

In the meet · room prompter: `/cockpit` (or `/menu`) leaves the UI back to the
cockpit; `/chat` / `^C` leave to OpenCode chat; `/start` · `/end` toggle recording
only; `/help` lists slash commands. The room stays open either way.

## Quota

`say` and `colabo` **wake real agents and spend quota**. Run them when Julius
asks; do not fire one to check if it works.

## Minutes

For a recap, use `/minutes` → Task **meet-scribe**. Do not read
`sessions/meetings/*/transcript.jsonl` into this context.

Related: [`.claude/commands/meet.md`](../../../.claude/commands/meet.md), skill
[`colabo`](../../../.opencode/skills/colabo/SKILL.md) when coordinating multi-gotchi replies.
