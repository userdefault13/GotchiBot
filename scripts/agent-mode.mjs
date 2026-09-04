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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = `${ROOT}/sessions/.agent-mode.json`;
const ALIAS = {
  mint: "ask",
  sub: "sandbox",
  "sub-agent": "sandbox",
  subagent: "sandbox",
  project: "sandbox", // /project is a modal, not a Tab agent
};
const MODES = new Set(["gotchi", "sandbox", "verse", "plan", "build", "ask"]);
const CYCLE = ["gotchi", "sandbox", "verse", "plan", "build", "ask"];

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

function restartChatPane(agent) {
  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  try {
    const mode = readFileSync(`${ROOT}/sessions/.layout-mode`, "utf8").trim();
    if (mode === "meet-gallery") {
      return { restarted: false, reason: "meet-gallery" };
    }
  } catch {
    /* ok */
  }
  const label = paneLabel(agent);
  spawnSync("tmux", ["set-option", "-t", `${sess}:work.1`, "pane-border-format", label], {
    stdio: "ignore",
  });
  const hasTmux = spawnSync("tmux", ["has-session", "-t", sess], { stdio: "ignore" }).status === 0;
  if (!hasTmux) {
    return { restarted: false, reason: "no-tmux" };
  }
  // Pin agent explicitly. Non-gotchi forces local OpenCode (no OpenClaw relay env).
  const localGuard =
    agent === "gotchi" ? "" : " GOTCHIBOT_GOTCHI_BACKEND=local GOTCHIBOT_OPENCODE_CONTINUE=0";
  const r = spawnSync(
    "tmux",
    [
      "respawn-pane",
      "-t",
      `${sess}:work.1`,
      "-k",
      `cd "${ROOT}" && GOTCHIBOT_SKIP_ONBOARDING=1 GOTCHIBOT_SKIP_COCKPIT=1 GOTCHIBOT_OPENCODE_CONTINUE=0 GOTCHIBOT_OPENCODE_AGENT=${agent}${localGuard} exec ./scripts/chat-pane.sh`,
    ],
    { stdio: "ignore" },
  );
  return { restarted: r.status === 0, reason: r.status === 0 ? "ok" : "respawn-failed" };
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
    process.exit(2);
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
