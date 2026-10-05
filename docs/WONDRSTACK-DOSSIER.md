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
