#!/usr/bin/env node
/**
 * Desk ↔ Arcade chat sync (orch thread by default).
 *
 *   gotchibot chats push [--thread orch] [--file messages.json]
 *   gotchibot chats pull [--thread orch] [--since ISO]
 *   gotchibot chats threads
 *   gotchibot chats snapshot [--commit SHA] [--branch name]
 *
 * Needs GOTCHIBOT_INFRA_TOKEN (abra run gotchibot -- …).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import { infraHeaders, hasInstallToken, assertChatDeskAllowed } from "./infra-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const CURSOR_PATH = `${SESSIONS}/.chat-sync-cursor.json`;
const DEFAULT_THREAD = "orch";

function loadCursor() {
  try {
    return JSON.parse(readFileSync(CURSOR_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCursor(obj) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(CURSOR_PATH, `${JSON.stringify(obj, null, 2)}\n`);
}

async function api(method, path, { query, body } = {}) {
  const { base } = assertChatDeskAllowed();
  if (!hasInstallToken()) {
    throw new Error("GOTCHIBOT_INFRA_TOKEN required — abra run gotchibot -- ./scripts/gotchibot chats …");
  }
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { ...infraHeaders(), "Content-Type": "application/json" };
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread" || a === "-t") out.thread = argv[++i];
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--commit") out.commit = argv[++i];
    else if (a === "--branch") out.branch = argv[++i];
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--role") out.role = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else out._.push(a);
  }
  return out;
}

function makeMsgId() {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function gitRev(which) {
  const r = spawnSync("git", ["rev-parse", which === "branch" ? "--abbrev-ref" : "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

async function cmdPush(opts) {
  const threadId = opts.thread || DEFAULT_THREAD;
  let messages = [];
  if (opts.file) {
    const raw = JSON.parse(readFileSync(opts.file, "utf8"));
    messages = Array.isArray(raw) ? raw : raw.messages || [];
  } else if (opts.text) {
    messages = [
      {
        msgId: makeMsgId(),
        role: opts.role || "user",
        text: opts.text,
        ts: new Date().toISOString(),
      },
    ];
  } else {
    throw new Error("pass --file messages.json or --text \"…\"");
  }
  for (const m of messages) {
    if (!m.msgId) m.msgId = makeMsgId();
    if (!m.ts) m.ts = new Date().toISOString();
  }
  const result = await api("POST", "/api/gotchibot/chats/push", {
    body: { threadId, title: opts.title || threadId, messages },
  });
  const cur = loadCursor();
  cur[threadId] = { lastMsgId: result.lastMsgId, pushedAt: new Date().toISOString() };
  saveCursor(cur);
  if (opts.json) console.log(JSON.stringify(result));
  else console.log(`pushed ${result.inserted} (skipped ${result.skipped}) → ${threadId}`);
  return result;
}

async function cmdPull(opts) {
  const threadId = opts.thread || DEFAULT_THREAD;
  const cur = loadCursor();
  const since = opts.since || cur[threadId]?.nextSince || undefined;
  const result = await api("GET", "/api/gotchibot/chats/pull", {
    query: { threadId, since },
  });
  if (result.nextSince) {
    cur[threadId] = { ...(cur[threadId] || {}), nextSince: result.nextSince, pulledAt: new Date().toISOString() };
    saveCursor(cur);
  }
  const outPath = `${SESSIONS}/.chat-sync-pull-${threadId}.json`;
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  if (opts.json) console.log(JSON.stringify(result));
  else console.log(`pulled ${result.messages?.length || 0} → ${outPath}`);
  return result;
}

async function cmdThreads(opts) {
  const result = await api("GET", "/api/gotchibot/chats/threads");
  if (opts.json) console.log(JSON.stringify(result));
  else {
    for (const t of result.threads || []) {
      console.log(`${t.threadId}\t${t.updatedAt || ""}\t${t.title || ""}`);
    }
  }
  return result;
}

async function cmdSnapshot(opts) {
  const gitCommit = opts.commit || gitRev("HEAD") || undefined;
  const gitBranch = opts.branch || gitRev("branch") || undefined;
  const result = await api("POST", "/api/gotchibot/chats/snapshot", {
    body: { gitCommit, gitBranch },
  });
  const { base } = assertChatDeskAllowed();
  const stateUri = `${base}${result.stateUriPath}`;
  if (opts.json) console.log(JSON.stringify({ ...result, stateUri }));
  else {
    console.log(`snapshot ${result.snapshotId}`);
    console.log(`  contentHash ${result.contentHash}`);
    console.log(`  stateUri    ${stateUri}`);
    if (gitCommit) console.log(`  gitCommit   ${gitCommit.slice(0, 12)}`);
  }
  return { ...result, stateUri };
}

/**
 * Prompt after git commit (TTY). Skip unless GOTCHIBOT_CHAT_CHECKPOINT=1 or --onchain.
 * On yes: Arcade snapshot → identity checkpoint (local/SIM) → optional Sepolia checkpointSave.
 */
export async function promptChatCheckpointAfterCommit({
  commitSha,
  branch,
  onchain = false,
  skipPrompt = false,
} = {}) {
  const force = onchain || skipPrompt || process.env.GOTCHIBOT_CHAT_CHECKPOINT === "1";
  if (!force && !process.stdin.isTTY) return { skipped: true, reason: "non-interactive" };

  let yes = force;
  if (!force && process.stdin.isTTY) {
    process.stdout.write("Save chat sync checkpoint on-chain (Sepolia)? [y/N] ");
    const answer = await new Promise((resolvePromise) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (d) => {
        buf = String(d);
        resolvePromise(buf);
      });
    });
    yes = /^y(es)?$/i.test(String(answer).trim());
  }
  if (!yes) return { skipped: true, reason: "declined" };

  const snap = await cmdSnapshot({
    commit: commitSha,
    branch,
    json: Boolean(process.env.GOTCHIBOT_CHAT_CHECKPOINT_QUIET),
  });
  const short = String(commitSha || snap.gitCommit || "").slice(0, 7);
  const label = `chat-sync:${short || "head"}`;
  const pin = {
    label,
    stateUri: snap.stateUri,
    contentHash: snap.contentHash,
    snapshotId: snap.snapshotId,
    gitCommit: commitSha || snap.gitCommit,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(`${SESSIONS}/.chat-sync-checkpoint.json`, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`Arcade snapshot ${snap.snapshotId}`);
  console.log(`  stateUri ${pin.stateUri}`);

  const { spawnSync } = await import("node:child_process");
  const idEnv = {
    ...process.env,
    GOTCHIBOT_CHECKPOINT_LABEL: label,
    GOTCHIBOT_CHECKPOINT_CHAT_SYNC: "1",
    GOTCHIBOT_CHECKPOINT_STATE_URI: pin.stateUri,
    GOTCHIBOT_CHECKPOINT_STATE_HASH: pin.contentHash,
  };
  const id = spawnSync(process.execPath, [`${ROOT}/scripts/identity.mjs`, "checkpoint"], {
    cwd: ROOT,
    encoding: "utf8",
    env: idEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (id.status !== 0) {
    console.error(String(id.stderr || id.stdout || "identity checkpoint failed").slice(0, 600));
    return { ...pin, identityOk: false };
  }
  console.log(String(id.stdout || "").trim() || "identity checkpoint ok");

  const wantOnchain =
    onchain ||
    process.env.GOTCHIBOT_CHAT_CHECKPOINT_ONCHAIN === "1" ||
    (process.stdin.isTTY &&
      (await (async () => {
        process.stdout.write("Broadcast checkpointSave on Base Sepolia now? [y/N] ");
        const a = await new Promise((resolvePromise) => {
          process.stdin.once("data", (d) => resolvePromise(String(d)));
        });
        return /^y(es)?$/i.test(a.trim());
      })()));

  if (!wantOnchain) {
    console.log("Skipped on-chain send. Later: gotchibot chats onchain");
    return { ...pin, identityOk: true, onChain: null };
  }

  const { runChatCheckpointOnchain } = await import("./chat-checkpoint-onchain.mjs");
  const chain = await runChatCheckpointOnchain({
    stateHash: pin.contentHash,
    stateUri: pin.stateUri,
  });
  return { ...pin, identityOk: true, onChain: chain.onChain || chain };
}

async function cmdHook(opts) {
  const sub = opts._[1] || "status";
  const hookSrc = resolve(ROOT, "scripts/git-hooks/post-commit-chat-sync");
  const hookDst = resolve(ROOT, ".git/hooks/post-commit");
  const { copyFileSync, chmodSync, unlinkSync, readFileSync: rf } = await import("node:fs");
  if (sub === "install") {
    if (!existsSync(resolve(ROOT, ".git"))) {
      throw new Error("not a git repo");
    }
    copyFileSync(hookSrc, hookDst);
    chmodSync(hookDst, 0o755);
    console.log(`installed ${hookDst}`);
    console.log("After each commit (TTY): prompts for chat-sync Sepolia checkpoint.");
    console.log("Skip: GOTCHIBOT_CHAT_CHECKPOINT=0 git commit …");
    return;
  }
  if (sub === "uninstall") {
    if (existsSync(hookDst)) {
      const body = rf(hookDst, "utf8");
      if (!body.includes("post-commit-chat-sync") && !body.includes("checkpoint-prompt")) {
        throw new Error("post-commit hook is not ours — refuse to delete");
      }
      unlinkSync(hookDst);
      console.log("removed .git/hooks/post-commit");
    } else {
      console.log("no post-commit hook");
    }
    return;
  }
  if (sub === "status") {
    console.log(existsSync(hookDst) ? `hook: ${hookDst}` : "hook: not installed");
    return;
  }
  throw new Error("usage: chats hook install|uninstall|status");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd) {
    console.error(
      "usage: chats push|pull|threads|snapshot|checkpoint-prompt|onchain|hook […]",
    );
    process.exit(2);
  }
  try {
    if (cmd === "push") await cmdPush(opts);
    else if (cmd === "pull") await cmdPull(opts);
    else if (cmd === "threads") await cmdThreads(opts);
    else if (cmd === "snapshot") await cmdSnapshot(opts);
    else if (cmd === "checkpoint-prompt") {
      await promptChatCheckpointAfterCommit({
        commitSha: opts.commit || gitRev("HEAD"),
        branch: opts.branch || gitRev("branch"),
        onchain: opts._.includes("--onchain") || process.argv.includes("--onchain"),
      });
    } else if (cmd === "onchain") {
      const { runChatCheckpointOnchain } = await import("./chat-checkpoint-onchain.mjs");
      await runChatCheckpointOnchain();
    } else if (cmd === "hook") await cmdHook(opts);
    else {
      console.error(`unknown chats command: ${cmd}`);
      process.exit(2);
    }
  } catch (e) {
    // NO_HUB_PINNED / SHARED_ARCADE_CHAT: message only (no stack)
    console.error(e.message || e);
    if (e.body && e.code !== "NO_HUB_PINNED" && e.code !== "SHARED_ARCADE_CHAT") {
      console.error(JSON.stringify(e.body));
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { cmdPush, cmdPull, cmdThreads, cmdSnapshot, makeMsgId };
