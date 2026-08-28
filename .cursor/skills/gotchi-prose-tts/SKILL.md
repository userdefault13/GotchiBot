---
name: gotchi-prose-tts
description: >-
  Discerns natural-language prose from code/syntax in GotchiBot chat responses
  for hover highlight and right-click TTS. Uses EN-AU female voice (MeloTTS
  EN-AU / edge-tts Natasha). Use when implementing or extending chat TTS, prose
  detection, mouse hover, or right-click speak in the OpenClaw Gotchi TUI.
---

# Gotchi prose TTS

## Purpose

Assistant replies mix **speakable prose** with **code/syntax**. This skill defines how GotchiBot separates them so the TUI can:

- **Hover** — highlight prose blocks (lighter violet background)
- **Right-click** — context menu → **Play aloud (EN-AU)**
- **Skip** — fenced code, inline `` `code` ``, shell prompts, import/def lines, symbol-heavy rows

## Voice (Australian female)

Default persona: **`gotchi`** in `config/tts.personas.json5`

| Provider | Voice | Notes |
|----------|-------|-------|
| MeloTTS | `EN-AU` | Primary; run `./scripts/gotchibot tts warm` for fast replay |
| edge-tts | `en-AU-NatashaNeural` | Fallback if Melo not installed |
| macOS `say` | `Karen` | Last-resort fallback |

Enable TTS once per machine:

```bash
./scripts/gotchibot tts on
./scripts/gotchibot tts warm   # optional — keeps Melo loaded
./scripts/gotchibot tts test   # hear EN-AU sample
```

## Prose detection rules

Implementation: `patches/openclaw-gotchi-tui/gotchi-prose-segments.ts`

1. Split on fenced ` ``` ` blocks → **code** segments
2. In prose segments: strip inline backticks and markdown emphasis
3. Drop lines matching syntax heuristics (`import`, `$ cmd`, high symbol ratio, etc.)
4. Join remaining lines → `extractSpeakableProse()`

**Speakable:** explanations, lists, plain answers  
**Not speakable:** code fences, CLI one-liners, JSON/config blobs

## TUI integration

Patches (apply via `./scripts/openclaw-gotchi-build.sh`):

| File | Role |
|------|------|
| `gotchi-prose-segments.ts` | Prose vs code classification |
| `gotchi-prose-tts.ts` | Mouse hover + right-click menu → `tts.mjs speak` |
| `assistant-message.ts` | Hover highlight on prose messages |
| `tui.ts` | Wires controller when scroll layout is active |

Env (set in `openclaw-gotchi.sh` / `chat-pane.sh`):

```bash
GOTCHIBOT_TUI_PROSE_TTS=1   # default on in Gotchi chrome
GOTCHIBOT_TUI_MOUSE=1       # required for hover / right-click
```

After rebuild, respawn the chat pane:

```bash
tmux respawn-pane -t gotchibot:work.1 -k "cd ~/Dev/GotchiBot && exec ./scripts/chat-pane.sh"
```

## User interaction

1. Hover over an assistant **prose** paragraph → background brightens slightly
2. **Right-click** on prose → menu: **Play aloud (EN-AU)** / Cancel
3. Code blocks and syntax lines do not highlight or offer speak

Disable: `GOTCHIBOT_TUI_PROSE_TTS=0`

## Extending

- Tune heuristics in `isSyntaxLikeLine()` for your domain (Solidity, GraphQL, etc.)
- For paragraph-level hover (not whole message), extend `findAssistantAtContentRow` to map rows → prose paragraphs
- Never auto-speak without explicit user action (right-click menu). Global auto-TTS stays off per `AGENTS.md`

## CLI speak (no mouse)

```bash
node scripts/tts.mjs speak "Hello from Gotchi" --persona gotchi --force
```
