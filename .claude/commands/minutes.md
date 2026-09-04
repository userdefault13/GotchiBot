---
description: Meeting minutes — decisions, action items, open questions (isolated context)
argument-hint: [meeting id | blank for the current/most recent]
---

Use the **meet-scribe** subagent for this. Do not read the transcript into this
session — that is the whole point of the agent.

Ask meet-scribe for minutes of meeting `$ARGUMENTS` (blank = the id in
`sessions/meetings/.current`, or the most recently modified transcript if no
meeting is open).

Relay what it returns: Decided / Action items / Open questions, plus which
meeting it read. If it reports nothing was decided, say that — do not pad it.
