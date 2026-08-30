# Plan: Agent-friendly newsfeed comms pipeline (gotchibot-driven)

## Goal
Make the `communications-auto` pipeline drivable by a **gotchibot agent on a schedule**: the agent polls tracked repos for new commits since the last-reported SHA, runs Commsies to generate a newsfeed post + tweet draft, **auto-posts the newsfeed**, and **queues the tweet for Julius's approval** (approve gate). Last-reported SHA is tracked per `owner/repo` (multi-repo).

Decisions confirmed with Julius:
- **Tweet autonomy:** Draft + approve gate (agent queues; Julius approves via existing tweet queue).
- **Trigger:** Scheduled cron (agent polls since last-reported).
- **Scope:** All game repos, multi-repo state.

## Current state (findings)
- Bot = `communications-auto`. Trigger: `.github/workflows/comms-auto.yml` (push to main/master) → `POST /api/communications-auto` `{owner,repo,before,after}`.
- Two implementations:
  - `api/communications-auto.js` — Vercel serverless handler, **BROKEN** requires (`../lib/...` → `api/lib/` doesn't exist).
  - `api/routes/communications-auto.js` — Express router, correct `../../lib/...`. `server.cjs` mounts this one at `/communications-auto`.
- Core logic: `lib/commsGithub.cjs` → `fetchCommitsInRange` (GitHub `compare base...after`, newest-first, max 30); `lib/commsPublicFilter.cjs` filters admin commits; `lib/commsNewsfeed.cjs` inserts newsfeed; `lib/commsTweetDrafts.cjs` queues tweet draft; `lib/xTweet.cjs` posts (used by admin approve).
- **No stored "last reported commit"** — `before` comes from the push event; idempotency is keyed on `after` in `comms_tweet_drafts`.
- Tweet approval already exists: `api/communications-tweets.js` + `tweetsRouter` (approve/discard/update) → posts via `postTweet`. This is the approve-gate surface the agent reuses.

## Changes — AarcadeGh-t repo

### 1. Shared comms core lib (fixes broken handler + dedupes)
- New `lib/commsRun.cjs` exporting `runCommsForRange({ owner, repo, before, after, opts })`:
  - idempotency check on `${owner}/${repo}:${after}`
  - `fetchCommitsInRange` → `filterPublicCommits` → `collectMdFiles` → `filterPublicMdFiles`
  - call Commsies `/parse`, sanitize
  - `insertNewsfeedFromCommsies` (auto newsfeed) + fire `dao.newsfeed_post` push
  - `upsertPendingTweetDraft` (queue tweet)
  - if `opts.updateState`: `setLastReportedSha(owner, repo, after)`
  - returns normalized `{ newsfeed, tweetDraft, commits, skipped, idempotent }`
- Refactor `api/routes/communications-auto.js` to call `runCommsForRange`.
- Fix `api/communications-auto.js`: repoint requires to `../../lib/...` (or re-export the route handler) so the Vercel deployment loads.

### 2. Repo state collection (multi-repo last-reported SHA)
- `lib/mongodb.cjs`: add `getCommsRepoStateCollection()` → `comms_repo_state`; unique index `{ owner:1, repo:1 }`.
- New `lib/commsRepoState.cjs`: `getRepoState`, `setLastReportedSha`, `listTrackedRepos`, `trackRepo(owner,repo,initialSha?)`.
- Doc: `{ owner, repo, lastReportedSha, lastRunAt, lastCommitCount, enabled, createdAt, updatedAt }`.

### 3. Agent-facing route `api/routes/communications-agent.js` (mount at `/communications-agent`)
- `GET /queue` — for each tracked+enabled repo, GitHub `compare lastReportedSha...HEAD`; return `[{ owner, repo, pendingCommits, headSha, lastReportedSha }]`. One call tells the bot what's pending.
- `POST /track` — `{ owner, repo, initialSha? }`; idempotent register. `initialSha` seeds `lastReportedSha` (e.g. current HEAD to skip history).
- `GET /state` — list tracked repos + `lastReportedSha` + `lastRunAt`.
- `POST /run` — `{ owner, repo, before?, after? }`: `after` defaults to GitHub HEAD; `before` defaults to stored `lastReportedSha`; calls `runCommsForRange({ updateState:true })`; returns result.
- `POST /run-all` (optional) — run `/run` for every repo in `/queue` with pending commits.
- Auth: `COMM_AUTOMATION_SECRET` Bearer (same as auto).

### 4. Wire into `api/server.cjs`
- `const { agentRouter } = require('./routes/communications-agent'); app.use('/communications-agent', agentRouter);`

### 5. Push path also advances state (optional but recommended)
- Have `runCommsForRange` set `lastReportedSha = after` when called from `communications-auto` too, so `/queue` stays accurate between cron runs.

## Changes — GotchiBot repo (the agent)

### 6. Skill `aarcade-comms` (mirror baazaar skill format)
- `GotchiBot/.opencode/skills/aarcade-comms/SKILL.md` documenting:
  - Endpoints (base from `AARCADE_API_BASE`, default `https://aarcadeghst.com`).
  - Auth: `COMM_AUTOMATION_SECRET` fetched via abracadabra only; never log it.
  - Workflow: `GET /communications-agent/queue` → for each pending `POST /communications-agent/run` → report newsfeed + tweet-draft ids to Julius. Tweet stays in approve gate.
  - Safety: agent **never** holds X keys; posting is server-side only after Julius approves. Agent must not call post-tweet unless an explicit auto-post policy is set (out of scope v1).
  - Shell input safety: validate `owner/repo` `^[\w.-]+/[\w.-]+$`, sha `^[0-9a-f]{7,40}$`.

### 7. Cron script `scripts/comms-agent-cron.mjs` (GotchiBot)
- Reads `AARCADE_API_BASE` + secret via abra.
- `GET /queue`, loops pending repos, `POST /run` each, writes a short markdown summary (newsfeed + tweet-draft ids) to stdout/log and surfaces it to Julius.
- Invoked by the gotchibot scheduler (cron on iMac) as a cAavegotchi-bound session.

### 8. Scheduling
- Register a cron (e.g. every 30–60 min) on the iMac orchestrator that runs the gotchibot comms agent with `scripts/comms-agent-cron.mjs`. Reuse `gotchi-orchestrate.mjs` / existing cron patterns. (Deployment detail.)

## Verification
- `POST /communications-agent/track` test repo with `initialSha` = an old commit → `GET /queue` shows `pendingCommits > 0` → `POST /communications-agent/run` creates a newsfeed entry + tweet draft → `GET /communications-agent/state` shows `lastReportedSha` advanced to HEAD.
- Tweet draft appears in admin tweet queue (`communications-tweets`); Julius approves → posts to @AarcadeGhst.
- `api/communications-auto.js` (Vercel) loads without "Cannot find module" after require fix.
- Run `scripts/comms-agent-cron.mjs` once manually for end-to-end validation.

## Risks / notes
- GitHub API rate limits: compare calls per repo per tick; keep cron interval modest, cache HEAD via state.
- X posting stays gated; future auto-post = add `COMMS_TWEET_POLICY=auto` + agent check.
- Secrets: agent only ever sees `COMM_AUTOMATION_SECRET` (via abra); X creds stay server-side.
