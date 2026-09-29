# Agent shell direction (MBP ↔ remotes)

How agents must **direct** UserDefault through multi-machine shell work, and how
UserDefault (and Terminal) must **parse** command lines so wraps don’t break
`scp` / `ssh` / heredocs.

Learned hard on 2026-09-26 while fixing the **2020 iMac** (`imacomarchy`) from
the **MBP**.

## Name the machine every time

| Say | Mean |
|---|---|
| **MBP** | UserDefault’s MacBook — local Terminal prompt `juliuswong@Mac` |
| **2020 iMac** | Omarchy prod box — Tailscale host `imacomarchy`, prompt `~ ❯` as `user_default` |
| **M1 iMac** | `omarchym1` |
| **2011 iMac** | `omarchyimac` |

Never say only “Mac”, “the box”, or “here” when two hosts are in play.
Never run `sudo nvim /etc/...` on the **MBP** when the file lives on the **2020 iMac**.

## Explain like this (required shape)

1. **One step** = one machine + one short command.
2. Say where you type it (**MBP** or **2020 iMac**).
3. Say what success looks like (`DONE`, `unlocked`, `multi-user.target`).
4. Then the next step — don’t dump a paragraph of alternatives.

Example:

```text
1. MBP: ssh -t user_default@imacomarchy
2. 2020 iMac (~ ❯): sudo bash /tmp/fix-2020-headless.sh
   → wait for DONE
3. 2020 iMac: sudo reboot
```

## Never paste long “one-liners” in chat

Chat wraps a long command into a **continuous-looking block**. Copy-paste then
breaks mid-string (`sed`, `python -c`, `scp`). That is not “one line.”

**Do this instead:**

1. Put the fix in a **script file** on the MBP (`/tmp/fix-….sh`).
2. Agent (or a short `scp`) copies it to the remote.
3. User runs only short lines, one step each:
   - `ssh -t user_default@imacomarchy`
   - `sudo bash /tmp/fix-….sh`

If you must show a command in chat: **under ~80 characters**, or it goes in a
script. No giant `python -c '…'` / `sed` walls.

## One command = one Enter

Terminal will wrap long lines visually. If UserDefault presses Enter in the
middle, zsh runs a **broken** command:

```text
# BAD — Enter after the source path
scp /tmp/fix.sh
user_default@imacomarchy:/tmp/fix.sh
# → scp usage error, then zsh “no such file” on the second line
```

```text
# GOOD — entire scp on one logical line (window can be wide)
scp /tmp/fix.sh user_default@imacomarchy:/tmp/fix.sh
```

Rules for agents:

- Prefer **short** commands (copy a script once, then `sudo bash /tmp/….sh`).
- Prefer **scp from the agent** when UserDefault keeps splitting lines.
- Never paste giant one-liners with nested quotes across chat wraps.
- Heredocs (`<<'EOF'`) break the same way — use a script file instead.
- For `systemctl`, set `SYSTEMD_PAGER=cat` / `PAGER=cat` in scripts so the
  session doesn’t stick on `press RETURN`.

## Prompt tells you which machine you’re on

| Prompt | Machine |
|---|---|
| `juliuswong@Mac ~ %` | **MBP** |
| `~ ❯` after `ssh …@imacomarchy` | **2020 iMac** |

If the prompt is still `juliuswong@Mac`, you are **not** on the 2020 iMac.

## SSH vs “screen hung”

On Omarchy, the monitor can sit on an **OMARCHY** splash while the host is up.

1. From **MBP**: `ssh -t user_default@imacomarchy`
2. If that works → OS booted far enough; fix via SSH (don’t assume brick).
3. If timeout / refused → early boot hang; need console / GRUB-or-Limine edit /
   live USB — different path.

`ssh -t` is required when the remote command needs a TTY (sudo password,
`abra unlock`).

## Bootloader note (2020 iMac)

This host uses **Limine**, not GRUB. There is no `/etc/default/grub`.

- Quiet/splash: `/etc/limine-entry-tool.d/omarchy-defaults.conf`
- Override: `/etc/default/limine` then `sudo limine-update`
- Headless display: `multi-user.target` **and** disable `sddm` (display manager
  can still paint Omarchy after multi-user is set)

Abra headless unlock (after reboot, when secrets needed):

```bash
# MBP
ssh -t user_default@imacomarchy /home/user_default/abra-unlock
```

Doc: `~/Dev/abracadabra-wt-linux-agent-fix/docs/LINUX-HEADLESS.md`  
Fleet reboot: `~/Dev/AarcadeGh-t/docs/TAILSCALE-FLEET-SOP.md`

## Checklist before sending a command block

- [ ] Machine named (**MBP** / **2020 iMac** / …)
- [ ] One command per step
- [ ] Fits on one line, or is a script already on the target
- [ ] Success signal stated
- [ ] No “run this on Mac” when the path is remote `/etc`
- [ ] Remote interactive work uses `ssh -t`
