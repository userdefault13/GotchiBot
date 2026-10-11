---
name: wondrstack-signup
description: >-
  Sign a project up to WondrStack headlessly (email verification code, no
  browser) with wondrstack's headless-signup script, then compose the business
  with the WondrStack MCP tools. LIVE USE IS BLOCKED for now; dry-run only.
  Load when a project has no WondrStack account yet and UserDefault asks to
  create one.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: site-ops
---

# wondrstack-signup

Wraps `headless-signup.mjs` in the wondrstack repo. The script is at
`~/dev/wondrstack/apps/website/scripts/headless-signup.mjs`; run it from
`apps/website` (commit `e05b177` on `fix/verified-signup`, not pushed). Use it only when
`./scripts/gotchibot wondrstack status <project>` shows the project has no
sign-in. If a sign-in already exists, use the `wondrstack` skill instead.

## Hard rules

1. **Ask first.** Never sign up or launch without UserDefault's yes in this
   conversation. Name the project, the email and the base URL when you ask.
2. **Mail first.** Run `gotchibot mail check` before anything. If it fails, show
   its server-down prompt (start the server / use another computer / use Gmail)
   and stop. Do not start the server yourself.
3. **Secrets go through abra only.** The password is read from the env var
   `WONDRSTACK_PASSWORD`, loaded from abra for this one command. The token file
   is written at mode 600, moved into abra as `WONDRSTACK_<PROJECT>`, and then
   deleted from disk. Never echo, log, paste or print the password, the
   verification code or the tokens. Report only `linked` or `failed: <reason>`.
4. **LIVE USE IS BLOCKED** until the verified-signup branch is deployed and the
   SMTP relay exists (SMTP work is paused by Julius). Until then dry-run against
   a local dev copy of WondrStack only (a loopback `--base`), never
   production, and say it was a dry run.
5. **After linking**, compose the business with the WondrStack MCP tools
   (`list_templates`, `recommend_setup`, `create_business`, `deploy_app`, and
   so on), proposing each step to UserDefault first. `launch` in the
   `wondrstack` skill covers the repo and hosting pipeline.

## Identity

Sign up with `admin@gotchibot.xyz` (not `.com`) for the gotchibot project. The
verification mail arrives in the `gotchibot.xyz` mailbox with the subject
`Your WondrStack verification code` and a body like
`Your WondrStack verification code is 123456. It expires in 10 minutes...`.
The script extracts the code with `is (\d{6})\.`.

## Command

```sh
# from ~/dev/wondrstack/apps/website
node scripts/headless-signup.mjs --base <url> --email admin@gotchibot.xyz \
  --password-env WONDRSTACK_PASSWORD \
  --code-cmd 'gotchibot mail read --as gotchibot.xyz' \
  [--code-env WONDRSTACK_CODE] [--redirect <loopback url>] \
  --out <tokens.json | ->
```

It prints one stderr line: `linked (...)` or `failed: <reason>`. Tokens go to
`--out` at mode 600. `--code-cmd` is any shell command that prints the mail
body; `--code-env` reads the code from an env var instead.

## Steps (once unblocked, and after the yes)

1. `gotchibot mail check`, and stop on failure (rule 2).
2. Load the password from abra into `WONDRSTACK_PASSWORD` for this process only.
3. Run the command with `--out` set to a temp file outside the repo.
4. On `linked`: move the token file into abra, delete it from disk, then run
   `./scripts/gotchibot wondrstack status <project>` and quote it.
5. On `failed: <reason>`: quote the reason, delete any token file, and stop.
   Never retry in a loop; each try sends a mail.
6. Compose the business with the MCP tools (rule 5).

## Dry run (local only, the only allowed mode for now)

With no SMTP the dev server logs the verification code, so read it from the
Nuxt log instead of `gotchibot mail read`:

```sh
--code-cmd "grep -o 'is [0-9]\{6\}\.' <nuxt.log> | tail -1"
```

Needs a throwaway local mongo and `nuxt dev` on `127.0.0.1`, both started
detached from the shell (so they outlive the command). Use a loopback `--base`
and a throwaway email, never `admin@gotchibot.xyz`. No mail is sent.

Verified results (local only):

- New email: `linked (signed up); get_status: ok`.
- Rerun with the same email: `linked (account already existed, logged in)`.
- Wrong password: `failed: verification failed and login refused`, and no
  token file is written.

- Temp account: gotchibot-temp@gotchibot.xyz (password in abra as WONDRSTACK_TEMP_PASSWORD) is to be dropped and re-created through the verified flow after the fix deploys; nothing important may sit on it (the old live signup has an account-takeover hole).
