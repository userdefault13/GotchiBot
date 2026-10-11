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
