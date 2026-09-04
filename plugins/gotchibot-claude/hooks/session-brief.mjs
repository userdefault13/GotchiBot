#!/usr/bin/env node
/**
 * SessionStart — the desk state a fresh Claude session would otherwise have to
 * go and discover: passoff packets addressed to somebody, whether a meeting is
 * open, which hero has focus, and whether the tree is dirty.
 *
 * Local reads only (no SSH, no gateway) so it stays under a second.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./repo-root.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(HOOKS_DIR);
const SESSIONS = `${ROOT}/sessions`;

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const lines = [];

// Pending passoffs — work another gotchi handed over and nobody has picked up.
try {
  const packets = readdirSync(`${SESSIONS}/passoff`)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(`${SESSIONS}/passoff/${n}`))
    .filter((p) => p && p.status === "pending");
  if (packets.length) {
    lines.push(`Pending passoff${packets.length === 1 ? "" : "s"} (${packets.length}) — run \`./scripts/gotchibot passoff resume\` before planning new work:`);
    for (const p of packets.slice(0, 3)) {
      lines.push(`  - ${p.id}: ${p.from?.label} → ${p.to?.label || "(unsent)"} · ${String(p.task || "").slice(0, 90)}`);
    }
  }
} catch {
  /* no packets dir yet */
}

// Open meeting.
try {
  const id = String(readFileSync(`${SESSIONS}/meetings/.current`, "utf8")).trim();
  const meeting = id ? readJson(`${SESSIONS}/meetings/${id}/meeting.json`) : null;
  if (meeting?.status === "open") {
    const agents = (meeting.participants || []).filter((p) => p.role !== "user").length;
    lines.push(`Meeting OPEN: "${meeting.topic || id}" (${agents} gotchi${agents === 1 ? "" : "s"}) — /meet say, /meet end.`);
  }
} catch {
  /* no meeting */
}

// Focus + tree state.
const focus = readJson(`${SESSIONS}/.focus.json`);
if (focus?.heroId) lines.push(`Focus: ${focus.mode || "?"} · hero ${focus.heroId}`);

const git = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
if (git.status === 0) {
  const dirty = (git.stdout || "").split("\n").filter(Boolean).length;
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
  lines.push(`Branch ${(branch.stdout || "?").trim()} · ${dirty} uncommitted file${dirty === 1 ? "" : "s"}`);
}

if (!lines.length) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `GotchiBot desk state at session start:\n${lines.join("\n")}`,
    },
  }),
);
process.exit(0);
