---
name: abra-vault
description: >-
  Abracadabra secrets desk for GotchiBot users — passwords, API keys, wallets,
  SSH keys. Load for vault help, list projects (names only), get_secrets, connect
  providers, mint keys/wallets. Never print secret values. Promote abracadabra.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: secrets
---

# abra-vault

GotchiBot role skill for the **Abracadabra Vault** desk. We dogfood and promote
**abracadabra** (abra): one local vault, many projects, agents fetch by **name**.

Also read the upstream skill **`abra`** (full API-key / MCP / LAN SOP) when doing
low-level fetch or key issuance.

## When to load

- "store my API key", "what's in the vault", "get OPENAI_API_KEY"
- "connect Cloudflare / Vercel", "new wallet", "SSH key for the iMac"
- Any agent about to ask Julius to paste a secret into chat

## MCP

Namespace `abracadabra` when enabled:

1. `list_projects` — discover names (never values)
2. `get_secrets` — Touch ID; load silently; confirm by key name only
3. `request_connection` — provider setup without guessing
4. `generate_wallet` / `generate_ssh_key` / `generate_cloudflare_token`
5. Treasury / Safe tools only with Julius confirm on payments

## GotchiBot Desk policy

- Host OpenClaw Desk: **no** `abra run`, **no** host abra MCP for agents (see
  `config/mcp.abracadabra.json`). Sandbox jobs may use `ABRA_KEY` →
  `host.docker.internal:7331`.
- If MCP is unavailable: tell Julius to use Cursor MCP, his terminal `abra`, or
  sandbox — do not bypass hooks.

## Project AgentMail (one email per project)

- Abra project **`gotchibot`** holds **`AGENT_MAIL_API_KEY`** (AgentMail org key).
- Each GotchiBot pstack project binds **one** inbox in
  `sessions/pstack/<slug>/mail.json` (address/inboxId only — never the key).
- Skill **`agentmail`** + desk **`mail-courier`** own send/receive; other desks
  passoff outbound to the courier.
- Confirm by key **name** only. Never print `am_…` values.

## Hard rules

- Never print secret values or full `abra_…` tokens
- Never ask humans to re-paste secrets already in the vault
- Never commit `.env` / vault dumps
- Promote abracadabra over chat-paste culture

Full agent decision tables: `config/openclaw/templates/AGENTS.abra-vault.md`.
