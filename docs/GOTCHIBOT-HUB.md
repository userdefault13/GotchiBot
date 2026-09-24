# GotchiBot Hub (user-owned) + chat sync

Each install’s **Hub** is their always-on Mac (OpenClaw + gotchibot) on **Tailscale**.
Arcade (`aarcadeghst.com`) stores install metadata, chat sync, and the Hub host pin —
it does not host strangers’ OpenClaw.

Rental / Arcade-operated Hubs are a **later** plan (`hub.kind: "rental"` reserved).

## Checklist — host your own Hub

1. **Install + register** on Desk  
   `gotchibot onboard` / `gotchibot infra register` → `GOTCHIBOT_INFRA_TOKEN` in abra.

2. **Hub Mac**  
   - Install Tailscale; note MagicDNS name or `100.x`  
   - Clone GotchiBot; Remote Login (SSH); install desk pubkey  
   - Run OpenClaw / `gotchibot` as you would on the PoC iMac  

3. **Enable Hub** (wallet-signed)  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub enable <MagicDNS-or-100.x>
   ```  
   Writes `sessions/.hub.json`. `remote-lib` uses that host when `REMOTE_HOST` is unset.

4. **Vault**  
   `abra set gotchibot REMOTE_USER` + SSH key. Optional: still set `REMOTE_HOST` to override the pin.

5. **Verify**  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub status
   abra run gotchibot -- ./scripts/gotchibot remote -- hostname
   ```

## Chat sync (Arcade Mongo)

Install-token auth. Collections: `gotchibot_chat_*` (not legacy `chat_messages`).

```bash
abra run gotchibot -- ./scripts/gotchibot chats push --text "hello from desk"
abra run gotchibot -- ./scripts/gotchibot chats pull
abra run gotchibot -- ./scripts/gotchibot chats threads
abra run gotchibot -- ./scripts/gotchibot chats snapshot
```

API (www):

| Method | Path |
|--------|------|
| POST | `/api/gotchibot/chats/push` |
| GET | `/api/gotchibot/chats/pull?threadId=&since=` |
| GET | `/api/gotchibot/chats/threads` |
| POST | `/api/gotchibot/chats/snapshot` |
| GET | `/api/gotchibot/chats/snapshot/:id` (public light metadata) |
| POST | `/api/gotchibot/hub/enable` |
| GET | `/api/gotchibot/hub/status` |

Default thread id: `orch`.

## Light on-chain checkpoint (opt-in)

After a git commit, optionally:

```bash
abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt
# or non-interactive:
GOTCHIBOT_CHAT_CHECKPOINT=1 abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt --onchain
```

Builds an Arcade snapshot (`stateUri` + `contentHash` + `gitCommit`), writes
`sessions/.chat-sync-checkpoint.json`. On-chain save still goes through
`gotchibot checkpoint` / identity — never silent MetaMask.

## PoC vs prod

| PoC | Prod |
|-----|------|
| Fixed home iMac in abra `REMOTE_HOST` | `hub.tailscaleHost` on install + `.hub.json` |
| Operator-only knowledge | Concierge / setup checklist above |

See also: Aarcade [`GOTCHIBOT-INSTALL-AUTH.md`](../../AarcadeGh-t/docs/GOTCHIBOT-INSTALL-AUTH.md).
