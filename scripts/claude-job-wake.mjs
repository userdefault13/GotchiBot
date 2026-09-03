#!/usr/bin/env node
/**
 * Push-wake when Hub forwards a Claude result to Desk receiver.
 * Marks job ready/failed and lands the reply in Desk OpenCode chat
 * (not Script Editor notifications).
 *
 *   node scripts/claude-job-wake.mjs --payload /tmp/result.json
 *   echo '{...}' | node scripts/claude-job-wake.mjs --stdin
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getJob, markReady } from "./claude-jobs.mjs";
import { injectOpenCodeChat } from "./opencode-chat-inject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET = join(ROOT, "scripts/openclaw-fleet.mjs");
const CHAT_BODY_MAX = Number(process.env.GOTCHIBOT_CLAUDE_CHAT_MAX || 6000);

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

function extractReportsTo(prompt, meta = {}) {
  if (meta.reportsTo) return String(meta.reportsTo);
  if (meta.heroId) return String(meta.heroId);
  if (meta.agentId) return String(meta.agentId);
  const m = String(prompt || "").match(/reports_to[=:\s]+([a-z0-9._-]+)/i);
  return m ? m[1] : null;
}

function formatBody(job, payload) {
  const id = job.id;
  const body = String(payload.response ?? job.response ?? "").trim();
  const hero = extractReportsTo(job.prompt || payload.prompt, {
    ...(job.meta || {}),
    ...(payload.meta || {}),
  });
  const truncated = body.length > CHAT_BODY_MAX;
  const shown = truncated
    ? `${body.slice(0, CHAT_BODY_MAX)}\n\n…[truncated — full via claude_collect ${id}]`
    : body;
  const failed = job.status === "failed" || payload.ok === false;
  const head = failed
    ? `**Claude Hub · FAILED** · \`${id}\`${hero ? ` · reports_to=\`${hero}\`` : ""}`
    : `**Claude Hub · reply** · \`${id}\`${hero ? ` · reports_to=\`${hero}\`` : ""}`;
  return {
    title: failed ? `Claude Hub failed · ${id}` : `Claude Hub · ${id}`,
    text: [head, "", shown || "(empty)", ""].join("\n"),
  };
}

async function main() {
  const payload = await loadPayload();
  const id = String(payload.id || "").trim();
  if (!id) {
    console.error("wake: missing id");
    process.exit(2);
  }

  const job = markReady(id, payload);
  console.log(JSON.stringify({ ok: true, id, status: job.status, wake: "marked" }));

  if (process.env.GOTCHIBOT_CLAUDE_WAKE === "0") {
    console.error("wake: chat inject disabled (GOTCHIBOT_CLAUDE_WAKE=0)");
    return;
  }

  const fresh = getJob(id) || job;
  const { title, text } = formatBody(fresh, payload);

  // 1) Primary: Desk OpenCode chat (no model quota)
  const oc = injectOpenCodeChat({ text, title, jobId: id });
  if (oc.ok) {
    console.error(
      `wake: injected Claude reply into OpenCode chat session=${oc.sessionId} msg=${oc.messageId}`,
    );
  } else {
    console.error(`wake: OpenCode inject failed: ${oc.reason}`);
  }

  // 2) Optional OpenClaw wake (may fail on quota / config — non-fatal)
  if (process.env.GOTCHIBOT_CLAUDE_WAKE_OPENCLAW === "1" && existsSync(FLEET)) {
    const orch =
      process.env.GOTCHIBOT_ORCH_ID ||
      process.env.GOTCHIBOT_OPENCLAW_ORCH_ID ||
      "owned-954";
    const r = spawnSync(
      process.execPath,
      [FLEET, "chat", "--agent", orch, text],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (r.status === 0) {
      console.error(`wake: also injected into OpenClaw agent=${orch}`);
    } else {
      console.error(
        `wake: OpenClaw inject skipped: ${(r.stderr || r.stdout || "").trim().slice(0, 160)}`,
      );
    }
  }

  if (!oc.ok) {
    console.error("wake: reply stored — use claude_collect if chat did not update");
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
