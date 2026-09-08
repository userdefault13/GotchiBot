# OpenClaw hero prompt templates

These files are the **source of truth** for what every OpenClaw hero is told.
`scripts/openclaw-fleet.mjs sync` renders them into
`config/openclaw/workspaces/<heroId>/` (AGENTS.md, SOUL.md, IDENTITY.md, USER.md)
and copies the role's skills into `<workspace>/skills/`. OpenClaw loads its
persona files from the agent **workspace**, never from `agentDir`, so this is the
only path that actually reaches a hero.

Edit here, run `./scripts/openclaw-fleet.mjs sync && ./scripts/openclaw-fleet.mjs doctor`,
push to the iMac. Never edit the rendered workspace files; sync overwrites them.

Files:

- `SOUL.md`, `IDENTITY.md` — shared by every hero.
- `AGENTS.<role>.md` — one per role in `config/agent-role-playbooks.json`
  (`orchestrator`, `trader-desk`, `infra-monitor`, `aarcade-comms-handler`).
  `AGENTS.worker.md` is used for a hero with no role.
- `AGENTS.common.md` — appended to every AGENTS.md (tools, never-list, failure drill, memory).

Placeholders: `{{NAME}}` `{{ID}}` `{{EMOJI}}` `{{ROLE}}` `{{ROLE_TITLE}}`
`{{ORCH_ID}}` `{{ORCH_NOTE}}` `{{REPO}}` `{{WORKSPACE}}` `{{SKILLS}}`
`{{REPORT_CMD}}` `{{CYCLE_CMD}}` `{{WATCH_CMD}}` `{{VERIFY_CMD}}` `{{VERIFY_WINDOW}}`
`{{COMMON}}` (the rendered common block). `doctor` fails on any placeholder
left unresolved and on any `./scripts/<file>` that does not exist.

Rules for writing these (they are read by small free models):

1. A table row per situation: what Julius says → the exact command → what to reply.
2. One command per row. Absolute repo path via `cd {{REPO}} &&`.
3. No prose about architecture. No "never say X" lists longer than five lines.
4. Keep each rendered AGENTS.md under 12 000 characters (OpenClaw truncates at 20 000).
