# cursor-agent — CLI notes (not an OpenCode provider)

Not a live MCP server. Do not add a Cursor provider to `opencode.json`. Do not put Cursor API keys into OpenCode. Bot task logic stays **Hy3 Free** (`opencode/hy3-free`, default) or **Nemotron 3**. Hard logic/code = `./scripts/cursor-cli.mjs` → `cursor-agent`.

Verified 2026-08-30 on MacBook and iMac. Binary: `$HOME/.local/bin/cursor-agent` → `~/.local/share/cursor-agent/versions/…/cursor-agent`. Help banner: `Usage: agent [options] [command] [prompt...]`. **Do not** confuse with `~/.grok/bin/agent` (Grok TUI). `which agent` hits Grok first.

Auth (no secrets): `cursor-agent status` / `whoami` → logged in as Julius's Cursor account, **Pro+**, model **Auto**, `CURSOR_API_KEY` unset. Uses the logged-in subscription — never `--api-key`, never `CURSOR_API_KEY`.

**MBP and iMac** both run Cursor Agent CLI locally when logged in. Prefer `./scripts/cursor-cli.mjs` on the **current host**. If SSH PATH omits `~/.local/bin`, call the full path or set `CURSOR_AGENT_BIN` — do not treat iMac as Cursor-unavailable.

## Allowed command (orch)

Wrapper is the allowed entry:

```bash
./scripts/cursor-cli.mjs run "prompt" [--cwd path] [--mode plan|ask] [--model id] [--new-chat] [--json] [--force]
./scripts/cursor-cli.mjs resume "follow-up"
./scripts/cursor-cli.mjs status
```

Headless `run` execs (verified flags from `cursor-agent --help`):

```
cursor-agent --workspace <cwd> --trust --print --output-format text [--mode plan|ask] [--model <id>] [--force] [--resume <chatId>] <prompt>
```

`create-chat` (wrapper uses this for a new session id): `cursor-agent create-chat`

## Real flags (from `cursor-agent --help`, not guessed)

| Flag | Meaning |
| --- | --- |
| `prompt...` | Initial prompt (argv). Wrapper also accepts stdin. |
| `-p`, `--print` | Headless: print to stdout. Has write + shell tools. **Required** for `run`. |
| `--output-format text\|json\|stream-json` | Only with `--print`. Wrapper default: `text`. |
| `--mode plan\|ask` | `plan` = read-only planning; `ask` = read-only Q&A. Omit = agent (edits). |
| `--plan` | Shorthand for `--mode=plan`. |
| `--resume [chatId]` | Resume a chat. Wrapper stores id in `sessions/.cursor-cli.json`. |
| `--continue` | Continue previous session. |
| `--model <model>` | e.g. `gpt-5`, `sonnet-4-thinking`. Default **Auto** (subscription). Omit unless named. |
| `--list-models` | List models and exit. |
| `-f`, `--force` / `--yolo` | Force-allow commands unless denied. Optional on wrapper. |
| `--auto-review` | Smart Auto classifier. Not default. |
| `--workspace <path-or-name>` | Workspace (wrapper `--cwd`). Default: GotchiBot repo root. |
| `--trust` | Trust workspace without prompting. Wrapper always sets this on `run`. |
| `--add-dir <path>` | Extra workspace root (repeatable). Not used by wrapper. |
| `--api-key <key>` | **Forbidden.** Logged-in account only. Wrapper rejects this flag and unsets `CURSOR_API_KEY`. |
| `-e`, `--endpoint` | Do not pass. Default `https://api2.cursor.sh`. |
| `login` / `logout` | Auth. Orch never logs out. |
| `status` / `whoami` | Login status (no secrets). Wrapper `status` subcommand. |
| `about` | Version / account (no secrets). |
| `create-chat` | Empty chat id for `--resume`. |

## Bash allow (gotchi / verse / plan / build)

Allow the wrapper + CLI. Never `*`. Never Blockscout. Never `* curl`. ask / map stay tighter (no `cursor-agent *`).

```
./scripts/cursor-cli.mjs*
node ./scripts/cursor-cli.mjs*
cursor-agent *
$HOME/.local/bin/cursor-agent *
```

## OpenCode model

Do not switch OpenCode off Hy3 onto a Cursor provider. Launch picker stays hy3-free → Lightning → Ultra; `/model heavy` is still Ultra.
