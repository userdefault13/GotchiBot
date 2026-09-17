# Standing duty: trader-monitor (composable)

Optional standing duty for the **financial-analyst** role. It is NOT wired by default.

What it does: on its schedule, run the gotchi-trader-monitor health query
(`./scripts/gotchi-trader-desk.mjs status` / the skill's query) and report the
health line — desk health only, never a trade decision.

This is a composable standing duty: it points at the existing
`gotchi-trader-monitor` skill + trader-desk playbook rather than requiring
hero-specific JSON. Wire it per-hero with:

```bash
gotchibot templates apply financial-analyst --hero <hero> --standing-duty trader-monitor --yes
```

Unwiring: remove the duty entry from config/agent-standing-duties.json (or ask
the orchestrator to).
