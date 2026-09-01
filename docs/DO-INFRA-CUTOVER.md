# DO infra cutover checklist

Move the iMac-hosted data plane (subgraph + Aarcade API) to DigitalOcean.
OpenClaw / OpenCode / GotchiBot orchestration stays off DO — only data moves.

- [ ] **DO droplet up** — Envio indexer + Aarcade API services running, health
      endpoints green. Docker compose or systemd, Julius's pick.
- [ ] **Cloudflare DNS** — point `subgraph.aarcadeghst.com` (and API host) at
      DO. Keep the CF proxy orange-cloud only if tunnel is removed; otherwise
      repoint the cloudflared tunnel config to DO origins.
- [ ] **Vercel upstream → DO** — SPA rewrites/proxy to the DO Aarcade API
      instead of the iMac tunnel. SPA remains on Vercel.
- [ ] **Dual-run** — run DO and iMac origins in parallel; GotchiBot
      `config/subgraph.endpoints.json` can pin either host per environment.
- [ ] **Smoke** — wallet-roster, identity roster, subgraph queries, trader
      desk reads — all green against DO for a few days.
- [ ] **Retire iMac origin** — shut down the iMac Envio/Aarcade API services
      and the cloudflared tunnel for the data plane. The iMac can keep being
      a fleet worker (OpenClaw) — just not a data origin.

Do **not** put OpenClaw, OpenCode serve, or sub-agent spawning on DO. Those
stay on Julius's machines (Solo) or the iMac (Fleet).
