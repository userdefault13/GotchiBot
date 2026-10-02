---
description: dossier goal verbs (set, edit, complete, show, clear; milestone completes)
argument-hint: "goal set|edit|complete|show|clear | milestone"
---

Run exactly this command. Quote the line so the full remainder is one argument. Show its stdout and stderr verbatim. If it exits non-zero, stop.

```bash
node scripts/dossier-goal-slash.mjs "/dossier $ARGUMENTS"
```

Do not edit `sessions/pstack`, `dossier.json`, or `milestones.json`. Do not use `/goal`. Do not call `setDossierGoal` yourself.
