# Project email (AgentMail + abra)

**Rule:** each GotchiBot pstack project has **one** agent email.

| Layer | What |
|-------|------|
| Account / API key | Abracadabra project `gotchibot` → `AGENT_MAIL_API_KEY` |
| Inbox binding | `sessions/pstack/<slug>/mail.json` (`address`, `inboxId` — no secrets) |
| Desk | Marketplace pack **`mail-courier`** (skills `agentmail`, `abra-vault`, `project-mailbox`) |
| Desk mailboxes | `sessions/pstack/<slug>/desks/<heroId>/mailbox/inbox.json` + `sent.json` (local mirror, courier appends) |
| Skill | [`.opencode/skills/agentmail/SKILL.md`](../.opencode/skills/agentmail/SKILL.md) · [`.opencode/skills/project-mailbox/SKILL.md`](../.opencode/skills/project-mailbox/SKILL.md) |

AgentMail product: https://www.agentmail.to/ · docs: https://docs.agentmail.to/

SDK env name is `AGENTMAIL_API_KEY`; vault name is `AGENT_MAIL_API_KEY` — map at inject time, never echo values.

```bash
./scripts/project-context.mjs mail show
./scripts/project-context.mjs mail set --address you@agentmail.to --inbox-id <id>
gotchibot templates apply mail-courier --hero <available> --yes
```

Other desks draft mail and **passoff to mail-courier**. They do not hold the project AgentMail key.

## Desk mailboxes (inbox + sent)

One AgentMail address per project, but **every desk keeps a local mailbox** so
agents see their own inbox and sent without touching the key:

```
sessions/pstack/<slug>/desks/<heroId>/mailbox/inbox.json
sessions/pstack/<slug>/desks/<heroId>/mailbox/sent.json
```

The **mail-courier** appends to these files on every successful send (`sent`)
and every relayed inbound (`inbox`) — they are a mirror, never a second
AgentMail inbox. Desks read their own files; they never send directly.

```bash
./scripts/project-mailbox.mjs desk ensure <hero>            # create inbox+sent for a desk
./scripts/project-mailbox.mjs desk ensure-roster            # …for every roster hero
./scripts/project-mailbox.mjs inbox <hero> [--unread]       # read inbox (--unread filter)
./scripts/project-mailbox.mjs sent <hero>                   # read sent
./scripts/project-mailbox.mjs read <hero> <messageId>       # mark inbox message read
./scripts/project-mailbox.mjs digest                        # per-desk counts
./scripts/project-mailbox.mjs append inbox|sent <hero> --from <x> --to <x> --subject "…" [--agent-mail-id <id>] [--thread <id>] [--passoff <id>]
```

Append is idempotent: a repeated `--agent-mail-id` in the same box is skipped.
`project-kanban desk ensure` also ensures the mailbox for that hero.
