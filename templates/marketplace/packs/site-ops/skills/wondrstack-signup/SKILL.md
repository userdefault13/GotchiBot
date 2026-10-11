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

1. **Ask the owner first.** Never start `link` without a yes in this
   conversation. Name the project and say they will approve in a browser.
2. **Show the code, not secrets.** Print the verification link and the short
   user code, and tell the owner to confirm the code matches the one on the
   approval page (if not, do not approve). Never print tokens or the device code.
3. **Tokens live in abra only** (`WONDRSTACK_<PROJECT>`), written by the command.
   No token file. Never echo, log or paste them.
4. **No retry loops.** The link expires in about 10 minutes. On denied or
   expired, report it and ask before running `link` again.
5. **Not live until confirmed.** The client id, base URL and endpoint paths are
   TODO until WondrStack confirms them. If `link` says the client id is TODO,
   stop and report; do not guess values. Do not run against the live site until then.
6. **After linking**, compose the business with the WondrStack MCP tools
   (`list_templates`, `recommend_setup`, `create_business`, and so on),
   proposing each step first. The first grant is read tools plus `create_business`;
   other tools may be refused. `launch` in the `wondrstack` skill covers repo and hosting.

## Command

```sh
./scripts/gotchibot wondrstack link [--project gotchibot]
./scripts/gotchibot wondrstack status <project>   # prints "linked: yes" when it works
```

Config (env overrides): `WONDRSTACK_DEVICE_CLIENT_ID` (required),
`WONDRSTACK_DEVICE_BASE_URL`, `WONDRSTACK_DEVICE_AUTH_PATH`
(`/oauth/device_authorization`), `WONDRSTACK_DEVICE_TOKEN_PATH` (`/oauth/token`),
`WONDRSTACK_DEVICE_SCOPE`.

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
