# Standing duty: infra-docker (composable)

Optional subset of home infra. Owns Docker watched containers + watcher/verifier
loop (`./scripts/infra-watch.mjs status --json`, schedule truth, paper
`infra-recover`). Wire:

```bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-docker --yes
```

Or seat the full piece pack: `gotchibot templates apply infra-docker --hero <available> --yes`.
