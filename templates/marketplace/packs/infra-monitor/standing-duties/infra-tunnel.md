# Standing duty: infra-tunnel (composable)

Optional subset of home infra. Owns Cloudflare tunnel / public subgraph
(`./scripts/gotchibot tunnel status`). Wire:

```bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-tunnel --yes
```
