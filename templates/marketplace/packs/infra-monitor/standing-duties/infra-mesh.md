# Standing duty: infra-mesh (composable)

Optional subset of home infra. Owns GotchiBot agent mesh + remote Hub ops
(`./scripts/gotchibot mesh`). Path fail → Tailscale first. Wire:

```bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-mesh --yes
```
