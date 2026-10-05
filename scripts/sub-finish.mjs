#!/usr/bin/env node
/**
 * After a dispatch sub finishes (done|failed): restore orch focus, inbox orch
 * with a short report, and if orch restore fails also inbox UserDefault.
 *
 *   node scripts/sub-finish.mjs <sessionId> [done|failed]
 *
 * Called from opencode-dispatch.sh — keep quiet, never throw out of process 0
 * for TTS/supervisor (best-effort).
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sendMessage } from "./bot-inbox.mjs";
import { recordEdge } from "./agent-graph.mjs";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;

function field(dir, key) {
  try {
    const raw = readFileSync(`${dir}/state.env`, "utf8");
    const line = raw.split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function summaryFromOutput(dir, max = 900) {
  const path = `${dir}/output.md`;
  if (!existsSync(path)) return "(no output.md)";
  try {
    const body = readFileSync(path, "utf8").trim();
    if (!body) return "(empty output.md)";
    return body.length > max ? `${body.slice(0, max)}…` : body;
  } catch {
    return "(could not read output.md)";
  }
}

function restoreOrch() {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "orch"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const ok =
    r.status === 0 &&
    /orchestrator focus restored|ORCH focus|OpenClaw agent/i.test(out) &&
    !/no orchestrator set/i.test(out);
  return { ok, status: r.status, out: out.trim().slice(0, 400) };
}

export function reportSubFinish(sessionId, status = "done") {
  const id = String(sessionId || "").trim();
  const st = String(status || "done").toLowerCase() === "failed" ? "failed" : "done";
  if (!id) return { ok: false, error: "sessionId required" };

  const dir = `${SESSIONS}/${id}`;
  if (!existsSync(`${dir}/state.env`)) {
    return { ok: false, error: `no session ${id}` };
  }

  const hero = field(dir, "hero") || "unknown-hero";
  const summary = summaryFromOutput(dir);
  const subject = st === "failed" ? `sub ${id} failed` : `sub ${id} finished`;
  const body = [
    `Session ${id} · hero ${hero} · ${st}.`,
    "",
    summary,
    "",
    `Collect: ./scripts/gotchi-orchestrate.mjs output ${id}`,
  ].join("\n");

  // Agent graph: the sub session as one closed edge (spawn parent tracking is a
  // later pass, so the orchestrator stands in as the sender).
  if (hero !== "unknown-hero") {
    const started = field(dir, "started");
    // Where a sandbox job actually ran, and why auto fell back (desk VM → docker).
    const backend = field(dir, "sandbox") === "1" ? field(dir, "sandboxBackend") || "docker" : "";
    const fallback = field(dir, "sandboxFallback");
    void recordEdge({
      edgeId: `spawn:${id}`,
      kind: "spawn",
      from: "orchestrator",
      to: hero,
      ref: id,
      title: backend ? `${subject} · ${backend}${fallback ? ` (${fallback})` : ""}` : subject,
      ...(started ? { sentAt: started } : {}),
      answeredAt: field(dir, "ended") || new Date().toISOString(),
      outcome: st === "failed" ? "failed" : "done",
    });
  }

  const orchRestore = restoreOrch();
  const results = { sessionId: id, status: st, hero, orchRestore: orchRestore.ok };

  try {
    const toOrch = sendMessage({
      to: "orch",
      from: hero === "unknown-hero" ? "system" : hero,
      subject,
      body,
      kind: "report",
    });
    results.orchInbox = toOrch.id;
  } catch (e) {
    results.orchInboxError = String(e?.message || e);
  }

  // Orch missing / focus restore failed → also ping UserDefault.
  if (!orchRestore.ok || results.orchInboxError) {
    try {
      const toUser = sendMessage({
        to: "userdefault",
        from: hero === "unknown-hero" ? "system" : hero,
        subject: `${subject} (orch unavailable)`,
        body: [
          orchRestore.ok
            ? "Orch inbox send failed — relaying here."
            : "Could not restore orch focus — relaying here.",
          "",
          body,
          orchRestore.out ? `\nFocus: ${orchRestore.out}` : "",
          results.orchInboxError ? `\nInbox error: ${results.orchInboxError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        kind: "alert",
      });
      results.userInbox = toUser.id;
    } catch (e) {
      results.userInboxError = String(e?.message || e);
    }
  }

  results.ok = Boolean(results.orchInbox || results.userInbox);
  return results;
}

async function main() {
  const [sessionId, status] = process.argv.slice(2);
  if (!sessionId) {
    console.error("usage: sub-finish.mjs <sessionId> [done|failed]");
    process.exit(2);
  }
  const r = reportSubFinish(sessionId, status);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.ok) {
    console.error(`sub-finish: ${r.error || "partial failure"}`);
    if (r.orchInboxError) console.error(`  orch inbox: ${r.orchInboxError}`);
    if (r.userInboxError) console.error(`  user inbox: ${r.userInboxError}`);
  } else {
    console.log(
      `sub-finish ${r.sessionId} ${r.status}` +
        (r.orchRestore ? " · orch focus" : " · orch focus FAILED") +
        (r.orchInbox ? ` · inbox ${r.orchInbox}` : "") +
        (r.userInbox ? ` · user ${r.userInbox}` : ""),
    );
  }
  // Always exit 0 for the dispatch supervisor — finish hooks must not flip session status.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(0);
  });
}
