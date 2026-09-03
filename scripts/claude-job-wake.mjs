#!/usr/bin/env node
/**
 * Push-wake when Hub forwards a Claude result to Desk receiver.
 * Marks job ready/failed and optionally injects a short note into OpenClaw orch.
 *
 *   node scripts/claude-job-wake.mjs --payload /tmp/result.json
 *   echo '{...}' | node scripts/claude-job-wake.mjs --stdin
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markReady } from "./claude-jobs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET = join(ROOT, "scripts/openclaw-fleet.mjs");

const args = process.argv.slice(2);
let payloadPath = "";
let useStdin = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--payload") payloadPath = args[++i] || "";
  else if (args[i] === "--stdin" || args[i] === "--from-receiver") useStdin = true;
}

function loadPayload() {
  if (payloadPath) {
    return JSON.parse(readFileSync(payloadPath, "utf8"));
  }
  if (useStdin || !process.stdin.isTTY) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch (e) {
          reject(e);
        }
      });
      process.stdin.on("error", reject);
    });
  }
  throw new Error("usage: claude-job-wake.mjs --payload <file> | --stdin");
}

async function main() {
  const payload = await loadPayload();
  const id = String(payload.id || "").trim();
  if (!id) {
    console.error("wake: missing id");
    process.exit(2);
  }

  const job = markReady(id, payload);
  const status = job.status;
  console.log(JSON.stringify({ ok: true, id, status, wake: "marked" }));

  if (process.env.GOTCHIBOT_CLAUDE_WAKE === "0") {
    console.error("wake: OpenClaw inject disabled (GOTCHIBOT_CLAUDE_WAKE=0)");
    return;
  }

  const orch =
    process.env.GOTCHIBOT_ORCH_ID ||
    process.env.GOTCHIBOT_OPENCLAW_ORCH_ID ||
    "owned-954";
  const msg =
    status === "failed"
      ? `Claude job ${id} failed. Call MCP claude_collect with {"id":"${id}"} to read the error, then retry with claude_submit or hub_bridge_ensure if needed. Do not block waiting.`
      : `Claude job ${id} is ready. Call MCP claude_collect with {"id":"${id}"} and continue the task using that reply. Do not re-submit the same prompt.`;

  if (!existsSync(FLEET)) {
    console.error("wake: openclaw-fleet.mjs missing — job marked only");
    return;
  }

  const r = spawnSync(
    process.execPath,
    [FLEET, "chat", "--agent", orch, msg],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (r.status === 0) {
    console.error(`wake: injected into OpenClaw agent ${orch}`);
  } else {
    console.error(
      `wake: OpenClaw inject skipped/failed (job still ${status}): ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`,
    );
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
