# GotchiBot Hub (user-owned) + BYO chat sync

Each install’s **Hub** is their always-on Mac (OpenClaw + gotchibot-api) on **Tailscale**.
**Chat bodies** live on **their** Mongo (local Docker or Atlas) — never Arcade shared home.

Arcade (`www`) only holds: install token, `hub.tailscaleHost`, `hub.chatStore.kind` (+ optional host hint). **No URI, no messages.**

Full API, auth, sync model, and install wizard: [`GOTCHIBOT-API.md`](./GOTCHIBOT-API.md).

Rental / Arcade-operated Hubs are a **later** plan (`hub.kind: "rental"` reserved).

## Checklist — host your own Hub

1. **Install + register** on Desk  
   `gotchibot onboard` / `gotchibot infra register` → `GOTCHIBOT_INFRA_TOKEN` in abra.
   Install token is for **Arcade metadata only** (`hub enable`, `hub chat-store`) — not for chats.

2. **Hub Mac**  
   - Install Tailscale; note MagicDNS name or `100.x`  
   - Clone GotchiBot; Remote Login (SSH); install desk pubkey  
   - Run OpenClaw / `gotchibot` as you would on the PoC iMac  
   - Run the Hub install wizard (gotchibot-api + Mongo + serve):

   ```bash
   gotchibot hub install
   # → LaunchAgent/systemd, local Mongo if needed, tailscale serve (never funnel),
   #   prints: gotchibot hub join <MagicDNS> <code>
   ```

3. **Pair each desk**  
   ```bash
   gotchibot hub join <MagicDNS> <code>
   ```  
   Writes `sessions/.hub.json` with `deskToken` + `deskApiBase` (mode `0600`).  
   More codes: on the Hub, `gotchibot hub pair`. List / revoke: `hub desks`, `hub revoke <deskId>`.

4. **Enable Hub metadata** (wallet-signed → Arcade; optional if install already offered it)  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub enable <MagicDNS-or-100.x>
   ```  
   Preserves desk pairing fields in `sessions/.hub.json`. `remote-lib` uses that host when `REMOTE_HOST` is unset.

5. **BYO Mongo** (if you skipped Docker during install)  
   ```bash
   ./scripts/gotchibot db wizard
   # or: db local | db atlas | db none
   ./scripts/gotchibot db pin-desk   # deskApiBase → http://<MagicDNS>:8793
   ```  
   - **local** — Docker Compose `docker/chat-mongo` binds `127.0.0.1:27017`  
   - **atlas** — URI via `abra set gotchibot MONGODB_URI` (never Arcade)  
   - **none** — Hub ok; no chat push/pull  

6. **Vault**  
   `abra set gotchibot REMOTE_USER` + SSH key. Optional: still set `REMOTE_HOST` to override the pin.

7. **Verify**  
   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub pin          # Arcade hub + chatStore metadata
   abra run gotchibot -- ./scripts/gotchibot db status
   abra run gotchibot -- ./scripts/gotchibot remote -- hostname
   gotchibot api status                                       # on the Hub
   ```

## Chat sync (your Hub Mongo)

Auth = **desk token** from `gotchibot hub join` (`sessions/.hub.json` or `GOTCHIBOT_DESK_TOKEN`).  
**Not** the Arcade install token. Chats go **ONLY** to your pinned Hub (`GOTCHIBOT_DESK_API_BASE` or pin via `hub join` / `hub enable` / `db pin-desk`) — **never** `gotchibot.aarcadeghst.com`. With no pin, chat commands fail with `NO_HUB_PINNED`. Shared Arcade hosts are refused (`SHARED_ARCADE_CHAT`). Missing pair → `NO_DESK_TOKEN`.

```bash
./scripts/gotchibot chats push --text "hello from desk"
./scripts/gotchibot chats pull
./scripts/gotchibot chats threads
./scripts/gotchibot chats snapshot
./scripts/gotchibot chats verify <snapshotId|gotchibot-hub://id>
```

Default thread id: `orch`. Snapshot `stateUri` is opaque `gotchibot-hub://<snapshotId>` (Hub Mongo only — never a URL/hostname on chain). See [`GOTCHIBOT-API.md`](./GOTCHIBOT-API.md).

## Light on-chain checkpoint (opt-in)

After a git commit (TTY), or anytime:

```bash
# one-shot
./scripts/gotchibot chats checkpoint-prompt
# force snapshot + Sepolia send (no prompts)
./scripts/gotchibot chats checkpoint-prompt --onchain
# broadcast only (pin already written)
./scripts/gotchibot chats onchain

# post-commit hook (prompts after each commit)
./scripts/gotchibot chats hook install
# skip one commit: GOTCHIBOT_CHAT_CHECKPOINT=0 git commit …
./scripts/gotchibot chats hook uninstall
```

Flow:

1. Snapshot on **your** Hub (`contentHash` + `stateUri` `gotchibot-hub://…`)
2. Desk `identity checkpoint` with `gameState.chatSync` (local Sepolia file or SIM POST)
3. Optional MetaMask / cast `checkpointSave(cartridgeId, stateHash, stateUri)` on Base Sepolia

Cockpit: **Checkpoint chat sync to Sepolia** (same as `checkpoint-prompt --onchain`).

Pin file: `sessions/.chat-sync-checkpoint.json`.
