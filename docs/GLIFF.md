# gliff — open an Omarchy desk from another Omarchy desk

[gliff](https://github.com/omacom/gliff) is a Hyprland-to-Hyprland remote desktop over ssh
(`gliff user@host`, `--headless`; binaries `gliff`, `gliff-server`, `gliff-probe`). GotchiBot adds
no protocol of its own, no secrets and no ports. It only installs the package on eligible desks
and gives you a desk-name shortcut.

> **Caveats.** The gliff repo (v0.3.0, MIT) is brand new with 0 stars and was only skimmed, not fully
> audited (read-only review found no install-time downloads; traffic is a TCP connection tunnelled over ssh).
> `omarchy pkg add gliff` (Omarchy Package Repository) has **not been verified to exist**; if it is missing the
> installer prints a note and moves on. Both ends need gliff; the client needs Hyprland+GTK, so it will not run on macOS.

## Open a desk

```
gotchibot gliff <desk> [--headless]
gotchibot gliff --list
gotchibot gliff someone@host.tailnet.ts.net      # a literal user@host passes through
```

Names come from `config/desks.json` (first DNS label, case-insensitive; aliases and the desk's
tailnet address also work):

| Desk | Resolves to | Aliases |
|------|-------------|---------|
| `imacomarchy` (hub, 2020) | `user_default@100.97.16.64` | `imacOmarchy`, `2020`, `hub` |
| `omarchyimac` (2011) | `user_default@100.110.220.76` | `2011` |
| `omarchymini` | `user_default@100.82.137.20` | `mini` |
| `omarchym1` | `user_default@omarchym1.tail4120f5.ts.net` | `omarchyM1`, `m1` |

Exit codes: `1` gliff cannot run here (not installed, or macOS — the client needs Hyprland),
`2` usage or unknown desk. The server side needs the target's running Hyprland session.

## Install (optional, Omarchy desks only)

`scripts/omarchy-desk-install.sh` runs `omarchy pkg add gliff` and nothing else (no source
build, no `curl | sh`). It prints one line and moves on when it skips:

| Skipped when | Note |
|--------------|------|
| macOS | no Hyprland |
| no `omarchy` + Hyprland on the box | not an Omarchy desk |
| the desk is the hub (`role: hub` in `config/desks.json`) | hub RAM stays for the hub |
| under 2560 MiB RAM (omarchymini has 1.7 GiB) | low RAM |
| `gliff` already on PATH | already installed |
| `GOTCHIBOT_GLIFF=0` | opted out |

If `omarchy pkg add gliff` fails (package not found) the installer prints a note and the desk
install still succeeds. Run the installer yourself on each Omarchy desk; GotchiBot never does.

`gotchibot doctor` reports whether gliff is present. It does not run `gliff-probe`, which
captures frames and is not read-only; run `gliff-probe all` yourself when a session misbehaves.
