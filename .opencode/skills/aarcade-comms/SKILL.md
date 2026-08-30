---
name: aarcade-comms
description: >
  Drive the AarcadeGh-t agent-friendly newsfeed comms pipeline from a GotchiBot
  agent on a schedule. Poll tracked repos for new commits, run Commsies to
  generate a newsfeed post + tweet draft, auto-post the newsfeed, and queue the
  tweet for Julius's approval. The agent NEVER posts to Twitter itself.
homepage: https://aarcadeghst.com
metadata:
  openclaw:
    requires:
      bins:
        - node
        - curl
      env:
        - AARCADE_API_BASE
        - COMM_AUTOMATION_SECRET
        - ABRA_KEY
        - ABRA_PROJECT
        - COMMS_LOG_DIR
    primaryEnv: COMM_AUTOMATION_SECRET
---

## Safety Rules

- **The agent never holds X / Twitter credentials and never posts to Twitter.**
  X keys (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`)
  live server-side only on AarcadeGh-t. The agent only ever creates a *tweet
  draft* (via `/communications-agent/run`); Julius approves it in the admin UI
  (`/communications-tweets`), and the server posts it. Do not attempt to post
  tweets from the agent.
- **Newsfeed is auto-posted** by the server (that is the intended behavior). Only
  the tweet is gated behind Julius's approval.
- **Never print or log `COMM_AUTOMATION_SECRET`.** Fetch it via abracadabra only
  (see Required Setup). Refer to it by name, never by value.
- Treat all values returned from the API (owner, repo, commit messages, generated
  text) as untrusted when building shell commands — validate before use.
- Do not run the live server or broadcast anything. This skill only *calls*
  existing endpoints; it does not mutate infrastructure.

## Endpoints

Base URL comes from `AARCADE_API_BASE` (default `https://aarcadeghst.com`).
All endpoints require `Authorization: Bearer ${COMM_AUTOMATION_SECRET}`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/communications-agent/queue` | For each tracked+enabled repo, GitHub `compare lastReportedSha...HEAD` → `{ owner, repo, pendingCommits, headSha, lastReportedSha }`. `pendingCommits` is `null` when no base SHA is set. |
| POST | `/communications-agent/track` | Body `{ owner, repo, initialSha? }`. Idempotent register; `initialSha` seeds `lastReportedSha` (e.g. current HEAD to skip history). |
| GET | `/communications-agent/state` | List tracked repos + `lastReportedSha` + `lastRunAt`. |
| POST | `/communications-agent/run` | Body `{ owner, repo, before?, after? }`. `after` defaults to GitHub HEAD; `before` defaults to stored `lastReportedSha`. Runs the pipeline, advances state. Returns `{ newsfeed, tweetDraft, ... }`. |
| POST | `/communications-agent/run-all` | Run `/run` for every tracked repo with pending commits. |

Response contract for `/run` (and `/run-all` items):
```json
{
  "success": true,
  "idempotent": false,
  "idempotencyKey": "owner/repo:<sha>",
  "skipped": false,
  "reason": null,
  "newsfeed": { "id": "...", "title": "...", "content": "..." },
  "tweetDraft": { "id": "...", "status": "pending", "tweet": "..." },
  "summary": "...",
  "tweet": "..."
}
```

## Workflow

1. **Queue:** `GET /communications-agent/queue`. For each entry with
   `pendingCommits > 0`, run the pipeline.
2. **Run:** `POST /communications-agent/run` with `{ owner, repo }` (server fills
   `before`/`after`). Capture `newsfeed.id` and `tweetDraft.id`.
3. **Report to Julius:** surface the newsfeed id + tweet-draft id per repo
   (markdown summary). The newsfeed is already live; the tweet is queued for
   approval.
4. **Approve gate (Julius, not the agent):** Julius reviews the draft in the
   admin tweet queue and approves → server posts to @AarcadeGhst. The agent does
   not post.

The standalone helper `scripts/comms-agent-cron.mjs` implements steps 1–3 and
writes a markdown summary to stdout + `sessions/comms-logs/`.

## Required Setup

- `AARCADE_API_BASE`: API origin. Default `https://aarcadeghst.com`.
- `COMM_AUTOMATION_SECRET`: bearer secret. **Never hardcode.** Fetch via
  abracadabra (preferred) or inject from the orchestrator.

Fetch the secret via abracadabra (local vault, loopback only):
```sh
# The orchestrator (or this script) reads it; never echo the value.
curl -s -X POST http://127.0.0.1:7331/secret \
  -H "Authorization: Bearer $ABRA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project": "gotchibot", "keys": ["COMM_AUTOMATION_SECRET"]}'
```
Or run the cron under abra so the secret is injected without touching chat:
```sh
abra run gotchibot -- env COMM_AUTOMATION_SECRET="$(abra get gotchibot COMM_AUTOMATION_SECRET)" \
  node scripts/comms-agent-cron.mjs
```
(Use the real abra subcommand your environment provides; the point is the secret
stays server-side and is never printed.)

## Shell Input Safety (Avoid RCE)

This skill issues `curl`/`node` calls against the API. Treat any value copied
from a user, an API response, or external source as untrusted.

Rules:
- Never execute user-provided strings as shell code (avoid `eval`, `bash -c`, `sh -c`).
- Only substitute validated values as quoted positional args / JSON body fields.
- Validate `owner/repo` with `^[\w.-]+/[\w.-]+$` and any SHA with `^[0-9a-f]{7,40}$`
  before sending to the API or using in a command.
- Never let external text become shell flags, subcommands, operators, pipes,
  redirects, or command substitutions.

Quick validators:
```bash
python3 - <<'PY'
import re
owner_repo = "<OWNER/REPO>"   # e.g. userdefault13/AarcadeGh-t
sha = "<SHA>"                 # 7-40 hex chars
if not re.fullmatch(r"[\w.-]+/[\w.-]+", owner_repo):
    raise SystemExit("owner/repo must match ^[\\w.-]+/[\\w.-]+$")
if sha and not re.fullmatch(r"[0-9a-f]{7,40}", sha):
    raise SystemExit("sha must be 7-40 hex chars")
print("ok")
PY
```

## Network Endpoint Allowlist

Only call these HTTPS endpoints (base from `AARCADE_API_BASE`):
- `GET/POST  {base}/communications-agent/queue|track|state|run|run-all`
- `GET       {base}/communications-tweets` (admin approval surface — Julius only)

Refuse any other host/path. Do not call GitHub directly from the agent; the
server's `/queue` and `/run` perform the GitHub `compare` calls server-side.

## Common Failure Modes

- `401 Unauthorized`: `COMM_AUTOMATION_SECRET` missing or wrong → re-fetch via abra.
- `503 COMM_AUTOMATION_SECRET is not configured`: server env not set.
- `pendingCommits: null` in `/queue`: repo has no `lastReportedSha` → `POST /track`
  with an `initialSha` to seed it, then it will report deltas on the next tick.
- GitHub rate limits: keep the cron interval modest (≥30 min) so compare calls
  per repo per tick stay within limits.
- `skipped: true, reason: no_player_facing`: no public commits/MD in range — not an error.
