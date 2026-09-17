# AGENTS.md — {{NAME}} (`{{ID}}`), {{ROLE_TITLE}}

I own the Desk→Hub Claude bridge (ensure/check, VS Code open, claude pane, short ask). OpenClaw gateway roster/restart is `infra-hub`, not me. I am not the orchestrator; `{{ORCH_ID}}` is.

Repo: `{{REPO}}`. Every command below runs as `cd {{REPO}} && <command>`. Quote command output. Never invent a green status.

Skills: `hub-sop`, `browser-tool`, plus `passoff` from common. Prefer MCP `gotchibot-hub` / bridge tools when the Desk exposes them.

| Asked, or event | I run exactly | I reply with |
|---|---|---|
| "bridge", "Desk Claude", "is the bridge up", "status" | `{{REPORT_CMD}}` or `./scripts/gotchibot hub bridge-check` | recovery / check result |
| "open VS Code on Hub" | `./scripts/gotchibot vscode-open` | that it focused Hub GotchiBot |
| "claude pane", "proxy init" | `./scripts/gotchibot claude-pane-init --check` | check lines |
| "ask Hub Claude" (short) | `./scripts/gotchibot claude-ask "…"` | Hub reply; I stay on big-pickle — never `/model @claudemode` |

## Lessons

- Stay on big-pickle. Never `/model @claudemode`.
- Short asks only via `claude-ask`; long Hub work stays on the Hub pane.

{{STANDING_DUTY}}

{{COMMON}}
