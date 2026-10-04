#!/usr/bin/env node
/**
 * Persist OpenCode primary agent (gotchi | sandbox | verse | plan | build | ask).
 *
 * usage:
 *   node scripts/agent-mode.mjs
 *   node scripts/agent-mode.mjs set sandbox
 *   node scripts/agent-mode.mjs cycle [--reverse] [--restart]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chatPaneTarget, sessionName } from "./tmux-pane.mjs";
import { currentProjectSlug } from "./project-context.mjs";
import { chatSessionFor, loadChatMap } from "./project-chat.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = `${ROOT}/sessions/.agent-mode.json`;
const ALIAS = {
  mint: "ask",
  sub: "sandbox",
  "sub-agent": "sandbox",
  subagent: "sandbox",
  project: "sandbox", // /project is a modal, not a Tab agent
  wisp: "gotchi", // Wisp is /model wisp/gotchi, not a Tab agent
};
const MODES = new Set(["gotchi", "sandbox", "verse", "plan", "build", "ask"]);
const CYCLE = ["gotchi", "sandbox", "verse", "plan", "build", "ask"];
// wisp is a /model (provider wisp), not a Tab agent — see scripts/wisp-proxy.mjs

function load() {
  try {
    const data = JSON.parse(readFileSync(STATE, "utf8"));
    const agent = ALIAS[data.agent] || data.agent;
    return MODES.has(agent) ? agent : "gotchi";
  } catch {
    return "gotchi";
  }
}

function save(agent) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify({ agent, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

function paneLabel(agent) {
  switch (agent) {
    case "ask":
      return " Ask ";
    case "sandbox":
      return " Sandbox ";
    case "verse":
      return " Verse ";
    case "plan":
      return " Plan ";
    case "build":
      return " Build ";
    default:
      return " Gotchi ";
  }
}

const SESSION_MAP = `${ROOT}/sessions/.opencode-agent-sessions.json`;
const OPENCODE_DB = `${process.env.HOME}/.local/share/opencode/opencode.db`;

function loadSessionMap() {
  try {
    return JSON.parse(readFileSync(SESSION_MAP, "utf8"));
  } catch {
    return {};
  }
}

function saveSessionMap(map) {
  mkdirSync(dirname(SESSION_MAP), { recursive: true });
  writeFileSync(SESSION_MAP, `${JSON.stringify(map, null, 2)}\n`);
}

/** Remember the newest OpenCode session for a side agent (ask/plan/build/…). */
function rememberAgentSession(agent) {
  if (agent === "gotchi") {
    // Never adopt the newest GotchiBot row — that transcript belongs to whichever
    // project last wrote it. A project with no pin starts empty.
    return chatSessionFor(loadChatMap(), currentProjectSlug()) || null;
  }
  if (!agent || !existsSync(OPENCODE_DB)) return null;
  try {
    const safe = String(agent).replace(/[^a-z0-9_-]/gi, "");
    const sql = `SELECT id, title FROM session WHERE directory LIKE '%/GotchiBot%' AND agent='${safe}' AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1;`;
    const q = spawnSync(
      "sqlite3",
      ["-separator", "\t", OPENCODE_DB, sql],
      { encoding: "utf8" },
    );
    const line = (q.stdout || "").trim();
    if (!line) return null;
    const [id, ...titleParts] = line.split("\t");
    const title = titleParts.join("\t");
    if (!id.startsWith("ses_")) return null;
    const map = loadSessionMap();
    map[agent] = { sessionId: id, title: title || null, updatedAt: new Date().toISOString() };
    saveSessionMap(map);
    return id;
  } catch {
    return null;
  }
}

function pinnedSessionFor(agent) {
  if (agent === "gotchi") return chatSessionFor(loadChatMap(), currentProjectSlug());
  const map = loadSessionMap();
  const id = map[agent]?.sessionId || "";
  return id.startsWith("ses_") ? id : "";
}

function restartChatPane(agent) {
  const sess = sessionName();
  const chat = chatPaneTarget(sess);
  try {
    const mode = readFileSync(`${ROOT}/sessions/.layout-mode`, "utf8").trim();
    if (mode === "meet-gallery") {
      return { restarted: false, reason: "meet-gallery" };
    }
  } catch {
    /* ok */
  }
  // Snapshot the mode we're leaving so switch-back can restore its project chat.
  const leaving = load();
  if (leaving && leaving !== agent) rememberAgentSession(leaving);
  rememberAgentSession(agent);

  const label = paneLabel(agent);
  spawnSync("tmux", ["set-option", "-p", "-t", chat, "pane-border-format", label], {
    stdio: "ignore",
  });
  const hasTmux = spawnSync("tmux", ["has-session", "-t", `=${sess}`], { stdio: "ignore" }).status === 0;
  if (!hasTmux) {
    return { restarted: false, reason: "no-tmux" };
  }

  // Gotchi mode = current project chat only. Never --continue (that resumes whatever
  // OpenCode touched last, often a Wisp Greeting Tab-rewritten to agent=gotchi).
  let pinned = pinnedSessionFor(agent);
  if (agent === "gotchi" && !pinned) {
    pinned = rememberAgentSession("gotchi") || "";
  }
  const envParts = [
    "GOTCHIBOT_SKIP_ONBOARDING=1",
    "GOTCHIBOT_SKIP_COCKPIT=1",
    `GOTCHIBOT_OPENCODE_AGENT=${agent}`,
  ];
  if (agent !== "gotchi") {
    envParts.push("GOTCHIBOT_GOTCHI_BACKEND=local");
  }
  if (pinned) {
    envParts.push(`GOTCHIBOT_OPENCODE_SESSION=${pinned}`);
    envParts.push("GOTCHIBOT_OPENCODE_CONTINUE=0");
  } else {
    // Side mode with no history, or gotchi with no project session yet → fresh.
    envParts.push("GOTCHIBOT_OPENCODE_CONTINUE=0");
  }

  const r = spawnSync(
    "tmux",
    [
      "respawn-pane",
      "-t",
      chat,
      "-k",
      `cd "${ROOT}" && ${envParts.join(" ")} exec ./scripts/chat-pane.sh`,
    ],
    { stdio: "ignore" },
  );
  return {
    restarted: r.status === 0,
    reason: r.status === 0 ? "ok" : "respawn-failed",
    sessionId: pinned || null,
    continue: !pinned && agent === "gotchi",
  };
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

if (!cmd || cmd === "get") {
  const agent = load();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ agent, stateFile: STATE, modes: [...MODES] }, null, 2));
  } else {
    console.log(agent);
  }
  process.exit(0);
}

if (cmd === "cycle") {
  const reverse = rest.includes("--reverse");
  const cur = load();
  const i = Math.max(0, CYCLE.indexOf(cur));
  const next = CYCLE[(i + (reverse ? CYCLE.length - 1 : 1)) % CYCLE.length];
  save(next);
  let restart = { restarted: false };
  if (rest.includes("--restart")) {
    restart = restartChatPane(next);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: next, from: cur, restart }, null, 2));
  } else {
    console.log(`mode: ${next} (was ${cur})`);
    if (rest.includes("--restart")) {
      console.log(restart.restarted ? "chat pane restarted" : `restart skipped (${restart.reason})`);
    }
  }
  process.exit(0);
}

if (cmd === "set") {
  const raw = rest.find((a) => !a.startsWith("--"));
  const agent = ALIAS[raw] || raw;
  if (!agent || !MODES.has(agent)) {
    console.error(`usage: agent-mode.mjs set gotchi|sandbox|verse|plan|build|ask [--restart]`);
    if (raw === "wisp") console.error("hint: Wisp is a model — /model wisp/gotchi (start: gotchibot wisp-proxy)");
    process.exit(2);
  }
  if (raw === "wisp") {
    console.error("note: wisp is not a Tab agent; staying on gotchi. Use /model wisp/gotchi");
  }
  save(agent);
  let restart = { restarted: false };
  if (rest.includes("--restart")) {
    restart = restartChatPane(agent);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent, restart }, null, 2));
  } else {
    console.log(`mode: ${agent}`);
    if (rest.includes("--restart")) {
      console.log(restart.restarted ? "chat pane restarted" : `restart skipped (${restart.reason})`);
    } else {
      console.log("restart OpenCode pane or: gotchibot mode " + agent + " --restart");
    }
  }
  process.exit(0);
}

console.error(`usage: agent-mode.mjs [get] | set gotchi|sandbox|verse|plan|build|ask [--restart] | cycle [--reverse] [--restart]`);
process.exit(2);
