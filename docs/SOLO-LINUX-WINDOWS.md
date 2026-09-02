# GotchiBot Solo on Linux and Windows

GotchiBot runs on **macOS, Linux, and Windows** (Windows via **WSL2** for the `tmux` cockpit).
Secrets use [**abracadabra**](https://github.com/userdefault13/abracadabra) on every platform — Keychain on Mac, **keytar** (Secret Service / Credential Vault) on Linux/Windows.

## Requirements

| | macOS | Linux | Windows |
|---|--------|--------|---------|
| Node | ≥ 18 | ≥ 18 | ≥ 18 (in WSL2 for tmux) |
| tmux | Homebrew | apt/dnf package | WSL2 |
| abracadabra | `npm i -g @userdefault/abracadabra` | same + `libsecret-1-dev` | same (native or WSL) |

## Install

```bash
npm install -g @userdefault/gotchibot @userdefault/abracadabra
abra doctor
gotchibot onboard
gotchibot tmux
```

`onboard` connects a wallet, registers your **install token** (`GOTCHIBOT_INFRA_TOKEN` in abra), mints the cartridge, and runs doctor.

## Linux notes

**Secret Service (recommended):**

```bash
sudo apt update
sudo apt install -y libsecret-1-dev build-essential tmux
npm install -g @userdefault/abracadabra @userdefault/gotchibot
abra doctor
```

If `abra doctor` reports keytar unavailable:

```bash
export ABRA_KEYSTORE=passphrase-file
abra unlock    # before gotchibot commands that need secrets
```

**BYO model key:**

```bash
abra set gotchibot OPENCODE_API_KEY
abra run gotchibot -- gotchibot doctor
```

## Windows notes

### WSL2 (recommended — full GotchiBot + tmux) {#wsl2}

GotchiBot on Windows is **Linux inside WSL2**. Install Node, abra, and GotchiBot in the **Ubuntu** shell — not PowerShell.

**From PowerShell (one-time):**

```powershell
wsl --install -d Ubuntu
```

Reboot if prompted, then open **Ubuntu** from the Start menu.

**Inside Ubuntu (WSL):**

```bash
sudo apt update
sudo apt install -y build-essential libsecret-1-dev tmux
# Node 20+ via https://nodejs.org or nvm
npm install -g @userdefault/abracadabra @userdefault/gotchibot
gotchibot wsl --check          # readiness: node, tmux, abra doctor
gotchibot onboard
gotchibot tmux
```

**Tips:**

| Do | Don't |
|----|--------|
| Clone repo under `~/Dev/GotchiBot` (WSL home) | Use `/mnt/c/Users/...` for the repo (slow, path pain) |
| Run `gotchibot`, `abra`, `tmux` inside WSL | Mix Windows `abra` and WSL `abra` (separate vaults) |
| `gotchibot wsl` from PowerShell for the install guide | Expect `gotchibot tmux` to work in cmd/PowerShell |

From **PowerShell**, print the WSL2 guide without entering Ubuntu:

```powershell
gotchibot wsl
```

**Native Windows (headless only — no tmux cockpit):**

- Install Node 20+ and abracadabra globally.
- Use `abra run gotchibot -- gotchibot doctor` and headless scripts; OpenClaw tmux layout is WSL-only today.

```powershell
npm install -g @userdefault/abracadabra @userdefault/gotchibot
abra doctor
gotchibot onboard
```

## Install token storage

`gotchibot onboard` saves `GOTCHIBOT_INFRA_TOKEN` via:

```bash
abra set gotchibot GOTCHIBOT_INFRA_TOKEN --stdin
```

No plaintext token files in the repo. Always run subcommands that need secrets as:

```bash
abra run gotchibot -- gotchibot doctor
abra run gotchibot -- gotchibot init
```

The `gotchibot` launcher itself stays **unwrapped** (TTY for tmux).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `abra doctor` keytar fail (Linux) | `libsecret-1-dev` + `npm rebuild keytar -g` |
| Vault locked | `export ABRA_KEYSTORE=passphrase-file` → `abra unlock` |
| `GOTCHIBOT_INFRA_TOKEN unset` | `gotchibot onboard` or `abra run gotchibot -- gotchibot onboard` |
| tmux missing (Windows) | Open Ubuntu (WSL2), run `gotchibot wsl --check` |
| Running in PowerShell | Switch to WSL — `gotchibot wsl` for steps |

See also: [abracadabra `docs/CROSS-PLATFORM.md`](https://github.com/userdefault13/abracadabra/blob/main/docs/CROSS-PLATFORM.md).
