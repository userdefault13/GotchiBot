# Rule: messaging channels

**Id:** `messaging-channels`  
**Applies to:** every seated desk (COMMON)

## Hard policy

1. **Agent ↔ agent** durable messages → **bot-inbox** only (`gotchibot inbox send --to <hero|role> --from <me>`).
2. **External mail outbound** → **passoff to mail-courier** only; courier sends via AgentMail.
3. **External mail inbound** → **mail-courier** receives, appends desk mailbox mirror, relays owner. Desks never poll AgentMail themselves.
4. **Work packets** → passoff. **Live talk** → meet. **UserDefault with no external address** → bot-inbox (never AgentMail).

## Anti-jobs

- Never AgentMail from a non-courier desk.
- Never hold or print `AGENT_MAIL_API_KEY`.
- Never use meet or AgentMail as a substitute for bot-inbox agent↔agent mail.
- Never put dept nightlies on AgentMail.

See `config/messaging-index.json` / `gotchibot messaging --text`.
