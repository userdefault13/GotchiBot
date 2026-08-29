#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = assertRemoteReady();
const key = materializeKey(cfg.key);
const files = [
  ".opencode/skills/gotchi-trader-monitor/SKILL.md",
  ".opencode/skills/gotchi-trader-improve/SKILL.md",
  ".opencode/skills/market-news-feed/SKILL.md",
  "scripts/gotchi-trader-desk.mjs",
  "skills/registry.json",
  ".opencode/agents/gotchi.md",
  "scripts/gotchibot",
  "scripts/model-auto.mjs",
  "config/models.auto.json",
  "scripts/chat-pane.sh",
  "scripts/gotchi-orchestrate.mjs",
  "scripts/opencode-dispatch.sh",
  "config/openclaw/agents/starter-link-h1-1/AGENTS.md",
  "sessions/.focus.json",
  "config/openclaw/agents/owned-954/AGENTS.md",
  "SOUL.md",
  "scripts/openclaw-fleet.mjs",
];
try {
  runSsh(cfg, key.path, "mkdir -p .opencode/skills/gotchi-trader-monitor .opencode/skills/gotchi-trader-improve .opencode/skills/market-news-feed scripts skills .opencode/agents config/openclaw/agents/starter-link-h1-1 config/openclaw/agents/owned-954 sessions");
  for (const rel of files) {
    const r = spawnSync("scp", ["-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","StrictHostKeyChecking=accept-new","-i",key.path, ROOT+"/"+rel, cfg.user+"@"+cfg.host+":"+cfg.dir+"/"+rel], { encoding:"utf8" });
    if (r.status) { process.stderr.write(r.stderr||""); process.exit(r.status); }
    console.log("ok "+rel);
  }
} finally { key.dispose(); }
