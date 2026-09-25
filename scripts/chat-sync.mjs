#!/usr/bin/env node
/**
 * Desk ↔ Hub chat sync (orch thread by default).
 *
 * Auth = desk token from sessions/.hub.json via `gotchibot hub join`
 * (or GOTCHIBOT_DESK_TOKEN). Install token is NOT used for chats.
 *
 *   gotchibot chats push [--thread orch] [--file messages.json] [--title …] [--op edit|delete --target id]
 *   gotchibot chats pull [--thread orch] [--after N]
 *   gotchibot chats threads
 *   gotchibot chats snapshot [--commit SHA] [--branch name]
 *   gotchibot chats verify <snapshotId|gotchibot-hub://id> [--expect 0xHASH] [--onchain] [--json]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import { ulid } from "./chat-canonical.mjs";
import { isPublicSafeStateUri, parseStateUri } from "./chat-state-uri.mjs";
import {
  hubRequest,
  verifySnapshot,
  readOnchainCheckpoint,
} from "./chat-hub-client.mjs";
import { loadDiamond } from "./chat-checkpoint-onchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const CURSOR_PATH = `${SESSIONS}/.chat-sync-cursor.json`;
const CHECKPOINT_PIN = `${SESSIONS}/.chat-sync-checkpoint.json`;
const IDENTITY = `${SESSIONS}/.identity.json`;
const DEFAULT_THREAD = "orch";
const PULL_PAGE_CAP = 50;

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

function loadJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread" || a === "-t") out.thread = argv[++i];
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--after") out.after = argv[++i];
    else if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--commit") out.commit = argv[++i];
    else if (a === "--branch") out.branch = argv[++i];
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--role") out.role = argv[++i];
    else if (a === "--op") out.op = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--expect") out.expect = argv[++i];
    else if (a === "--onchain") out.onchain = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else out._.push(a);
  }
  return out;
}

export function makeMsgId() {
  return ulid();
}

function gitRev(which) {
  const r = spawnSync("git", ["rev-parse", which === "branch" ? "--abbrev-ref" : "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

function normalizePushMessage(m) {
  const messageId = m.messageId || m.msgId || makeMsgId();
  const out = {
    messageId,
    msgId: messageId,
    role: m.role,
    text: m.text ?? "",
    ts: m.ts || new Date().toISOString(),
  };
  if (m.op) out.op = m.op;
  if (m.targetMessageId) out.targetMessageId = m.targetMessageId;
  if (m.heroId) out.heroId = m.heroId;
  return out;
}

async function cmdPush(opts) {
  const threadId = opts.thread || DEFAULT_THREAD;
  let messages = [];
  if (opts.file) {
    const raw = JSON.parse(readFileSync(opts.file, "utf8"));
    messages = Array.isArray(raw) ? raw : raw.messages || [];
  } else if (opts.text != null || opts.op === "delete") {
    const msg = {
      messageId: makeMsgId(),
      role: opts.role || "user",
      text: opts.text ?? "",
      ts: new Date().toISOString(),
    };
    if (opts.op) msg.op = opts.op;
    if (opts.target) msg.targetMessageId = opts.target;
    messages = [msg];
  } else {
    throw new Error('pass --file messages.json or --text "…"');
  }

  messages = messages.map((m) => {
    const n = normalizePushMessage(m);
    if (opts.op && !n.op) n.op = opts.op;
    if (opts.target && !n.targetMessageId) n.targetMessageId = opts.target;
    return n;
  });

  if ((opts.op === "edit" || opts.op === "delete") && !opts.target && !messages.every((m) => m.targetMessageId)) {
    throw new Error("--op edit|delete requires --target <messageId>");
  }

  const body = { threadId, messages };
  if (opts.title) {
    body.title = opts.title;
    body.thread = { title: opts.title, updatedAt: new Date().toISOString() };
  }

  const result = await hubRequest("POST", "/api/gotchibot/chats/push", { body });
  const cur = loadCursor();
  // Do NOT advance pull cursor `after` on push — that would skip other desks'
  // messages with seq between our old cursor and this push's lastSeq.
  cur[threadId] = {
    ...(cur[threadId] || {}),
    lastPushedSeq: result.lastSeq,
    lastSeq: result.lastSeq,
    pushedAt: new Date().toISOString(),
  };
  saveCursor(cur);
  if (opts.json) console.log(JSON.stringify(result));
  else console.log(`pushed ${result.inserted} (skipped ${result.skipped}) → ${threadId}`);
  return result;
}

async function cmdPull(opts) {
  const threadId = opts.thread || DEFAULT_THREAD;
  if (opts.since != null) {
    console.warn("warning: --since is deprecated (seq cursor); use --after <seq>");
  }
  const cur = loadCursor();
  let after =
    opts.after != null && opts.after !== ""
      ? Number(opts.after)
      : cur[threadId]?.after != null
        ? Number(cur[threadId].after)
        : undefined;
  if (after != null && !Number.isFinite(after)) after = undefined;

  const all = [];
  let nextAfter = after;
  let hasMore = true;
  let pages = 0;
  let lastResult = { ok: true, threadId, messages: [], nextAfter: after ?? null, hasMore: false };

  while (hasMore && pages < PULL_PAGE_CAP) {
    pages += 1;
    const query = { threadId, limit: 500 };
    if (nextAfter != null) query.after = nextAfter;
    lastResult = await hubRequest("GET", "/api/gotchibot/chats/pull", { query });
    const batch = lastResult.messages || [];
    all.push(...batch);
    nextAfter = lastResult.nextAfter;
    hasMore = Boolean(lastResult.hasMore);
    if (!batch.length) break;
  }

  const startAfter = after ?? null;
  cur[threadId] = {
    ...(cur[threadId] || {}),
    after: nextAfter ?? startAfter,
    lastSeq: nextAfter ?? cur[threadId]?.lastSeq,
    pulledAt: new Date().toISOString(),
  };
  saveCursor(cur);

  const result = {
    ...lastResult,
    messages: all,
    nextAfter,
    hasMore: false,
  };
  const outPath = `${SESSIONS}/.chat-sync-pull-${threadId}.json`;
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  if (opts.json) console.log(JSON.stringify(result));
  else {
    console.log(`pulled ${all.length} (after ${startAfter ?? "∅"} → ${nextAfter ?? startAfter ?? "∅"})`);
    console.log(`  → ${outPath}`);
  }
  return result;
}

async function cmdThreads(opts) {
  const result = await hubRequest("GET", "/api/gotchibot/chats/threads");
  if (opts.json) console.log(JSON.stringify(result));
  else {
    for (const t of result.threads || []) {
      console.log(
        `${t.threadId}\t${t.lastSeq ?? ""}\t${t.updatedAt || ""}\t${t.title || ""}`,
      );
    }
  }
  return result;
}

async function cmdSnapshot(opts) {
  const gitCommit = opts.commit || gitRev("HEAD") || undefined;
  const gitBranch = opts.branch || gitRev("branch") || undefined;
  const result = await hubRequest("POST", "/api/gotchibot/chats/snapshot", {
    body: { gitCommit, gitBranch },
  });
  const stateUri = result.stateUri;
  if (!isPublicSafeStateUri(stateUri)) {
    throw new Error(
      `Hub returned unsafe stateUri ${stateUri} — expected gotchibot-hub://<ulid>`,
    );
  }
  if (opts.json) console.log(JSON.stringify({ ...result, stateUri }));
  else {
    console.log(`snapshot ${result.snapshotId}`);
    console.log(`  contentHash ${result.contentHash}`);
    console.log(`  stateUri    ${stateUri}`);
    if (gitCommit) console.log(`  gitCommit   ${gitCommit.slice(0, 12)}`);
  }
  return { ...result, stateUri };
}

function collectExpectHashes(opts, snapMeta) {
  const list = [];
  if (opts.expect) {
    list.push({ label: "--expect", hash: opts.expect });
  }
  const pin = loadJsonSafe(CHECKPOINT_PIN);
  if (pin) {
    const pinSnap = pin.snapshotId || "";
    const pinUri = pin.stateUri || "";
    const matchSnap =
      (snapMeta.snapshotId && pinSnap === snapMeta.snapshotId) ||
      (snapMeta.stateUri && pinUri === snapMeta.stateUri) ||
      (snapMeta.snapshotId && pinUri === `gotchibot-hub://${snapMeta.snapshotId}`);
    if (matchSnap) {
      if (pin.contentHash) {
        list.push({ label: "checkpoint pin", hash: pin.contentHash });
      }
      if (pin.onChain?.stateHash) {
        list.push({ label: "pin onChain record", hash: pin.onChain.stateHash });
      }
    }
  }
  return list;
}

async function cmdVerify(opts) {
  const target = opts._[1] || opts._[0];
  if (!target || target === "verify") {
    throw new Error("usage: chats verify <snapshotId|gotchibot-hub://id> [--expect 0x…] [--onchain]");
  }

  let snapshotId = "";
  let stateUri = "";
  const parsed = parseStateUri(target);
  if (parsed?.scheme === "gotchibot-hub") {
    stateUri = target;
    snapshotId = parsed.id;
  } else if (/^https?:\/\//i.test(target)) {
    throw new Error("verify expects snapshotId or gotchibot-hub://id — not a URL");
  } else {
    snapshotId = target;
    stateUri = `gotchibot-hub://${target}`;
  }

  const expectHashes = collectExpectHashes(opts, { snapshotId, stateUri });
  const result = await verifySnapshot({ snapshotId, stateUri, expectHashes });

  let onchainNote = null;
  if (opts.onchain) {
    const identity = loadJsonSafe(IDENTITY) || {};
    const cartridgeId = identity.cartridgeId;
    if (!cartridgeId) throw new Error("no cartridgeId in sessions/.identity.json");
    const chain = loadDiamond();
    const diamond = String(process.env.CARTRIDGE_DIAMOND || chain.cartridgeDiamond || "").trim();
    const onchain = await readOnchainCheckpoint({ cartridgeId, diamond });
    const hashMatch =
      String(onchain.stateHash || "").toLowerCase() === result.computedHash.toLowerCase();
    const uriMatch = String(onchain.stateUri || "") === result.stateUri;
    result.checks.push({
      label: "on-chain getCheckpoint",
      expected: onchain.stateHash,
      match: hashMatch,
    });
    onchainNote = {
      stateUri: onchain.stateUri,
      stateUriMatch: uriMatch,
      stateHash: onchain.stateHash,
    };
    if (!uriMatch) {
      result.checks.push({
        label: "on-chain stateUri",
        expected: onchain.stateUri,
        match: false,
      });
    } else {
      result.checks.push({
        label: "on-chain stateUri",
        expected: onchain.stateUri,
        match: true,
      });
    }
    result.ok = result.checks.every((c) => c.match);
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...result, onchain: onchainNote }, null, 2));
  } else {
    const onlyHub = result.checks.length === 1 && result.checks[0].label === "hub contentHash";
    if (onlyHub) {
      console.log("note: no external expect target — comparing computed vs Hub contentHash only");
    }
    console.log(`snapshot  ${result.snapshotId}`);
    console.log(`stateUri  ${result.stateUri}`);
    console.log(`computed  ${result.computedHash}`);
    console.log("");
    console.log("check                          expected                                         result");
    console.log("─────────────────────────────  ─────────────────────────────────────────────── ──────");
    for (const c of result.checks) {
      const exp = String(c.expected || "").slice(0, 48);
      console.log(
        `${String(c.label).padEnd(30)} ${exp.padEnd(48)} ${c.match ? "PASS" : "FAIL"}`,
      );
    }
    if (onchainNote && !onchainNote.stateUriMatch) {
      console.log(`on-chain stateUri mismatch: ${onchainNote.stateUri}`);
    }
    console.log("");
    console.log(result.ok ? "PASS" : "FAIL");
  }

  if (!result.ok) {
    const err = new Error("verify failed");
    err.code = "VERIFY_FAIL";
    err.result = result;
    throw err;
  }
  return result;
}

/**
 * Prompt after git commit (TTY). Skip unless GOTCHIBOT_CHAT_CHECKPOINT=1 or --onchain.
 * On yes: Hub snapshot → identity checkpoint (local/SIM) → optional Sepolia checkpointSave.
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
  console.log(`Hub snapshot ${snap.snapshotId}`);
  console.log(`  stateUri ${pin.stateUri}`);

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
      "usage: chats push|pull|threads|snapshot|verify|checkpoint-prompt|onchain|hook […]",
    );
    process.exit(2);
  }
  try {
    if (cmd === "push") await cmdPush(opts);
    else if (cmd === "pull") await cmdPull(opts);
    else if (cmd === "threads") await cmdThreads(opts);
    else if (cmd === "snapshot") await cmdSnapshot(opts);
    else if (cmd === "verify") await cmdVerify(opts);
    else if (cmd === "checkpoint-prompt") {
      await promptChatCheckpointAfterCommit({
        commitSha: opts.commit || gitRev("HEAD"),
        branch: opts.branch || gitRev("branch"),
        onchain: opts.onchain || opts._.includes("--onchain") || process.argv.includes("--onchain"),
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
    const quietCodes = new Set(["NO_HUB_PINNED", "SHARED_ARCADE_CHAT", "NO_DESK_TOKEN", "VERIFY_FAIL"]);
    const quietStatus = e.status === 401 || e.status === 403;
    console.error(e.message || e);
    if (e.body && !quietCodes.has(e.code) && !quietStatus) {
      console.error(JSON.stringify(e.body));
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { cmdPush, cmdPull, cmdThreads, cmdSnapshot, cmdVerify };
