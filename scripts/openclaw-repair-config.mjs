#!/usr/bin/env node
/**
 * Repair ~/.openclaw/openclaw.json for GotchiBot gateway (2026.8+ schema).
 * Fixes $include keys, agents.entries, plugins, primary model.
 *
 *   node scripts/openclaw-repair-config.mjs [--home ~/.openclaw]
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.argv.includes("--home")
  ? process.argv[process.argv.indexOf("--home") + 1]
  : join(homedir(), ".openclaw");
const path = join(home, "openclaw.json");

let cfg;
try {
  cfg = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`cannot read ${path}:`, e.message);
  process.exit(1);
}

copyFileSync(path, `${path}.bak-repair-${Date.now()}`);

cfg.agents = cfg.agents || {};
cfg.agents.defaults = {
  ...(cfg.agents.defaults || {}),
  $include: "./gotchibot.defaults.json5",
  sandbox: { mode: "off" },
  model: {
    primary:
      cfg.agents.defaults?.model?.primary ||
      process.env.GOTCHIBOT_OPENCLAW_MODEL ||
      "opencode-go/kimi-k3",
  },
};
cfg.agents.entries = { $include: "./gotchibot-fleet.entries.json5" };
delete cfg.agents.list;

cfg.plugins = {
  allow: ["slack", "opencode-go"],
  entries: {
    slack: { enabled: true },
    "opencode-go": { enabled: true },
  },
};
for (const id of ["opencode", "perplexity", "whatsapp"]) {
  delete cfg.plugins.entries[id];
}

cfg.channels = cfg.channels || {};
if (cfg.channels.whatsapp) {
  delete cfg.channels.whatsapp;
}
if (Array.isArray(cfg.bindings)) {
  cfg.bindings = cfg.bindings.filter((b) => b?.match?.channel !== "whatsapp");
}

delete cfg.messages;

cfg.gateway = cfg.gateway || {};
cfg.gateway.mode = cfg.gateway.mode || "local";
cfg.gateway.bind = cfg.gateway.bind || "lan";
cfg.gateway.http = cfg.gateway.http || {};
cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
cfg.gateway.http.endpoints.chatCompletions = { enabled: true };
cfg.gateway.http.endpoints.responses = { enabled: true };

writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(`repaired ${path}`);
console.log(`primary=${cfg.agents.defaults.model.primary}`);
