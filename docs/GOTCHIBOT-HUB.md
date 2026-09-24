# GotchiBot Hub (user-owned) + chat sync

Each install’s **Hub** is their always-on Mac (OpenClaw + gotchibot) on **Tailscale**.
Chat sync + Hub enable/status run on **home infra** (`gotchibot.aarcadeghst.com` → `:8793`),
not Vercel serverless. Register stays on www.

See Aarcade [`GOTCHIBOT-HOME-API.md`](../../AarcadeGh-t/docs/GOTCHIBOT-HOME-API.md).

Rental / Arcade-operated Hubs are a **later** plan (`hub.kind: "rental"` reserved).

## Checklist — host your own Hub

1. **Install + register** on Desk  
   `gotchibot onboard` / `gotchibot infra register` → `GOTCHIBOT_INFRA_TOKEN` in abra.

2. **Hub Mac**  
   - Install Tailscale; note MagicDNS name or `100.x`  
   - Clone GotchiBot; Remote Login (SSH); install desk pubkey  
   - Run OpenClaw / `gotchibot` as you would on the PoC iMac  
   - Run home GotchiBot API LaunchAgent (`com.aarcade.gotchibot-api`) + tunnel ingress  

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

## Chat sync (home Mongo)

Install-token auth. Base: `https://gotchibot.aarcadeghst.com` (`GOTCHIBOT_DESK_API_BASE`).

```bash
abra run gotchibot -- ./scripts/gotchibot chats push --text "hello from desk"
abra run gotchibot -- ./scripts/gotchibot chats pull
abra run gotchibot -- ./scripts/gotchibot chats threads
abra run gotchibot -- ./scripts/gotchibot chats snapshot
```

Default thread id: `orch`.

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

1. Arcade snapshot on `gotchibot.aarcadeghst.com` (`contentHash` + `stateUri`)
2. Desk `identity checkpoint` with `gameState.chatSync` (local Sepolia file or SIM POST)
3. Optional MetaMask / cast `checkpointSave(cartridgeId, stateHash, stateUri)` on Base Sepolia

Cockpit: **Checkpoint chat sync to Sepolia** (same as `checkpoint-prompt --onchain`).

Pin file: `sessions/.chat-sync-checkpoint.json`.
