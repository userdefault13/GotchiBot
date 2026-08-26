# GotchiBot Agent Rules

This file is injected into every agent session (orchestrator + sub-agents).
Read it before doing anything else.

## What you are

You are one agent in the GotchiBot orchestrator swarm. The gotchi (Cursor CLI)
decomposes tasks and spawns sub-agents like you via
`scripts/opencode-dispatch.sh`. Your session directory is `sessions/<id>/`.

## Session protocol

Your session dir contains:

- `prompt.txt` — the task you were spawned with
- `state.env` — model/status/timestamps (managed by the dispatch wrapper)
- `output.md` — write your final result here
- `output.log` — stderr/diagnostics
- `skill-requests.jsonl` — append one JSON object per missing skill:
  `{"skill":"<name>","reason":"<why>","requestedAt":"<iso8601>"}`

## Hard rules

1. NEVER install anything autonomously — no `npm i -g`, no new MCP servers,
   no skill installs. If you need a tool or skill not in
   `skills/registry.json`, append a request to `skill-requests.jsonl` and
   continue without it if possible.
2. Secrets never touch disk or prompts. If you need a credential, ask for it
   to be fetched through abracadabra (`abra` MCP) by the orchestrator.
   Never echo secret values into logs or output files.
3. Write your deliverable to `output.md`. It is the only file merged on
   fan-out completion.
4. Stay inside this repo's working tree unless the prompt says otherwise.

## Model tiers

| Tier | Model | Use |
|---|---|---|
| default | `opencode/nemotron-3.5-lightning-free` (`--model nim`) | routine coding (no API key) |
| reasoning | `opencode/nemotron-3-ultra-free` | set `GOTCHIBOT_OPENCODE_MODEL` for heavier tasks |
| escalation | `deepseek/deepseek-v4-pro` | hard reasoning (needs DEEPSEEK_API_KEY) |
| fallback | `ollama/qwen2.5:3b` | offline/private |

NVIDIA_API_KEY flows through abracadabra (`abra run gotchibot -- ...`); opencode
reads it via `{env:NVIDIA_API_KEY}` — it is never written to disk.

## Data sources

Gotchi data comes from the AarcadeGh-t tunnel subgraphs
(`config/subgraph.endpoints.json`). Never hit LAN IPs directly; always use
the tunnel hostnames.
