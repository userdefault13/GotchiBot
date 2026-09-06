/**
 * Desk state a fresh session would otherwise have to discover: pending
 * passoffs, open meeting, focus, branch dirtiness. Local reads only.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

  // A repo with a package.json and no node_modules fails in ways that read like
  // an outage — a CLI exiting instantly, imports vanishing, abra taking SSH and
  // every secret down with it. A disk-space cleanup removes the tree across
  // ~/Dev because 20 GB of it looks like build output. Say so up front rather
  // than let the session debug the wrong machine.
  try {
    if (existsSync(`${ROOT}/package.json`) && !existsSync(`${ROOT}/node_modules`)) {
      lines.push(
        `WARNING: node_modules is missing here — imports and CLIs will fail in misleading ways. ` +
          `Restore before debugging: npm ci (lockfile restore, allowed). See AGENTS.md.`,
      );
    }
  } catch {
    /* best effort */
  }

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

  try {
    const capsule = spawnSync(
      process.execPath,
      [`${ROOT}/scripts/contexter.mjs`, "latest", "--brief"],
      { cwd: ROOT, encoding: "utf8", timeout: 8_000 },
    );
    const brief = (capsule.stdout || "").trim();
    if (brief && !brief.startsWith("no context capsules")) {
      lines.push("Latest context capsule (verify before acting; continue from Next step):");
      lines.push(brief);
    }
  } catch {
    /* contexter optional */
  }

  return lines;
}

/** @param {string} [fromFileDir] */
export function deskBriefContext(fromFileDir) {
  const lines = deskBriefLines(fromFileDir);
  if (!lines.length) return null;
  return `GotchiBot desk state at session start:\n${lines.join("\n")}`;
}
