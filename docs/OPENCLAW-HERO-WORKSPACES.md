# OpenClaw hero workspaces

## Why this exists

OpenClaw builds a hero's system prompt from the files in its **workspace**
(`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `memory/`) and discovers skills
in `<workspace>/skills/` and `~/.openclaw/skills/`. `agentDir` is state only
(auth profiles, sessions); nothing in it is ever injected.

Until 2026-09-08 every fleet hero shared one workspace, the repo root. So LINK,
YFI, DAI and WBTC all booted with the root `SOUL.md` ("your hero id is
`owned-954`, you are the main bot") and a 10 KB `AGENTS.md` that asked them to
pick their own role, while the per-hero prompt that `openclaw-fleet.mjs sync`
wrote into `agentDir` was never read. Their prompts also said "Skills to load:
delegate-first, hub-sop, …" — skills that live in `.opencode/skills/`, a
directory OpenClaw does not scan, so no hero could load any of them. A small
model given that picture cannot behave; a large one guesses.

## What sync does now

`./scripts/openclaw-fleet.mjs sync` renders, per hero:

```
config/openclaw/workspaces/<heroId>/
  AGENTS.md      from templates/AGENTS.<role>.md + AGENTS.common.md
  SOUL.md        from templates/SOUL.md
  IDENTITY.md    from templates/IDENTITY.md
  USER.md        copy of the repo-root USER.md
  memory/        per hero (the orchestrator's is a symlink to the repo memory/)
  skills/<name>/ copies of .opencode/skills/<name> for that hero's allowlist
  repo -> ../../../..   the GotchiBot tree
```

and emits `agents.entries.<id>` with `workspace`, `agentDir`, and a `skills`
allowlist. Role comes from `config/agent-roles.json`; commands and skills from
`config/agent-role-playbooks.json`. If the cartridge API is down, sync reuses the
last generated roster instead of shrinking the fleet to the orchestrator.

`./scripts/openclaw-fleet.mjs doctor` fails when any hero has a missing bootstrap
file, a file over OpenClaw's 20 000-char cap, an unresolved `{{PLACEHOLDER}}`, a
skill in its allowlist that is not copied or whose frontmatter `name` differs from
its directory, or an `AGENTS.md` that names a `./scripts/<file>` that does not
exist. Sync runs doctor and prints the problems.

## Editing a hero's behaviour

1. Edit `config/openclaw/templates/AGENTS.<role>.md` (a decision table: what
   Julius says → the exact command → what to reply). Keep it short; the free
   models are the audience.
2. `./scripts/openclaw-fleet.mjs sync && ./scripts/openclaw-fleet.mjs doctor`
3. Push to the Hub and restart the gateway so `agents.entries` reloads:
   `abra run gotchibot -- ./scripts/gotchibot remote-push`
   `abra run gotchibot -- ./scripts/gotchibot remote -- 'cd ~/Dev/GotchiBot && node scripts/openclaw-fleet.mjs sync'`
   `abra run gotchibot -- ./scripts/gotchibot hub restart-gateway`

Do not hand-edit anything under `config/openclaw/workspaces/`; sync overwrites it.

## Live check: `doctor --live`

`./scripts/openclaw-fleet.mjs doctor --live` sends one "pong" prompt through the
gateway to the orchestrator and to the `/switch`-focused hero (probe sessions,
not main) and prints the upstream error verbatim. `/healthz` and `GET /v1/models`
stay green while every hero is dead behind a revoked model key; this is the
check that shows `401 Invalid API key.` on day one. Run it after any deploy.

## /switch → talk to a hero directly

`sessions/.focus.json` (written by `/switch`, `agent-focus.mjs select`, `/orch`)
is the single source of truth. Two things read it per request, so a switch takes
effect on the next prompt with no pane restart:

- `scripts/opencode-gotchi-relay.mjs` (the `openclaw/orchestrator` provider) now
  targets the focused hero's `agent:<id>:main` session instead of always the
  orchestrator.
- `.opencode/plugins/gotchi-focus-route.js` injects a one-command rule into the
  gotchi pane's system prompt while focus is SUB: run
  `./scripts/agent-focus.mjs chat --sub "<message>"` and relay stdout verbatim.
  Free models kept forgetting the same rule when it only lived in `gotchi.md`.

## Hero schedules

Every hero that is supposed to run on a clock has one command that installs the
clock on the host it runs on and one that tells the truth about it. The prompts
only ever quote the status command.

| Hero | Command | What it installs |
|---|---|---|
| LINK | `gotchibot trader schedule status\|install\|uninstall\|run-now` | launchd `com.gotchibot.trader-cycle`, every 1800 s, runs `trader-cycle.mjs` |
| YFI | `gotchibot infra schedule status\|install\|uninstall\|run-now` | launchd `com.gotchibot.infra-watch`, every 900 s, runs `infra-watch-ensure.sh` (supervises the resident 60 s watcher) |
| WBTC | `gotchibot comms schedule status\|install` (via abra from the Desk) | iMac crontab `50 23 * * *` (23:50 America/Los_Angeles) running the comms wrapper |

Install LINK's and YFI's on the iMac (`gotchibot remote -- 'cd ~/Dev/GotchiBot && …'`);
WBTC's is installed over SSH by the deploy script and needs `COMM_AUTOMATION_SECRET`
in abra. `scripts/lib/launchd-job.mjs` is the shared launchd code.

## LINK's schedule

`./scripts/gotchibot trader schedule install` on the iMac installs the launchd
job that wakes `trader-cycle.mjs` every 1800 s; `status` reports plist, loaded
state, last cycle and verdict, verify workspace and webhook; `run-now` kicks a
cycle. LINK's prompt and the playbook now describe only that waker. cron402 is
the intended future waker and is not wired (no ingress, no job).

## Things that still bite

- Sandbox: fleet entries now carry `sandbox.mode: "off"` and the deploy default is `non-main`; doctor fails if a hero would resolve to `all`. Earlier the deploy set `agents.defaults.sandbox.mode`
  to `all`. In sandbox mode a hero's tools run inside a container that mounts only
  its workspace, so `repo ->` and every `./scripts/...` row are invisible and tmux,
  docker and the Claude CLI are unreachable. Check `agents.defaults.sandbox` on the
  Hub; these heroes need host tools.
- `agentDir` still lives inside the repo (`config/openclaw/agents/<id>/`), and
  `remote-push` rsyncs with `--delete`, so a push from the MBP can wipe iMac-side
  session/auth state in those dirs. Moving `agentDir` to `~/.openclaw/agents/<id>`
  is the fix; it is not done here because it moves live auth profiles.
