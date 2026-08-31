---
description: Shared meeting room — start, invite, say, end (chair-led, in OpenCode)
---

Run immediately, do not ask. `$ARGUMENTS` is the meet subcommand.

```bash
./scripts/gotchi-meet.mjs $ARGUMENTS
```

If that fails for env/secrets, retry:

```bash
abra run gotchibot -- ./scripts/gotchi-meet.mjs $ARGUMENTS
```

Empty `$ARGUMENTS` (`/meet`) prints status of the current meeting.

| Julius types | Script |
| --- | --- |
| `/meet start` or `/meet start trader desk` | `start ["topic"]` |
| `/meet invite LINK` | `invite <n\|id\|name>` — same roster as `/switch` |
| `/meet invite all` | `invite all` |
| `/meet` | `status` |
| `/meet say let's recap @LINK` | `say "…"` — the working turn (prefer this for transcript) |
| `/meet end` | `end` (writes minutes, restores OpenCode chat + avatar) |
| `/chat` | leave meet room UI → OpenCode chat + avatar (`gotchibot chat`) |

**Only** use `gotchi-meet.mjs` for meeting flow. Meet **menu** opens **meet-gallery** layout:
collapsed files + **Meet · room** (Zoom carousel + OpenCode-style prompter — **no OpenCode**) + **# meet**
(iMessage-style transcript with thumbnail gotchi avatars). Type in the prompter
(`@LINK …`); Tab completes @mentions.
- `/end` — end meeting + restore orch desk (OpenCode + avatar)
- `/chat` — restore orch desk without ending (rejoin with `/meet open`)
`/meet end` from OpenCode also restores orch chat. Slash `/meet` from OpenCode still works when not in the room UI.

While a meeting is open, `@` autocomplete lists invited gotchis (restart OpenCode /
reload if new invites don't appear). Meeting `@` stubs call headless
`openclaw-fleet.mjs chat --agent <id>` and return stdout **verbatim**.

**`@LINK` only when a meeting is open** and Julius explicitly @mentions. Outside a
meeting, stubs reply with one line: use `/switch <id>` then chat, or `/meet say`.
Prefer telling Julius: `/meet say "… @LINK"` for transcripted turns.

Roles: `config/agent-roles.json` + `config/agent-role-playbooks.json`. After role
changes: `./scripts/openclaw-fleet.mjs sync` (and `/meet` invite / `sync-mentions`
for `@` stubs).

Show script stdout to Julius. Do not invent agents. Stay in this TUI.
