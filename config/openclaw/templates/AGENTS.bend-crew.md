# AGENTS.md — Bend crew suite (`bend-crew`)

This is a **suite pack**, not a single hero seat. It installs and seats the full
Bend crew:

| Member | Job |
|---|---|
| `bend-chief` | Intake, route, merge |
| `bend-laws` | `LAWS.bend` |
| `bend-proofs` | `PROOF.bend` / checker green |

```bash
gotchibot templates install bend-crew --yes
gotchibot templates apply bend-crew \
  --heroes bend-chief=<available>,bend-laws=<available>,bend-proofs=<available> \
  --yes
```

Skill: `bend-2`. Crew index: [`CREWS.md`](CREWS.md).

{{COMMON}}
