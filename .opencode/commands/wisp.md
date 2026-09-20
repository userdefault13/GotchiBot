---
description: Wisp model — Aavegotchi soul chat via Gotchi Closet (stay on gotchi agent)
agent: gotchi
---

Stay on **gotchi** (project chat). Wisp is a **/model**, not a Tab agent.

1. Ensure key + proxy:

```bash
./scripts/gotchibot wisp status
./scripts/gotchibot wisp-proxy --check || (./scripts/gotchibot wisp-proxy &>/dev/null & sleep 1)
```

2. If no key yet:

```bash
./scripts/gotchibot wisp mint
```

3. Switch model in OpenCode: **`/model wisp/gotchi`**

If `$ARGUMENTS` is a token id (digits), remember it for the proxy:

```bash
mkdir -p sessions
node -e "const fs=require('fs');const p='sessions/.wisp.json';let m={};try{m=JSON.parse(fs.readFileSync(p,'utf8'))}catch{};m.lastTokenId=String(process.argv[1]);m.updatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');" $ARGUMENTS
```

Then say gm / ask about that gotchi. Never print `wsp_` keys. Never `mode wisp`.
