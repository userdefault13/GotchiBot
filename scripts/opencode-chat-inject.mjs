#!/usr/bin/env node
/**
 * Inject a Claude Hub reply into the active OpenCode Desk chat (no model turn).
 * Used by claude-job-wake so replies land in chat instead of Script Editor notifications.
 *
 *   node scripts/opencode-chat-inject.mjs --text "…" [--session <id>] [--title "Claude Hub"]
 *   echo "…" | node scripts/opencode-chat-inject.mjs --stdin
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = join(ROOT, "sessions/claude-inbox.jsonl");

function loadDatabaseSync() {
  try {
    const require = createRequire(import.meta.url);
    // Node 22+ experimental; may need --experimental-sqlite
    return require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
}

function dbPath() {
  const env = process.env.GOTCHIBOT_OPENCODE_DB?.trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    join(homedir(), ".local/share/opencode/opencode.db"),
    join(homedir(), "Library/Application Support/opencode/opencode.db"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function makeId(prefix) {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(18);
  let s = "";
  for (const b of bytes) s += alphabet[b % 62];
  return `${prefix}_${s}`;
}

function resolveSession(db, preferred) {
  if (preferred) {
    const row = db
      .prepare("SELECT id, directory, title FROM session WHERE id = ?")
      .get(preferred);
    if (row) return row;
  }
  const env = process.env.GOTCHIBOT_OPENCODE_SESSION?.trim();
  if (env) {
    const row = db
      .prepare("SELECT id, directory, title FROM session WHERE id = ?")
      .get(env);
    if (row) return row;
  }
  // Prefer newest GotchiBot workspace session that isn't archived
  const row = db
    .prepare(
      `SELECT id, directory, title FROM session
       WHERE (directory LIKE '%/GotchiBot' OR directory LIKE '%/GotchiBot/')
         AND time_archived IS NULL
       ORDER BY time_updated DESC LIMIT 1`,
    )
    .get();
  return row || null;
}

export function injectOpenCodeChat({
  text,
  sessionId,
  title = "Claude Hub",
  jobId,
} = {}) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, reason: "empty-text" };

  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    // Re-exec under experimental flag (Node 22.x)
    const self = fileURLToPath(import.meta.url);
    const tmp = join(tmpdir(), `gotchibot-oc-inject-${process.pid}.json`);
    writeFileSync(
      tmp,
      JSON.stringify({ text: body, sessionId, title, jobId }),
    );
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-sqlite", self, "--from-json", tmp],
        {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 15_000,
        },
      );
      const out = String(r.stdout || "").trim();
      try {
        return JSON.parse(out);
      } catch {
        return {
          ok: false,
          reason: (r.stderr || out || "reexec-failed").slice(0, 200),
        };
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  const path = dbPath();
  if (!path) return { ok: false, reason: "opencode-db-missing" };

  const db = new DatabaseSync(path);
  try {
    const session = resolveSession(db, sessionId);
    if (!session) return { ok: false, reason: "no-session" };

    const now = Date.now();
    const msgId = makeId("msg");
    const partId = makeId("prt");
    const evtMsg = makeId("evt");
    const evtPart = makeId("evt");

    const last = db
      .prepare(
        `SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1`,
      )
      .get(session.id);

    const messageData = {
      parentID: last?.id || undefined,
      role: "assistant",
      mode: "gotchi",
      agent: "gotchi",
      path: {
        cwd: session.directory,
        root: session.directory,
      },
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { write: 0, read: 0 },
      },
      modelID: "claude-hub",
      providerID: "gotchibot",
      time: { created: now, completed: now },
      finish: "stop",
      metadata: {
        source: "claude-hub",
        jobId: jobId || null,
        title,
      },
    };

    const partData = {
      type: "text",
      text: body,
      time: { start: now, end: now },
    };

    const seqRow = db
      .prepare(`SELECT seq FROM event_sequence WHERE aggregate_id = ?`)
      .get(session.id);
    let seq = seqRow?.seq ?? 0;

    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, session.id, now, now, JSON.stringify(messageData));

    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(partId, msgId, session.id, now, now, JSON.stringify(partData));

    db.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(
      now,
      session.id,
    );

    seq += 1;
    db.prepare(
      `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      evtMsg,
      session.id,
      seq,
      "message.updated.1",
      JSON.stringify({
        sessionID: session.id,
        info: {
          id: msgId,
          sessionID: session.id,
          role: "assistant",
          time: { created: now, completed: now },
          parentID: last?.id,
          modelID: "claude-hub",
          providerID: "gotchibot",
          mode: "gotchi",
          agent: "gotchi",
          path: messageData.path,
          cost: 0,
          tokens: messageData.tokens,
        },
      }),
    );

    seq += 1;
    db.prepare(
      `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      evtPart,
      session.id,
      seq,
      "message.part.updated.1",
      JSON.stringify({
        sessionID: session.id,
        part: {
          id: partId,
          sessionID: session.id,
          messageID: msgId,
          type: "text",
          text: body,
        },
      }),
    );

    if (seqRow) {
      db.prepare(`UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?`).run(
        seq,
        session.id,
      );
    } else {
      db.prepare(
        `INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)`,
      ).run(session.id, seq);
    }

    db.exec("COMMIT");

    try {
      mkdirSync(dirname(INBOX), { recursive: true });
      appendFileSync(
        INBOX,
        `${JSON.stringify({
          at: new Date().toISOString(),
          jobId: jobId || null,
          sessionId: session.id,
          title,
          text: body.slice(0, 8000),
        })}\n`,
      );
    } catch {
      /* non-fatal */
    }

    return {
      ok: true,
      sessionId: session.id,
      messageId: msgId,
      partId,
      title: session.title,
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    db.close();
  }
}

const args = process.argv.slice(2);
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("opencode-chat-inject.mjs") ||
    process.argv[1].endsWith("opencode-chat-inject"));

if (isMain) {
  let text = "";
  let sessionId = "";
  let title = "Claude Hub";
  let jobId = "";
  let useStdin = false;
  let fromJson = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--text") text = args[++i] || "";
    else if (a === "--session") sessionId = args[++i] || "";
    else if (a === "--title") title = args[++i] || title;
    else if (a === "--job") jobId = args[++i] || "";
    else if (a === "--stdin") useStdin = true;
    else if (a === "--from-json") fromJson = args[++i] || "";
    else if (a === "-h" || a === "--help") {
      console.error(`usage:
  opencode-chat-inject.mjs --text "…" [--session id] [--job id] [--title "…"]
  echo "…" | opencode-chat-inject.mjs --stdin`);
      process.exit(2);
    }
  }

  async function run() {
    if (fromJson) {
      const j = JSON.parse(readFileSync(fromJson, "utf8"));
      text = j.text || "";
      sessionId = j.sessionId || sessionId;
      title = j.title || title;
      jobId = j.jobId || jobId;
    }
    if (useStdin) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      text = Buffer.concat(chunks).toString("utf8");
    }
    // When re-exec'd with --experimental-sqlite, DatabaseSync is available.
    const r = injectOpenCodeChat({ text, sessionId, title, jobId });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
