---
name: gotchi-prose-tts
description: >-
  Discerns natural-language prose from code/syntax in GotchiBot chat for hover
  highlight and right-click EN-AU TTS. Use when extending OpenClaw Gotchi TUI
  mouse speak behavior or prose detection heuristics.
---

# Gotchi prose TTS

See `.cursor/skills/gotchi-prose-tts/SKILL.md` in this repo for full rules.

Quick refs:

- Prose logic: `patches/openclaw-gotchi-tui/gotchi-prose-segments.ts`
- Mouse + menu: `patches/openclaw-gotchi-tui/gotchi-prose-tts.ts`
- Voice: `gotchi` persona → Melo `EN-AU` → edge `en-AU-NatashaNeural` → say `Karen`
- Build: `./scripts/openclaw-gotchi-build.sh` then respawn chat pane
