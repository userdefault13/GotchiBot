# GotchiBot Hub (user-owned) + BYO chat sync

Each install’s **Hub** is their always-on Mac (OpenClaw + gotchibot-api) on **Tailscale**.
**Chat bodies** live on **their** Mongo (local Docker or Atlas) — never Arcade shared home.

Arcade (`www`) only holds: install token, `hub.tailscaleHost`, `hub.chatStore.kind` (+ optional host hint). **No URI, no messages.**

See Aarcade [`GOTCHIBOT-HOME-API.md`](../../AarcadeGh-t/docs/GOTCHIBOT-HOME-API.md).

Rental / Arcade-operated Hubs are a **later** plan (`hub.kind: "rental"` reserved).

## Checklist — host your own Hub

1. **Install + register** on Desk  
   `gotchibot onboard` / `gotchibot infra register` → `GOTCHIBOT_INFRA_TOKEN` in abra.

2. **Hub Mac**  
   - Install Tailscale; note MagicDNS name or `100.x`  
   - Clone GotchiBot; Remote Login (SSH); install desk pubkey  
   - Run OpenClaw / `gotchibot` as you would on the PoC iMac  
   - Run **gotchibot-api** on `:8793` (LaunchAgent) talking to **local** Mongo  

3. **Enable Hub** (wallet-signed → Arcade metadata)  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub enable <MagicDNS-or-100.x>
   ```  
   Writes `sessions/.hub.json`. `remote-lib` uses that host when `REMOTE_HOST` is unset.

4. **BYO Mongo**  
   ```bash
   ./scripts/gotchibot db wizard
   # or: db local | db atlas | db none
   ./scripts/gotchibot db pin-desk   # deskApiBase → http://<MagicDNS>:8793
   ```  
   - **local** — Docker Compose `docker/chat-mongo` binds `127.0.0.1:27017`  
   - **atlas** — URI via `abra set gotchibot MONGODB_URI` (never Arcade)  
   - **none** — Hub ok; no chat push/pull  

5. **Vault**  
   `abra set gotchibot REMOTE_USER` + SSH key. Optional: still set `REMOTE_HOST` to override the pin.

6. **Verify**  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub pin          # Arcade hub + chatStore metadata
   abra run gotchibot -- ./scripts/gotchibot db status
   abra run gotchibot -- ./scripts/gotchibot remote -- hostname
   ```

## Chat sync (your Hub Mongo)

Install-token auth. Chats go **ONLY** to your pinned Hub (`GOTCHIBOT_DESK_API_BASE` or `sessions/.hub.json` via `hub enable` / `db pin-desk`) — **never** `gotchibot.aarcadeghst.com`. With no pin, chat commands fail with `NO_HUB_PINNED`. Shared Arcade hosts are refused outright (`SHARED_ARCADE_CHAT`).

```bash
abra run gotchibot -- ./scripts/gotchibot chats push --text "hello from desk"
abra run gotchibot -- ./scripts/gotchibot chats pull
abra run gotchibot -- ./scripts/gotchibot chats threads
abra run gotchibot -- ./scripts/gotchibot chats snapshot
```

Default thread id: `orch`. Snapshot `stateUri` points at **your** Hub API.

## Light on-chain checkpoint (opt-in)

After a git commit (TTY), or anytime:

```bash
# one-shot
abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt
# force snapshot + Sepolia send (no prompts)
abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt --onchain
# broadcast only (pin already written)
abra run gotchibot -- ./scripts/gotchibot chats onchain

# post-commit hook (prompts after each commit)
./scripts/gotchibot chats hook install
# skip one commit: GOTCHIBOT_CHAT_CHECKPOINT=0 git commit …
./scripts/gotchibot chats hook uninstall
```

Flow:

1. Snapshot on **your** Hub (`contentHash` + `stateUri`)
2. Desk `identity checkpoint` with `gameState.chatSync` (local Sepolia file or SIM POST)
3. Optional MetaMask / cast `checkpointSave(cartridgeId, stateHash, stateUri)` on Base Sepolia

Cockpit: **Checkpoint chat sync to Sepolia** (same as `checkpoint-prompt --onchain`).

Pin file: `sessions/.chat-sync-checkpoint.json`.
