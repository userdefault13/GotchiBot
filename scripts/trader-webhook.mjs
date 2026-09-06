#!/usr/bin/env node
/**
 * trader-webhook.mjs — wake-up endpoint for LINK's trading cycle.
 *
 * cron402 (the ai-cron-site x402 cron) POSTs here on a schedule; we run
 * scripts/trader-cycle.mjs and return its JSON summary. The token check keeps
 * the endpoint from being triggered by anyone but cron402, which sends the
 * shared secret in a header.
 *
 * Port note: the infra webhook's default 8788 is already taken by the Mongo
 * proxy on this machine, so this listens on 8792.
 *
 *   node scripts/trader-webhook.mjs
 *
 * Env:
 *   TRADER_WEBHOOK_PORT    listen port (default 8792)
 *   TRADER_WEBHOOK_TOKEN   shared secret; cron402 sends it as x-trader-token
 *
 * Reaching this from cron402 needs a public route. The production tunnel is
 * token-run and therefore dashboard-managed, so the ingress path
 * (e.g. subgraph.aarcadeghst.com/trader-webhook -> 127.0.0.1:8792) has to be
 * added in the Cloudflare dashboard rather than a local config file.
 */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TRADER_WEBHOOK_PORT || 8792);
const TOKEN = process.env.TRADER_WEBHOOK_TOKEN || "";
const HOST = "127.0.0.1";

// A cycle takes ~60s with verification. Refuse overlapping runs rather than
// letting two cycles type into the same Claude terminal at once.
let running = false;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "trader-webhook", running }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
    return;
  }

  const token = req.headers["x-trader-token"] || url.searchParams.get("token") || "";
  if (!TOKEN || token !== TOKEN) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
    return;
  }

  if (running) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "a cycle is already running" }));
    return;
  }

  running = true;
  try {
    const r = spawnSync(process.execPath, [`${ROOT}/scripts/trader-cycle.mjs`, "--json"], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH || ""}` },
    });
    let body;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      body = { ok: false, error: "cycle produced no JSON", stderr: (r.stderr || "").slice(0, 500) };
    }
    // A non-zero exit means a risk breach or a FAIL verdict; surface it as 500
    // so the cron's own dashboard shows the failure rather than a silent 200.
    res.writeHead(r.status === 0 ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } finally {
    running = false;
  }
});

server.listen(PORT, HOST, () => {
  console.error(`[trader-webhook] listening on http://${HOST}:${PORT}`);
  if (!TOKEN) console.error("[trader-webhook] WARNING: TRADER_WEBHOOK_TOKEN unset — every POST will be rejected");
});
