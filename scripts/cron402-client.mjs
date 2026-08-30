#!/usr/bin/env node
// cron402-client.mjs - Thin JSON-RPC client for the published cron402-mcp server.
// Spawns `npx -y cron402-mcp` (bundles x402 payment libs) and calls create_cron.
// Run via abra so the funded wallet key is injected:
//   abra run ai-cron-site -- env CRON402_PRIVATE_KEY=... CRON402_API_URL=... node scripts/cron402-client.mjs --url <webhook> --token <secret>
// Costs ~$0.008 USDC/run via x402 (paid by the ai-cron-site wallet).

import { spawn } from "node:child_process";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const schedule = arg("--schedule") || process.env.CRON_SCHEDULE || "*/5 * * * *";
const url = arg("--url");
const token = arg("--token") || "";

if (!url) {
  console.error("usage: cron402-client.mjs --url <webhook> [--schedule '*/5 * * * *'] [--token SECRET]");
  process.exit(1);
}
if (!process.env.CRON402_PRIVATE_KEY) {
  console.error("CRON402_PRIVATE_KEY is required (inject via `abra run ai-cron-site -- env ...`)");
  process.exit(1);
}

const API_URL = process.env.CRON402_API_URL || "https://cron402-api.user-defaults.workers.dev";

const server = spawn("npx", ["-y", "cron402-mcp"], {
  env: {
    ...process.env,
    CRON402_PRIVATE_KEY: process.env.CRON402_PRIVATE_KEY,
    CRON402_API_URL: API_URL,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");

server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      // initialized → acknowledge, then create the cron
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_cron",
          arguments: {
            schedule,
            url,
            method: "POST",
            headers: token ? { "x-infra-token": token } : undefined,
          },
        },
      });
    } else if (msg.id === 2) {
      console.log(JSON.stringify(msg.result || msg.error, null, 2));
      server.kill();
      process.exit(0);
    }
  }
});

server.stderr.on("data", (d) => process.stderr.write(d));

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gotchibot-cron-setup", version: "1.0.0" },
  },
});

setTimeout(() => {
  console.error("cron402-client: timed out waiting for MCP");
  server.kill();
  process.exit(1);
}, 120_000);
