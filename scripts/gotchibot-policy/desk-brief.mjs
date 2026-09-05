/**
 * Desk state a fresh session would otherwise have to discover: pending
 * passoffs, open meeting, focus, branch dirtiness. Local reads only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./repo-root.mjs";

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} [fromFileDir]
 * @returns {string[]} brief lines (empty if nothing notable)
 */
export function deskBriefLines(fromFileDir) {
  const ROOT = repoRoot(fromFileDir);
  const SESSIONS = `${ROOT}/sessions`;
  const lines = [];

  try {
    const packets = readdirSync(`${SESSIONS}/passoff`)
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJson(`${SESSIONS}/passoff/${n}`))
      .filter((p) => p && p.status === "pending");
    if (packets.length) {
      lines.push(
        `Pending passoff${packets.length === 1 ? "" : "s"} (${packets.length}) — run \`./scripts/gotchibot passoff resume\` before planning new work:`,
      );
      for (const p of packets.slice(0, 3)) {
        lines.push(
          `  - ${p.id}: ${p.from?.label} → ${p.to?.label || "(unsent)"} · ${String(p.task || "").slice(0, 90)}`,
        );
      }
    }
  } catch {
    /* no packets dir yet */
  }

  try {
    const id = String(readFileSync(`${SESSIONS}/meetings/.current`, "utf8")).trim();
    const meeting = id ? readJson(`${SESSIONS}/meetings/${id}/meeting.json`) : null;
    if (meeting?.status === "open") {
      const agents = (meeting.participants || []).filter((p) => p.role !== "user").length;
      lines.push(
        `Meeting OPEN: "${meeting.topic || id}" (${agents} gotchi${agents === 1 ? "" : "s"}) — /meet say, /meet end.`,
      );
    }
  } catch {
    /* no meeting */
  }

  const focus = readJson(`${SESSIONS}/.focus.json`);
  if (focus?.heroId) lines.push(`Focus: ${focus.mode || "?"} · hero ${focus.heroId}`);

  const git = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 5000,
  });
  if (git.status === 0) {
    const dirty = (git.stdout || "").split("\n").filter(Boolean).length;
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5000,
    });
    lines.push(
      `Branch ${(branch.stdout || "?").trim()} · ${dirty} uncommitted file${dirty === 1 ? "" : "s"}`,
    );
  }

  return lines;
}

/** @param {string} [fromFileDir] */
export function deskBriefContext(fromFileDir) {
  const lines = deskBriefLines(fromFileDir);
  if (!lines.length) return null;
  return `GotchiBot desk state at session start:\n${lines.join("\n")}`;
}
