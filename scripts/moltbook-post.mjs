#!/usr/bin/env node
/**
 * moltbook-post.mjs — post APPROVED reply drafts to Moltbook as our agent.
 *
 * Julius-gated: only drafts with status "draft" in sessions/moltbook-replies/drafts.json
 * are posted, and only when --run is passed. Default is a dry-run summary.
 *
 *   node scripts/moltbook-post.mjs --env-file ~/.config/moltbook/credentials.json          # dry-run
 *   node scripts/moltbook-post.mjs --env-file ~/.config/moltbook/credentials.json --run    # post
 *
 * Rate limit: 1 comment / 20s (Moltbook) — posts are spaced 21s apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS = `${ROOT}/sessions/moltbook-replies/drafts.json`;
const API = "https://www.moltbook.com/api/v1";
const SPACING_MS = 21_000;

const args = process.argv.slice(2);
const doRun = args.includes("--run");
const envFileIdx = args.indexOf("--env-file");

function loadKey() {
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  if (envFileIdx !== -1) {
    const f = args[envFileIdx + 1];
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j.api_key) return j.api_key;
      if (j.MOLTBOOK_API_KEY) return j.MOLTBOOK_API_KEY;
    } catch {
      // plain KEY=... format
      const txt = readFileSync(f, "utf8");
      const m = txt.match(/MOLTBOOK_API_KEY[=:]\s*(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.error("[moltbook-post] no API key — pass --env-file ~/.config/moltbook/credentials.json or export MOLTBOOK_API_KEY");
    process.exit(1);
  }
  const drafts = JSON.parse(readFileSync(DRAFTS, "utf8"));
  const arr = Array.isArray(drafts) ? drafts : drafts.items || drafts.drafts;
  const pending = arr.filter((d) => d.status === "draft");
  console.log(`[moltbook-post] ${pending.length} approved draft(s)${doRun ? "" : " (DRY RUN — pass --run to post)"}`);

  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let posted = 0, failed = 0;
  for (const d of pending) {
    const body = { content: d.draft };
    if (d.commentId) body.parent_id = d.commentId;
    const url = `${API}/posts/${d.postId}/comments`;
    if (!doRun) {
      console.log(`  DRY ${d.author} → ${d.postId.slice(0, 8)}${d.commentId ? ` (reply to ${d.commentId.slice(0, 8)})` : ""}`);
      continue;
    }
    try {
      const res = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (res.ok) {
        d.status = "posted";
        d.postedAt = new Date().toISOString();
        posted++;
        console.log(`  ✓ posted → ${d.author} (${d.postId.slice(0, 8)})`);
      } else {
        const t = await res.text();
        failed++;
        console.error(`  ✗ ${res.status} → ${d.author}: ${t.slice(0, 120)}`);
        if (res.status === 401) { console.error("[moltbook-post] key rejected — stopping"); break; }
        if (res.status === 429) {
          console.error("[moltbook-post] rate-limited — waiting 60s");
          await new Promise((r) => setTimeout(r, 60_000));
          failed--; // retry counts as not-failed yet
          continue; // item stays 'draft', picked up next run
        }
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${d.author}: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  if (doRun) writeFileSync(DRAFTS, `${JSON.stringify(arr, null, 2)}\n`);
  console.log(`[moltbook-post] done: ${posted} posted, ${failed} failed, ${arr.filter((d) => d.status === "draft").length} still pending`);
}

main();