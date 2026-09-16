#!/usr/bin/env node
/**
 * moltbook-watch.mjs — the Moltbook watch desk, one cycle per invocation.
 *
 * Watches Moltbook (https://www.moltbook.com/api/v1, Bearer auth) for two
 * things, every 15 minutes via cron402 (primary) or local launchd fallback
 * (scripts/moltbook-schedule.mjs):
 *
 *   1. reply-to-us    — comments/replies on our agent's posts, and any post or
 *                       comment that mentions our agent name or our post ids.
 *   2. api-key-issue  — new posts about user pain with API key management
 *                       (secrets vaults, env vars, key rotation, leaked keys,
 *                       .env mishaps — abra-adjacent).
 *
 * This phase is WATCH + QUEUE ONLY. No posts, comments, votes, follows — no
 * write ops at all. Items that deserve a response land in
 * sessions/moltbook-watch/queue.json for a human (or a later phase) to act on.
 *
 *   node scripts/moltbook-watch.mjs [--json] [--env-file <path>]
 *
 * Env:
 *   MOLTBOOK_API_KEY   Bearer key (read from process.env; never hardcoded).
 *                      Optional --env-file fallback: a JSON file with an
 *                      `api_key` field (Moltbook's own credentials.json
 *                      format) or a line `MOLTBOOK_API_KEY=...`.
 *
 * Exit codes:
 *   0 — cycle completed, or gracefully skipped (no key / invalid key / API
 *       hiccup). A burned key must never crash the cron.
 *   1 — internal error (bug), so a wrapper can notice.
 *
 * JSON stdout contract:
 *   {type:'moltbook-watch', status, at, ourName, newReplies, newIssues, queued, message}
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.moltbook.com/api/v1"; // www is mandatory — bare domain strips the Authorization header
const STATE_FILE = join(ROOT, "sessions", "moltbook-watch.json");
const LOG_FILE = join(ROOT, "sessions", "moltbook-watch.log");
const QUEUE_DIR = join(ROOT, "sessions", "moltbook-watch");
const QUEUE_FILE = join(QUEUE_DIR, "queue.json");

const SEARCH_QUERIES = ["api key", "secrets", "env variables", "key rotation", "leaked key"];
const MAX_POST_PAGES = 2;
const MAX_OUR_POSTS_TO_SCAN = 10;
const MAX_COMMENT_SCAN_PER_POST = 35;

// Keyword radar for api-key-issue. Deliberately aligned with the search
// queries; a hit here (on title+body) is what makes an item an "issue".
const ISSUE_RE =
  /(api[ -]?key|apikey|secret|env(ironment)?[ _-]?var|\.env|rotat|leak|credential|exposed|burned|token)/gi;
// Pain-language boost: keyword hits that also read like a problem worth
// answering (question, plea, mishap) get flagged in `why`.
const PAIN_RE =
  /(help|stuck|lost|can'?t|cannot|problem|issue|accidentally|exposed|burned|leaked|how do i|how to|advice|please|wrong|broke|deleted|forgot)/i;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const envFileArg = (() => {
  const i = argv.indexOf("--env-file");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// --- Key resolution -----------------------------------------------------------
// Env first (launchd manual runs, abra-wrapped runs). Then an explicit
// --env-file (path only, never the secret — safe to put in a plist).
function resolveKey() {
  if (process.env.MOLTBOOK_API_KEY) return { key: process.env.MOLTBOOK_API_KEY, source: "env" };
  if (envFileArg && existsSync(envFileArg)) {
    try {
      const raw = readFileSync(envFileArg, "utf8");
      const trimmed = raw.trim();
      if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed);
        if (parsed.api_key) return { key: parsed.api_key, source: envFileArg };
      } else {
        const m = trimmed.match(/^\s*MOLTBOOK_API_KEY\s*=\s*(.+)\s*$/m);
        if (m && m[1]) return { key: m[1].trim().replace(/^["']|["']$/g, ""), source: envFileArg };
      }
    } catch {
      /* unreadable credentials file — fall through to no key */
    }
  }
  return { key: null, source: null };
}

// --- HTTP ---------------------------------------------------------------------
function get(path, key, timeoutMs = 20000) {
  const r = spawnSync(
    "curl",
    ["-sS", "-m", String(Math.round(timeoutMs / 1000)), "-H", `Authorization: Bearer ${key}`, `${BASE}${path}`],
    { encoding: "utf8", timeout: timeoutMs + 5000 },
  );
  if (r.error) return { ok: false, http: 0, body: null, error: `curl failed: ${r.error.message}` };
  let body = null;
  try {
    body = JSON.parse(r.stdout || "{}");
  } catch {
    return { ok: false, http: 0, body: null, error: `non-JSON response from ${path}` };
  }
  const http = Number(body.statusCode) || (r.status === 0 ? 200 : r.status);
  const errText = JSON.stringify(body).slice(0, 300);
  if (http === 401 || /unauthorized|invalid api key|401/i.test(errText)) {
    return { ok: false, http: 401, body, error: "unauthorized" };
  }
  if (body.success === false || body.error) {
    return { ok: false, http, body, error: String(body.error || body.message || "api error") };
  }
  return { ok: true, http, body, error: null };
}

// Defensive extraction — feed/search/comment shapes vary slightly across
// Moltbook API versions; accept the common containers.
const arr = (v) => (Array.isArray(v) ? v : []);
const postsOf = (body) => arr(body.posts || body.results || body.data?.posts || body.data?.results);
const commentsOf = (body) => arr(body.comments || body.data?.comments);

const textOf = (item) => `${item.title || ""} ${item.content || ""}`.trim();
const authorOf = (item) => item.author?.name || item.author_name || item.agent?.name || "unknown";

// --- State --------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRunAt: null, ourName: null, ourPostIds: [], seenPosts: [], seenComments: [] };
  }
}
function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}
function loadQueue() {
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function saveQueue(q) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), "utf8");
}
function logLine(line) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
}

// --- Classification -----------------------------------------------------------
function classifyReplyToUs(item, { ourName, ourPostIds, context }) {
  const author = authorOf(item);
  if (author === ourName) return null; // our own content is not a reply to us
  const text = textOf(item);
  const mentionsUs =
    (ourName && text.toLowerCase().includes(ourName.toLowerCase())) ||
    (ourPostIds.length > 0 && ourPostIds.some((id) => text.includes(id)));
  if (context === "our-post") {
    return { why: `comment/reply on our post (${item.post_title || "see post"})`, mentionsUs };
  }
  if (mentionsUs) return { why: "mentions our agent name or our post id", mentionsUs };
  return null;
}

function classifyApiKeyIssue(item) {
  const text = textOf(item);
  const kw = (text.match(ISSUE_RE) || []).map((m) => m.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);
  if (kw.length === 0) return null;
  const pain = PAIN_RE.test(text);
  return { why: `api-key keywords: ${kw.join(", ")}${pain ? " · reads like a user problem" : ""}`, pain };
}

// --- Cycle --------------------------------------------------------------------
function main() {
  const at = new Date().toISOString();
  const state = loadState();
  const { key, source } = resolveKey();

  const finish = (summary) => {
    if (asJson) console.log(JSON.stringify({ type: "moltbook-watch", at, ...summary }, null, 2));
    else {
      console.log(`[moltbook-watch] ${summary.status}${summary.message ? ` — ${summary.message}` : ""}`);
      if (summary.newReplies) console.log(`[moltbook-watch] ${summary.newReplies} reply-to-us, ${summary.newIssues} api-key issues queued`);
    }
    process.exit(0);
  };

  if (!key) {
    return finish({
      status: "skipped",
      newReplies: 0,
      newIssues: 0,
      queued: 0,
      message: "MOLTBOOK_API_KEY not set (and no --env-file with a key) — nothing to watch. Rotate the key in abra (project Aarcade-AIBot) + Moltbook, then export MOLTBOOK_API_KEY or point --env-file at ~/.config/moltbook/credentials.json",
    });
  }

  // 1. Validate the key. A 401 here means the key is burned: say so clearly
  //    and exit 0 — the cron must keep ticking, not crash.
  const me = get("/agents/me", key);
  if (!me.ok) {
    if (me.http === 401) {
      logLine(`status=key-invalid (401) — key believed burned`);
      return finish({
        status: "key-invalid",
        newReplies: 0,
        newIssues: 0,
        queued: 0,
        message: "MOLTBOOK_API_KEY invalid/burned — rotate in abra (project Aarcade-AIBot) + Moltbook (owner dashboard → rotate key), then update the key source",
      });
    }
    logLine(`status=error agents/me: ${me.error}`);
    return finish({ status: "error", newReplies: 0, newIssues: 0, queued: 0, message: `agents/me failed: ${me.error}` });
  }
  const ourName = me.body?.agent?.name || me.body?.name || state.ourName || null;
  if (!ourName) {
    logLine(`status=error agents/me returned no agent name`);
    return finish({ status: "error", newReplies: 0, newIssues: 0, queued: 0, message: "agents/me returned no agent name" });
  }

  // 2. Our recent posts — the comment threads we need to watch.
  let ourPostIds = state.ourPostIds || [];
  const profile = get(`/agents/profile?name=${encodeURIComponent(ourName)}`, key);
  if (profile.ok) {
    const recent = arr(profile.body?.recentPosts || profile.body?.agent?.recentPosts);
    ourPostIds = recent.map((p) => p.id || p.post_id).filter(Boolean).slice(0, MAX_OUR_POSTS_TO_SCAN);
  } else {
    logLine(`warn agents/profile: ${profile.error} (using ${ourPostIds.length} known post ids)`);
  }

  // 3. New posts feed (2 pages).
  const feedItems = [];
  let cursor = null;
  for (let page = 0; page < MAX_POST_PAGES; page++) {
    const qs = `sort=new&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = get(`/posts?${qs}`, key);
    if (!r.ok) {
      logLine(`warn posts page ${page + 1}: ${r.error}`);
      break;
    }
    feedItems.push(...postsOf(r.body));
    if (!r.body?.has_more || !r.body?.next_cursor) break;
    cursor = r.body.next_cursor;
  }

  // 4. Comments on our recent posts (tree: comments[].replies).
  const ourThreadItems = [];
  for (const pid of ourPostIds) {
    const r = get(`/posts/${pid}/comments?sort=new&limit=${MAX_COMMENT_SCAN_PER_POST}`, key);
    if (!r.ok) {
      logLine(`warn comments ${pid}: ${r.error}`);
      continue;
    }
    const walk = (c, postTitle) => {
      ourThreadItems.push({ ...c, _postId: pid, _postTitle: postTitle });
      for (const rep of arr(c.replies)) walk(rep, postTitle);
    };
    const postTitle = feedItems.find((p) => (p.id || p.post_id) === pid)?.title || null;
    for (const c of commentsOf(r.body)) walk(c, postTitle);
  }

  // 5. Semantic searches: api-key pain + a mention sweep for our own name.
  const searchItems = [];
  for (const q of [...SEARCH_QUERIES, ...(ourName ? [ourName] : [])]) {
    const r = get(`/search?q=${encodeURIComponent(q)}&type=all&limit=20`, key);
    if (!r.ok) {
      logLine(`warn search "${q}": ${r.error}`);
      continue;
    }
    searchItems.push(...arr(r.body?.results).map((item) => ({ ...item, _query: q })));
  }

  // 6. Classify + dedup.
  const seenPosts = new Set(state.seenPosts || []);
  const seenComments = new Set(state.seenComments || []);
  const queue = loadQueue();
  const queuedIds = new Set(queue.map((i) => i.id));
  let newReplies = 0;
  let newIssues = 0;

  const enqueue = (item) => {
    const id = item.id || item.post_id;
    if (!id || queuedIds.has(id)) return;
    queuedIds.add(id);
    queue.push(item);
  };

  for (const p of feedItems) {
    const id = p.id || p.post_id;
    if (!id || seenPosts.has(id)) continue;
    seenPosts.add(id);
    const reply = classifyReplyToUs(p, { ourName, ourPostIds, context: "feed" });
    if (reply) {
      newReplies++;
      enqueue({
        id,
        kind: "post",
        postId: id,
        commentId: null,
        author: authorOf(p),
        snippet: textOf(p).slice(0, 280),
        url: `${BASE}/posts/${id}`,
        why: `reply-to-us: ${reply.why}`,
        suggested: "read the post, then reply as our agent if it asks a question or needs a response",
      });
    }
    const issue = classifyApiKeyIssue(p);
    if (issue) {
      newIssues++;
      enqueue({
        id,
        kind: "post",
        postId: id,
        commentId: null,
        author: authorOf(p),
        snippet: textOf(p).slice(0, 280),
        url: `${BASE}/posts/${id}`,
        why: `api-key-issue: ${issue.why}`,
        suggested: "offer abra-adjacent help: key rotation steps, secrets vault hygiene, .env handling — no posting without Julius's go-ahead",
      });
    }
  }

  for (const c of ourThreadItems) {
    const id = c.id || c._postId;
    if (!id || seenComments.has(id)) continue;
    seenComments.add(id);
    const reply = classifyReplyToUs(c, { ourName, ourPostIds, context: "our-post" });
    if (reply) {
      newReplies++;
      enqueue({
        id,
        kind: "comment",
        postId: c._postId,
        commentId: c.id || null,
        author: authorOf(c),
        snippet: textOf(c).slice(0, 280),
        url: `${BASE}/posts/${c._postId}`,
        why: `reply-to-us: ${reply.why}`,
        suggested: "reply in the thread if it deserves one (question, thanks, follow-up) — no auto-posting",
      });
    }
  }

  for (const s of searchItems) {
    const id = s.id || s.post_id;
    if (!id) continue;
    const isComment = s.type === "comment";
    if (isComment ? seenComments.has(id) : seenPosts.has(id)) continue;
    const reply = classifyReplyToUs(s, { ourName, ourPostIds, context: "search" });
    if (reply) {
      if (isComment) seenComments.add(id);
      else seenPosts.add(id);
      newReplies++;
      enqueue({
        id,
        kind: isComment ? "comment" : "post",
        postId: s.post_id || s.id,
        commentId: isComment ? s.id : null,
        author: authorOf(s),
        snippet: textOf(s).slice(0, 280),
        url: `${BASE}/posts/${s.post_id || s.id}`,
        why: `reply-to-us: ${reply.why} (found via search)`,
        suggested: "read the thread, reply if a response is owed — no auto-posting",
      });
    }
    const issue = classifyApiKeyIssue(s);
    if (issue) {
      if (isComment) seenComments.add(id);
      else seenPosts.add(id);
      newIssues++;
      enqueue({
        id,
        kind: isComment ? "comment" : "post",
        postId: s.post_id || s.id,
        commentId: isComment ? s.id : null,
        author: authorOf(s),
        snippet: textOf(s).slice(0, 280),
        url: `${BASE}/posts/${s.post_id || s.id}`,
        why: `api-key-issue: ${issue.why} (found via search "${s._query || "?"}")`,
        suggested: "offer abra-adjacent help: key rotation steps, secrets vault hygiene, .env handling — no posting without Julius's go-ahead",
      });
    }
  }

  // 7. Persist.
  state.lastRunAt = at;
  state.ourName = ourName;
  state.ourPostIds = ourPostIds;
  state.seenPosts = [...seenPosts];
  state.seenComments = [...seenComments];
  saveState(state);
  if (newReplies || newIssues) {
    saveQueue(queue);
    logLine(`status=ok newReplies=${newReplies} newIssues=${newIssues} queuedTotal=${queue.length} keySource=${source}`);
  } else {
    logLine(`status=ok newReplies=0 newIssues=0 (nothing new)`);
  }

  return finish({
    status: "ok",
    ourName,
    newReplies,
    newIssues,
    queued: queue.length,
    message: `watched feed (${feedItems.length} posts), ${ourThreadItems.length} comments on our posts, ${searchItems.length} search hits`,
  });
}

main();