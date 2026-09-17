# Standing duty: infra-tailscale (composable)

Optional subset of home infra. Owns Tailscale path only (`tailscale status`,
MagicDNS / 100.x). Mesh/remote ops stay on infra-mesh. Wire:

```bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-tailscale --yes
```
