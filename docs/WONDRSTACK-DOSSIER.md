# WondrStack in the project Dossier

The Dossier shows a **WondrStack** tab only when its current GotchiBot project is linked to a WondrStack workspace. The binding is stored at `sessions/pstack/<project>/wondrstack.json` and follows that project when desk and hub project files sync. It stores workspace identity and a bounded, read-only goal snapshot. OAuth tokens remain in the client's OpenClaw installation.

On the **client-owned** GotchiBot installation, configure WondrStack MCP and complete `openclaw mcp login wondrstack`, then check `openclaw mcp probe wondrstack`. Call the authenticated `get_status` tool and save its JSON result to a temporary file. Compare the returned workspace slug and app URL with the intended business, then link the project with:

```sh
./scripts/gotchibot pstack wondrstack connect <gotchibot-project> <get_status-json-file> <expected-workspace-slug>
```

In Dossier, press `w` for WondrStack and `d` for Overview. The WondrStack tab shows the workspace confirmed by that `get_status` result and the last goal snapshot. The tab is a saved snapshot; probe the MCP again to confirm current access.

To update the monetary goals, have the client's authorized CoS call WondrStack's `list_business_goals` MCP tool and save its JSON result to a temporary file. Then run:

```sh
./scripts/gotchibot pstack wondrstack sync <gotchibot-project> <list_business_goals-json-file>
```

The sync accepts results only when their `workspace` matches the linked workspace. It keeps goal title, target, period, latest owner-reported actual, plan route, and review time; other MCP fields are discarded. The tab labels the sync time and owner-reported source. Do not copy OAuth tokens into this file. `gotchibot pstack wondrstack disconnect <gotchibot-project>` hides the tab and syncs that disconnected state to the hub.

## Deterministic launch from GotchiBot (no model in the loop)

Each GotchiBot project has its own WondrStack account (one workspace per account): the `aarcadeghst` project signs in as the aarcadeghst account, `gotchibot` as the gotchibot one. GotchiBot keeps each project's sign-in in abra as `WONDRSTACK_<PROJECT>` and never prints it.

```sh
./scripts/gotchibot wondrstack login  <project>        # browser sign-in for that project's account (PKCE, loopback)
./scripts/gotchibot wondrstack status <project>        # get_status + the next step
./scripts/gotchibot wondrstack launch <project> --city C --state S --country X [--name N] [--type T] [--template blank] [--hosting vercel] [--wait]
./scripts/gotchibot wondrstack call   <project> <tool> '{"…":"…"}'
```

`launch` reads `get_status` and does only the next step, so it can be re-run at any point: no workspace → `create_business` (business name defaults to the project, template `blank`, hosting `vercel`) · repo missing or failed → `start_provisioning` · repo building → wait · no host → it opens WondrStack's secure hosting page, where you paste the Vercel token (GotchiBot never sees it) · deploy failed → `deploy_app` once · deploying → wait · live → the project is linked (`wondrstack.json`: workspace, app URL, app repo). It stops if the sign-in belongs to another project's workspace. The app repo WondrStack creates is recorded in the link; the project's own code repo link is left as it is.

In a meeting, gotchis see whether the project is linked and can propose `gotchibot wondrstack status|launch|login <project>` for you to `/run`.

