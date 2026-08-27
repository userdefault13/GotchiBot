#!/usr/bin/env node
/**
 * Attach this MacBook's OpenCode TUI to the iMac orchestrator server.
 *
 *   abra run gotchibot -- node scripts/attach-imac.mjs
 *   abra run gotchibot -- ./scripts/gotchibot attach
 *
 * Architecture: iMac runs `opencode serve` + GotchiBot; MBP/iPhone are clients.
 * Sub-agents spawn on the iMac (server-side), not on the MBP.
 */
import { spawnSync } from "node:child_process";

const host = process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "";
const port = process.env.GOTCHIBOT_OPENCODE_PORT || "4096";
const url =
  process.env.GOTCHIBOT_OPENCODE_URL ||
  (host ? `http://${host}:${port}` : "");
const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const pass = process.env.OPENCODE_SERVER_PASSWORD || "";

if (!url) {
  console.error("Set REMOTE_HOST or GOTCHIBOT_OPENCODE_URL (iMac Tailscale IP / MagicDNS).");
  process.exit(2);
}
if (!pass) {
  console.error("OPENCODE_SERVER_PASSWORD missing — use: abra run gotchibot -- ./scripts/gotchibot attach");
  process.exit(2);
}

console.log(`attaching → ${url}  (orchestrator on iMac; sub-agents run there)`);

const args = ["attach", url, "--username", user, "--password", pass];
if (process.argv.includes("--mini")) args.push("--mini");
if (process.argv.includes("--continue") || process.argv.includes("-c")) args.push("--continue");

const r = spawnSync("opencode", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENCODE_SERVER_USERNAME: user,
    OPENCODE_SERVER_PASSWORD: pass,
  },
});
process.exit(r.status ?? 1);
