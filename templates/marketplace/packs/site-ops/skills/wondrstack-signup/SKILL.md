---
name: wondrstack-signup
description: >-
  Connect a project to WondrStack with the device-code link
  (`gotchibot wondrstack link`): the owner approves in a browser by matching a
  short code, then compose the business with the WondrStack MCP tools. Load when
  a project has no WondrStack sign-in yet.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: site-ops
---

# wondrstack-signup

Primary path: the device link. No password, no mailbox code, no token file.
Use it only when `./scripts/gotchibot wondrstack status <project>` shows the
project is not linked. If a sign-in already exists, use the `wondrstack` skill.

## Hard rules

1. **Ask the owner first, and warn them.** Never start `link` without a yes in
   this conversation. Name the project and say they will approve in a browser.
   Before starting, tell them: approval grants the FULL `wondrstack` scope,
   including every WondrStack tool. There is no read-only scope yet.
2. **Show the code, not secrets.** Print the verification link and the short
   user code, and tell the owner to confirm the code matches the one on the
   approval page (if not, do not approve). Never print tokens or the device code.
3. **Tokens live in abra only** (`WONDRSTACK_<PROJECT>`), written by the command.
   No token file. Never echo, log or paste them.
4. **No retry loops.** The link expires in about 10 minutes. On denied or
   expired, report it and ask before running `link` again.
5. **The client id is registered per install** on first run (`/oauth/register`)
   and cached with its base URL; a different base re-registers. If registration
   fails, report the message and stop.
6. **After linking**, compose the business with the WondrStack MCP tools
   (`list_templates`, `recommend_setup`, `create_business`, and so on),
   proposing each step first. Because the grant is full, **always ask first
   before deploy, delete, or anything that spends money.**

## For the owner: no typing

The owner can connect from the cockpit instead (Ctrl+Space, Shift+K, Desk panes…, WondrStack) or `gotchibot wondrstack pane`. It shows link state, the warning, the code and a countdown, and has Disconnect. Disconnect only removes stored tokens from abra; WondrStack revocation is not supported by this client.

## For an agent (no terminal)

Two steps, never automatic. First ask the owner and explain the full-scope warning.
Only after their yes:

1. Start: the `wondrstack_link_start` tool with `confirm_full_scope: true`
   (CLI: `gotchibot wondrstack link --json --confirm-full-scope`). Post the
   `verification_uri` (and `verification_uri_complete`) and the `user_code` in
   chat, and say the owner must confirm the code on the page matches.
2. Wait: the `wondrstack_link_wait` tool (CLI: `link --wait`). It returns `linked`,
   `pending` (call again) or `failed` with kind denied, expired or error.

Never approve for the owner. The pending device code is kept in a 0600 file under
`sessions/wondrstack/` and never printed. For a local WondrStack set
`WONDRSTACK_DEVICE_BASE_URL` (the project then defaults to `gotchibot-local`, so
tokens never mix with production's `WONDRSTACK_GOTCHIBOT`).

## Command

```sh
./scripts/gotchibot wondrstack link [--project gotchibot]
./scripts/gotchibot wondrstack status <project>   # prints "linked: yes" when it works
```

Config (env overrides, all optional): `WONDRSTACK_DEVICE_CLIENT_ID` (skips registration),
`WONDRSTACK_DEVICE_BASE_URL` (`https://wondrstack.xyz`), `WONDRSTACK_DEVICE_REGISTER_PATH`,
`WONDRSTACK_DEVICE_AUTH_PATH`, `WONDRSTACK_DEVICE_TOKEN_PATH`, `WONDRSTACK_DEVICE_SCOPE` (`wondrstack`).

## Steps (after the owner's yes)

1. Run `link`; relay the link and short code to the owner verbatim.
2. Wait. The command polls at the server's interval and stops by itself.
3. On `linked`: run `status <project>` and quote it.
4. On failure: quote the reason and stop (rule 4).
5. Compose the business (rule 6).

## Old headless path (legacy, not the main flow)

The old email-code script (`headless-signup.mjs`) is superseded; the temporary
account `gotchibot-temp@gotchibot.xyz` must not be created. The abra secret
`WONDRSTACK_TEMP_PASSWORD` is unused and can be deleted by Julius.
