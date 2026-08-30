#!/usr/bin/env node
/**
 * infra-webhook.mjs
 *
 * Minimal webhook receiver for the home-infra monitor. Runs on the iMac
 * (where Docker / :8787 / cloudflared live) and is reached through the
 * existing Cloudflare tunnel via a path ingress:
 *
 *   subgraph.aarcadeghst.com/infra-webhook  ->  http://127.0.0.1:8788
 *
 * cron402 (ai-cron-site) calls this URL on a schedule; we run
 * infra-monitor-cron.mjs and return its JSON result. The token check keeps
 * the endpoint from being triggered by anyone but cron402 (which sends the
 * shared secret in a header).
 *
 *   node scripts/infra-webhook.mjs
 *
 * Env:
 *   INFRA_WEBHOOK_PORT   listen port (default 8788)
 *   INFRA_WEBHOOK_TOKEN  shared secret; cron402 sends it as x-infra-token
 *   INFRA_LOG_DIR        passed through to infra-monitor-cron.mjs
 */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.INFRA_WEBHOOK_PORT || 8788);
const TOKEN = process.env.INFRA_WEBHOOK_TOKEN || "";
const HOST = "127.0.0.1";

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = req.headers["x-infra-token"] || url.searchParams.get("token") || "";
  if (!TOKEN || token !== TOKEN) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    return;
  }
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/infra-monitor-cron.mjs`, "--json"], {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
    timeout: 60_000,
  });
  let body = {};
  try {
    body = JSON.parse(r.stdout || "{}");
  } catch {
    body = { raw: (r.stdout || "").slice(0, 500), error: (r.stderr || "").slice(0, 500) };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: r.status === 0, exit: r.status, ...body }));
});

server.listen(PORT, HOST, () => {
  console.error(`[infra-webhook] listening on ${HOST}:${PORT}`);
});
