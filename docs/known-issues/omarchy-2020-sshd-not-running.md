# omarchy-2020-sshd-not-running

| | |
|---|---|
| **severity** | Tailscale direct `scp` fails — `sshd` not running on 2020 Omarchy. Taildrop returned 502. Worked around via Grok Bot relay. |
| **Hosts** | Tailscale hop `100.68.95.90` ↔ `100.97.16.64` (2020 Omarchy). |
| **Severity** | flaky / blocks TS scp (relay exists) |
| **seenCount** | 1 |
| **Owner** | Home Infra CoS / YFI |
| **Fleet** | Filed to Issue Reviewer `4587570` |
| **Related** | `imac-tailscale-dual-iface` |

## Working fix

On the **2020** (needs Julius sudo):

```bash
sudo systemctl enable --now sshd
```

Then verify `systemctl is-active sshd` and a dry Tailscale `scp` without the relay.

## Notes

- Phase 3 (edge window / stop M1 Docker) still waits on Julius — do not start from this issue.
- If Taildrop 502 recurs, open a separate packet.
