# Letting the hub reboot itself (optional, needs your decision)

Today no agent can reboot the iMac. `sudo -n true` fails there — there is no
NOPASSWD rule — so `sudo shutdown -r now` always needs your password. Handing
the task to YFI or any other hero does not change that; they hit the same wall.

If you want the infra watcher to recover the hub unattended, this is the
narrowest rule that allows it. **Install it yourself; an agent must not.**

```bash
# On the iMac, as juliuswong:
sudo visudo -f /etc/sudoers.d/gotchibot-reboot
```

Enter exactly:

```
juliuswong ALL=(root) NOPASSWD: /sbin/shutdown -r now
```

Then:

```bash
sudo chmod 440 /etc/sudoers.d/gotchibot-reboot
sudo visudo -c            # must print: /etc/sudoers.d/gotchibot-reboot: parsed OK
```

## What this does and does not grant

- **Only** `/sbin/shutdown -r now` — one binary, one exact argument list. Not
  `shutdown -h` (halt), not arbitrary root commands, not a shell.
- It does mean anything that can run as `juliuswong` on that machine can reboot
  it without asking. On a single-user home hub with Tailscale-only SSH that is a
  small blast radius, but it is a real widening: an agent that misjudges a
  situation can now bounce the box while work is running.

## The safer alternative

Leave sudo alone and make the reboot rare instead:

- Docker autostart is already on (`settings-store.json` → `"AutoStart": true`),
  so containers return by themselves after any reboot you perform.
- Containers that must survive need `restart: unless-stopped`; the ones that
  went missing had `restart: no`.
- Containers that cannot be stopped cleanly need `--init` in their compose
  definition; without it a zombie child makes `docker restart` a no-op and a
  reboot becomes the only cure.

Fix those three and "the host needs a reboot" stops being a weekly event, which
is a better outcome than automating the reboot.
