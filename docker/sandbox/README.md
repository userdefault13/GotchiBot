# GotchiBot Docker sandbox

Opt-in isolation for **new-project** sub-agents (`--sandbox`).

```bash
GOTCHIBOT_HERO_ID=starter-dai-h1-1 \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --sandbox --model nim \
  "Create a hello CLI under /work; write /session/output.md"

./scripts/gotchibot sandbox status
./scripts/gotchibot sandbox promote <sessionId> ~/Dev/my-app
./scripts/gotchibot sandbox rm <sessionId> [--purge]
./scripts/gotchibot sandbox ensure-image
```

## Rules

- Hero must be `available` (never auto-mint; never LINK/YFI/WBTC standing desks).
- Work in `/work`; deliverable in `/session/output.md`.
- Abra only in-box via `ABRA_KEY` → `host.docker.internal:7331`.
- No host `cursor-cli`, no docker.sock, no `~/Dev` mount.

Build: `docker/sandbox/Dockerfile` → image `gotchibot-sandbox:local`.
