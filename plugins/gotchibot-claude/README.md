# gotchibot-claude

**Generated — do not edit.** Source of truth is `.claude/` in the GotchiBot repo;
regenerate with `./scripts/gotchibot claude-plugin build`.

## Install on another machine

```
/plugin marketplace add /path/to/GotchiBot
/plugin install gotchibot-claude@gotchibot
```

The hooks need a GotchiBot checkout to act on: they resolve it from
`CLAUDE_PROJECT_DIR`, else by walking up from the working directory looking for
`scripts/gotchibot`. Outside a checkout the write guard denies nothing it should
not — it simply has no repo to protect.
