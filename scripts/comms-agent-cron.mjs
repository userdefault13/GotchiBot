#!/usr/bin/env node
/**
 * comms-agent-cron.mjs
 *
 * Polls the AarcadeGh-t communications-agent API for repos with pending commits,
 * runs the comms pipeline for each (newsfeed auto-posted, tweet queued for
 * Julius's approval), and reports the newsfeed + tweet-draft ids.
 *
 *   node scripts/comms-agent-cron.mjs
 *
 * The agent NEVER posts to Twitter — X keys are server-side only. Julius
 * approves the queued tweet draft via the admin UI.
 *
 * Env:
 *   AARCADE_API_BASE        API origin (default https://aarcadeghst.com)
 *   COMM_AUTOMATION_SECRET  bearer secret (preferred). Never logged.
 *   ABRA_KEY                abracadabra API key (fallback secret fetch)
 *   ABRA_PROJECT            abracadabra project holding COMM_AUTOMATION_SECRET (default gotchibot)
 *   COMMS_LOG_DIR           where to write the markdown summary (default sessions/comms-logs)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = (process.env.AARCADE_API_BASE || "https://aarcadeghst.com").replace(/\/+$/, "");
const LOG_DIR = process.env.COMMS_LOG_DIR || `${ROOT}/sessions/comms-logs`;

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

async function loadSecret() {
  if (process.env.COMM_AUTOMATION_SECRET) return process.env.COMM_AUTOMATION_SECRET;
  const key = process.env.ABRA_KEY;
  const project = process.env.ABRA_PROJECT || "gotchibot";
  if (key) {
    try {
      const r = await fetch("http://127.0.0.1:7331/secret", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ project, keys: ["COMM_AUTOMATION_SECRET"] }),
      });
      if (r.ok) {
        const data = await r.json();
        const v = data?.COMM_AUTOMATION_SECRET;
        if (v) return v;
      }
    } catch (e) {
      console.error("abra secret fetch failed:", e.message);
    }
  }
  throw new Error("COMM_AUTOMATION_SECRET not available (set env or ABRA_KEY)");
}

function authHeaders(secret) {
  return { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
}

async function apiGet(path, secret) {
  const r = await fetch(`${API_BASE}${path}`, { headers: authHeaders(secret) });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
  if (!ct.includes("application/json")) {
    throw new Error(`${path} → ${r.status}: non-JSON response (is communications-agent deployed?)`);
  }
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${data.error || ""}`);
  return data;
}

async function apiPost(path, body, secret) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(secret),
    body: JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
  if (!ct.includes("application/json")) {
    throw new Error(`${path} → ${r.status}: non-JSON response (is communications-agent deployed?)`);
  }
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${data.error || ""}`);
  return data;
}

function validateRepo(owner, repo) {
  if (!OWNER_REPO_RE.test(`${owner}/${repo}`)) {
    throw new Error(`invalid owner/repo: ${owner}/${repo}`);
  }
}

async function main() {
  const secret = await loadSecret();

  const queue = await apiGet("/communications-agent/queue", secret);
  const repos = (queue.repos || []).filter(
    (r) => typeof r.pendingCommits === "number" && r.pendingCommits > 0,
  );

  const lines = [`# Comms agent run — ${new Date().toISOString()}`, ""];
  lines.push(`API base: ${API_BASE}`);
  lines.push(`Pending repos: ${repos.length}`, "");

  const results = [];
  for (const r of repos) {
    validateRepo(r.owner, r.repo);
    try {
      const res = await apiPost("/communications-agent/run", { owner: r.owner, repo: r.repo }, secret);
      const newsfeedId = res.newsfeed?.id || null;
      const tweetDraftId = res.tweetDraft?.id || null;
      const entry = {
        owner: r.owner,
        repo: r.repo,
        newsfeedId,
        tweetDraftId,
        idempotent: res.idempotent || false,
        skipped: res.skipped || false,
        reason: res.reason || null,
      };
      results.push(entry);
      const tag = res.skipped
        ? ` (skipped: ${res.reason})`
        : res.idempotent
          ? " (idempotent)"
          : "";
      lines.push(
        `- **${r.owner}/${r.repo}** — newsfeed: \`${newsfeedId}\`, tweet draft: \`${tweetDraftId}\`${tag}`,
      );
    } catch (e) {
      results.push({ owner: r.owner, repo: r.repo, error: e.message });
      lines.push(`- **${r.owner}/${r.repo}** — ERROR: ${e.message}`);
    }
  }

  lines.push("", `Total: ${results.length} repo(s) processed.`);
  lines.push("", "Tweet drafts are queued for Julius's approval (server-side X posting).");
  const md = lines.join("\n");

  console.log(md);

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = `${LOG_DIR}/comms-run-${stamp}.md`;
  writeFileSync(logPath, md, "utf8");
  console.error(`[comms-agent-cron] wrote ${logPath}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
