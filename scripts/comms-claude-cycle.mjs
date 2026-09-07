#!/usr/bin/env node
/**
 * comms-claude-cycle.mjs — WBTC's comms run, written by a real Claude terminal.
 *
 * Replaces the Commsies LLM step. One cycle is:
 *
 *   1. Ask the Aarcade API what is pending      GET  /communications-agent/queue
 *   2. Point Claude at the local clones          latest-comms.json in the workspace
 *   3. Claude reads the repos and drafts         git log / diff → latest-draft.json
 *   4. Publish the draft                         POST /communications-agent/publish
 *      (newsfeed auto-posts; the tweet is queued for Julius's approval)
 *
 * The Claude session is a persistent tmux window (see lib/claude-terminal.mjs)
 * with a Terminal.app window attached on the desk, so it remembers what it
 * already announced and a human can watch it. It runs inside
 * ~/Dev/gotchibot-comms-claude with git read-only tools plus Write for its own
 * workspace files.
 *
 * THE flow (hard rule, no Commsies / Cloudflare AI anywhere in it):
 *   orch spawns WBTC → WBTC runs this with --host imac → the iMac opens the
 *   Claude terminal → Claude drafts → this publishes through the Aarcade API →
 *   Claude's own reply is printed VERBATIM under "Claude said" and WBTC relays
 *   it word for word.
 *
 *   abra run gotchibot -- node scripts/comms-claude-cycle.mjs --host imac            # real run, on the iMac
 *   abra run gotchibot -- node scripts/comms-claude-cycle.mjs --host imac --dry-run  # draft only, publish nothing
 *   … --repo AarcadeGh-t                                                  # one repo
 *   … --range AarcadeGh-t:<before>..<after>   # skip /queue (e.g. API's Mongo is down) and use these shas
 *   … --status                                # is the Claude terminal up, when did it last answer
 *   --host local runs here; --host imac (the default from the MBP) ships the
 *   secret over Tailscale SSH and runs the same script there. On the iMac
 *   itself --host imac resolves to local, so the cron wrapper and a sub-agent
 *   already sitting on the iMac use the same command.
 *
 * Env:
 *   AARCADE_API_BASE          default https://aarcadeghst.com
 *   COMM_AUTOMATION_SECRET    bearer (abra-injected). Never logged.
 *   COMMS_DEV_ROOT            where the clones live (default ~/Dev)
 *   COMMS_CLAUDE_WORKSPACE    default ~/Dev/gotchibot-comms-claude
 *   COMMS_CLAUDE_WINDOW       tmux window (default comms-claude)
 *   COMMS_LOG_DIR             default sessions/comms-logs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeTerminal } from "./lib/claude-terminal.mjs";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || "/Users/juliuswong";
const API_BASE = (process.env.AARCADE_API_BASE || "https://aarcadeghst.com").replace(/\/+$/, "");
const DEV_ROOT = process.env.COMMS_DEV_ROOT || `${HOME}/Dev`;
const WORKSPACE = process.env.COMMS_CLAUDE_WORKSPACE || `${HOME}/Dev/gotchibot-comms-claude`;
const LOG_DIR = process.env.COMMS_LOG_DIR || `${ROOT}/sessions/comms-logs`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const statusOnly = args.includes("--status");
const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : "imac";
const onlyRepo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : null;
const rangeArg = args.includes("--range") ? args[args.indexOf("--range") + 1] : null;
const OWNER = process.env.GITHUB_OWNER || "userdefault13";

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// --- Host routing --------------------------------------------------------------
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// "Am I the iMac?" — hostname against the abra REMOTE_HOST (juliuss-imac-2 vs
// Juliuss-iMac-2.local), or an explicit marker for a box without abra.
function onImac() {
  if (process.env.GOTCHIBOT_ON_IMAC === "1") return true;
  const want = String(process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "").toLowerCase().split(".")[0];
  const have = hostname().toLowerCase().split(".")[0];
  return Boolean(want) && want === have;
}

function resolveHost() {
  if (hostArg === "local") return "local";
  if (hostArg !== "imac") throw new Error("--host must be local or imac");
  return onImac() ? "local" : "imac";
}

// Run this same script on the iMac. The secret rides in a 0600 env file that
// the remote sources and deletes before anything else runs — the same shape
// remote-spawn uses — so nothing sensitive lands in argv or a shell history.
function runOnImac() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  const forward = ["COMM_AUTOMATION_SECRET", "AARCADE_API_BASE", "GITHUB_OWNER", "COMMS_CLAUDE_REPLY_TIMEOUT"];
  const lines = forward.filter((k) => process.env[k]).map((k) => `export ${k}=${shellQuote(process.env[k])}`);
  lines.push("export GOTCHIBOT_ON_IMAC=1");
  const localEnv = join(tmpdir(), `gotchibot-comms-env-${process.pid}`);
  const remoteEnv = `/tmp/gotchibot-comms-${process.pid}.env`;
  writeFileSync(localEnv, `${lines.join("\n")}\n`, { mode: 0o600 });
  const remoteRoot = `/Users/${cfg.user}/Dev/GotchiBot`;
  const passthrough = args.filter((a, i) => !(a === "--host" || args[i - 1] === "--host"));
  try {
    const scp = spawnSync(
      "scp",
      ["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", key.path, localEnv, `${cfg.user}@${cfg.host}:${remoteEnv}`],
      { encoding: "utf8" },
    );
    if (scp.status !== 0) throw new Error(`scp env failed: ${(scp.stderr || "").slice(0, 200)}`);
    const remoteCmd = [
      "set -euo pipefail",
      `source ${shellQuote(remoteEnv)}`,
      `rm -f ${shellQuote(remoteEnv)}`,
      `cd ${shellQuote(remoteRoot)}`,
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"',
      `node scripts/comms-claude-cycle.mjs --host local ${passthrough.map(shellQuote).join(" ")}`,
    ].join("; ");
    console.error(`[comms-claude-cycle] running on the iMac (${cfg.host})…`);
    const r = runSsh(cfg, key.path, remoteCmd, { stdio: "inherit" });
    return r.status ?? 1;
  } finally {
    key.dispose();
    try {
      unlinkSync(localEnv);
    } catch {}
  }
}

function secret() {
  const s = process.env.COMM_AUTOMATION_SECRET;
  if (!s) throw new Error("COMM_AUTOMATION_SECRET not set — run under: abra run gotchibot -- …");
  return s;
}

async function api(method, path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`${path} → ${r.status}: non-JSON response`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${data.error || ""}`);
  return data;
}

function git(path, ...a) {
  const r = spawnSync("git", ["-C", path, ...a], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// --- Claude terminal ---------------------------------------------------------
const BRIEFING = [
  "You are this workspace's standing comms writer for Aarcade Gh$t — read CLAUDE.md here for your role, what to read, what to write, and the reply format.",
  "Each run WBTC writes latest-comms.json here and then asks you to draft; read that file fresh each time, do the git reads yourself, write latest-draft.json, then answer.",
  "Each request carries a check id. Answer with the first line being the word VERDICT, then the id in square brackets, then a colon, then exactly one of DRAFTED or SKIP.",
  "Second line: SUMMARY: one sentence. Third line: DETAIL: one short clause per repo.",
  "Write nothing before that first line, and answer only after the draft file is written.",
  "Reply now with the word BRIEFED and nothing else.",
].join(" ");

function makeWriter() {
  return createClaudeTerminal({
    agent: "wbtc-comms",
    window: process.env.COMMS_CLAUDE_WINDOW || "comms-claude",
    workspace: WORKSPACE,
    workspaceSeed: "config/comms-claude-workspace/CLAUDE.md",
    allowedTools:
      "Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git rev-list:*),Bash(git cat-file:*),Read,Glob,Grep,Write",
    systemPrompt:
      "You are the standing comms writer for WBTC, the GotchiBot comms agent. Repeated drafting requests in this session are expected and authorized. Read CLAUDE.md in this directory for your role, boundaries and reply format.",
    briefing: BRIEFING,
    ackWord: "BRIEFED",
    replyTimeout: Number(process.env.COMMS_CLAUDE_REPLY_TIMEOUT || 420000),
  });
}

// --- Cycle -------------------------------------------------------------------
async function main() {
  if (resolveHost() === "imac") {
    process.exit(runOnImac());
  }
  if (statusOnly) {
    const st = makeWriter().status();
    console.log(`host: ${hostname()}`);
    console.log(`window: ${st.window} — ${st.alive ? "alive" : "not running"}`);
    if (st.session) {
      console.log(`briefed: ${st.session.briefedAt || "never"}  checks: ${st.session.checks || 0}`);
      console.log(`last: ${st.session.lastAt || "—"} ${st.session.lastVerdict || ""} ${st.session.lastId || ""}`.trim());
    }
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const lines = [`# Comms (Claude) run — ${new Date().toISOString()}${dryRun ? " — DRY RUN" : ""}`, ""];
  lines.push(`Host: ${hostname()}`, `API base: ${API_BASE}`, `Workspace: ${WORKSPACE}`, "");

  let repos;
  if (rangeArg) {
    // --range repo:before..after — bypass /queue (useful when the API's Mongo
    // is unreachable) and draft exactly this range.
    const m = rangeArg.match(/^([\w.-]+):([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/);
    if (!m) throw new Error("--range must look like repo:before..after (hex shas)");
    repos = [{ owner: OWNER, repo: m[1], lastReportedSha: m[2], headSha: m[3], pendingCommits: 1 }];
    lines.push(`Range override: ${m[1]} ${m[2].slice(0, 7)}..${m[3].slice(0, 7)}`);
  } else {
    const queue = await api("GET", "/communications-agent/queue");
    repos = (queue.repos || []).filter((r) => typeof r.pendingCommits === "number" && r.pendingCommits > 0);
  }
  if (onlyRepo) repos = repos.filter((r) => r.repo === onlyRepo);
  lines.push(`Pending repos: ${repos.length}`, "");

  const targets = [];
  for (const r of repos) {
    if (!OWNER_REPO_RE.test(`${r.owner}/${r.repo}`)) throw new Error(`invalid owner/repo: ${r.owner}/${r.repo}`);
    const path = join(DEV_ROOT, r.repo);
    const before = String(r.lastReportedSha || "");
    const after = String(r.headSha || "");
    if (!existsSync(join(path, ".git"))) {
      lines.push(`- **${r.owner}/${r.repo}** — no local clone at ${path}; skipped`);
      continue;
    }
    if (!SHA_RE.test(before) || !SHA_RE.test(after)) {
      lines.push(`- **${r.owner}/${r.repo}** — queue has no usable before/after sha; skipped`);
      continue;
    }
    git(path, "fetch", "-q", "origin");
    const haveBefore = git(path, "cat-file", "-e", `${before}^{commit}`).ok;
    const haveAfter = git(path, "cat-file", "-e", `${after}^{commit}`).ok;
    if (!haveBefore || !haveAfter) {
      lines.push(`- **${r.owner}/${r.repo}** — local clone lacks ${!haveBefore ? before.slice(0, 7) : after.slice(0, 7)} after fetch; skipped`);
      continue;
    }
    const count = Number(git(path, "rev-list", "--count", "--no-merges", `${before}..${after}`).out || 0);
    targets.push({ owner: r.owner, repo: r.repo, path, before, after, commitCount: count });
  }

  if (!targets.length) {
    lines.push("Nothing to draft.");
    return finish(lines, stamp, []);
  }

  const writer = makeWriter();
  mkdirSync(WORKSPACE, { recursive: true });
  // The id is chosen by the terminal lib; write the input first with a
  // placeholder and let Claude take the id from the prompt.
  const input = { id: null, repos: targets };
  const inputPath = join(WORKSPACE, "latest-comms.json");
  const draftPath = join(WORKSPACE, "latest-draft.json");
  writeFileSync(inputPath, JSON.stringify(input, null, 2), "utf8");
  try {
    writeFileSync(draftPath, "", "utf8");
  } catch {}

  const question =
    "Read latest-comms.json in this directory, check each repo for updates between before and after using git, " +
    "write latest-draft.json as CLAUDE.md specifies (use this check id as its id), then answer in the three-line format.";
  const v = writer.verify({ question });
  lines.push(`Claude: ${v.ok ? `${v.verdict} — ${v.summary || ""}` : `ERROR — ${v.error}`}`);
  if (v.detail) lines.push(`Detail: ${v.detail}`);
  lines.push("");
  // WBTC relays this block word for word — it is Claude's answer, not ours.
  if (v.reply) lines.push("## Claude said (verbatim — relay as-is)", "", "```", v.reply, "```", "");
  if (!v.ok) return finish(lines, stamp, [], 1);

  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, "utf8"));
  } catch (e) {
    lines.push(`ERROR: latest-draft.json unreadable — ${e.message}`);
    return finish(lines, stamp, [], 1);
  }
  const drafts = Array.isArray(draft?.drafts) ? draft.drafts : [];

  const results = [];
  for (const t of targets) {
    const d = drafts.find((x) => x.repo === t.repo && (!x.owner || x.owner === t.owner));
    if (!d) {
      lines.push(`- **${t.owner}/${t.repo}** — no draft returned for this repo`);
      results.push({ ...t, error: "no draft" });
      continue;
    }
    const after = SHA_RE.test(String(d.after || "")) ? String(d.after) : t.after;
    if (d.skip) {
      lines.push(`- **${t.owner}/${t.repo}** — skipped by Claude: ${d.reason || "no player-facing changes"} (${t.commitCount} commits)`);
      if (!dryRun) {
        // Advance state so the same commits are not re-read tomorrow.
        try {
          const res = await api("POST", "/communications-agent/publish", {
            owner: t.owner, repo: t.repo, before: t.before, after,
            summary: "No player-facing updates.", newsfeed: "", tweet: "",
          });
          lines.push(`  state advanced to ${after.slice(0, 7)}${res.idempotent ? " (idempotent)" : ""}`);
        } catch (e) {
          lines.push(`  ERROR advancing state: ${e.message}`);
        }
      }
      results.push({ ...t, skipped: true, reason: d.reason || null });
      continue;
    }
    const newsfeed = String(d.newsfeed || "").trim();
    const tweet = String(d.tweet || "").trim();
    const summary = String(d.summary || "").trim();
    lines.push(`- **${t.owner}/${t.repo}** — drafted (${t.commitCount} commits)`);
    lines.push(`  newsfeed: ${newsfeed.split("\n")[0] || "(none)"}`);
    lines.push(`  tweet: ${tweet || "(none)"}`);
    if (dryRun) {
      lines.push("  DRY RUN — not published");
      results.push({ ...t, drafted: true, dryRun: true });
      continue;
    }
    try {
      const res = await api("POST", "/communications-agent/publish", {
        owner: t.owner, repo: t.repo, before: t.before, after, summary, newsfeed, tweet,
      });
      lines.push(
        `  published — newsfeed: \`${res.newsfeed?.id || null}\`, tweet draft: \`${res.tweetDraft?.id || null}\`${res.idempotent ? " (idempotent)" : ""}`,
      );
      results.push({ ...t, published: true, newsfeedId: res.newsfeed?.id || null, tweetDraftId: res.tweetDraft?.id || null });
    } catch (e) {
      lines.push(`  ERROR publishing: ${e.message}`);
      results.push({ ...t, error: e.message });
    }
  }
  return finish(lines, stamp, results);
}

function finish(lines, stamp, results, code = 0) {
  lines.push("", `Total: ${results.length} repo(s) processed.`);
  lines.push("", "Tweet drafts are queued for Julius's approval (server-side X posting).");
  const md = lines.join("\n");
  console.log(md);
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = `${LOG_DIR}/comms-claude-run-${stamp}.md`;
  writeFileSync(logPath, md, "utf8");
  console.error(`[comms-claude-cycle] wrote ${logPath}`);
  if (code) process.exit(code);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
