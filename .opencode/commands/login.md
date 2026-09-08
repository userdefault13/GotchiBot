---
description: Login — restore the OpenCode Go credential in auth.json (console API key; subscription quotas, not balance)
---

Julius has an OpenCode Go **subscription**. Per OpenCode's source and docs, the
Go provider has no OAuth flow: its credential is the API key from the console
(opencode.ai/auth → API Keys), pasted into `opencode auth login` → **OpenCode Go**,
which stores it in `~/.local/share/opencode/auth.json`. That key routes to the
Go subscription quotas; pay-as-you-go balance is only used if "Use balance after
limits" is enabled in the console (it is off).

Do NOT suggest `OPENCODE_API_KEY` in env/abra or an `opencode.json` provider
override — that is the on-demand path GotchiBot used to force, and it shadows the
built-in provider. The credential lives in auth.json and nowhere else.

If `$ARGUMENTS` is `status`:

```bash
./scripts/gotchibot login --status
```

Otherwise:

```bash
./scripts/gotchibot login
```

That opens a Terminal window running `opencode auth login`. Tell Julius: in the
provider list type **opencode**, pick **OpenCode Go**, and paste the API key
copied from the console (API Keys tab). The command waits for the credential store to appear, then
reports provider names (never values) and how many `opencode-go/*` models are
visible.

Report the result plainly:
- `opencode-go/* > 0` → logged in; say the Gotchi TUI must be relaunched to pick it up.
- still `MISSING` or `0` → say the login did not complete and ask them to check the window.

Never print anything from `auth.json`.
