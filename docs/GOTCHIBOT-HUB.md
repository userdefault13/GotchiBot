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

After a git commit, optionally:

```bash
abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt
# or non-interactive:
GOTCHIBOT_CHAT_CHECKPOINT=1 abra run gotchibot -- ./scripts/gotchibot chats checkpoint-prompt --onchain
```

Builds an Arcade snapshot (`stateUri` + `contentHash` + `gitCommit`), writes
`sessions/.chat-sync-checkpoint.json`. On-chain save still goes through
`gotchibot checkpoint` / identity — never silent MetaMask.
