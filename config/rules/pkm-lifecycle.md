# Rule: PKM lifecycle notify

**Id:** `pkm-lifecycle`  
**Owner:** kanban-manager (PKM)  
**Applies to:** every seated desk agent + workers

## Norm

Any work that is **delegated**, **submitted**, or **reviewed** MUST notify kanban-manager to record and manage:

```bash
node ./scripts/pkm-record.mjs --event delegated|submitted|reviewed \
  --from <hero> --title "…" [--to …] [--ticket …] [--card …] [--note …]
```

## Triggers

| Event | When |
|---|---|
| `delegated` | Desk asks Prof to seat a worker; ticket `request`; outbound passoff of work |
| `submitted` | Ticket `submit`; worker `output.md` ready for review |
| `reviewed` | Ticket `accept` or `rework` |

## Enforcement

- `project-tickets.mjs` auto-notifies on request/submit/accept/rework.
- Manual/Prof/passoff paths: desk MUST run `pkm-record` in the same turn.
- Inbox recipient: `kanban-manager` (alias `pkm`); unseated → orch fallback.
- PKM records on main kanban + ticket lifecycle and syncs desk minis.

## Anti-jobs

- Do not skip notify because "it's small".
- Do not invent board progress without a card/ticket id.
- Do not message AgentMail for this — bot inbox only.
