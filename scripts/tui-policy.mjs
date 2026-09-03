#!/usr/bin/env node
/**
 * TUI input policy — Tab cycles agents in OpenCode, never via tmux pane restart.
 *
 *   node scripts/tui-policy.mjs show [--json]
 *   node scripts/tui-policy.mjs enforce [--json]   # exit 1 if drifted
 *   node scripts/tui-policy.mjs apply              # rewrite tui.json keybinds + unbind tmux Tab
 *
 * Policy file: config/tui-policy.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY = join(ROOT, "config/tui-policy.json");

export function loadPolicy() {
  const path = process.env.GOTCHIBOT_TUI_POLICY?.trim() || DEFAULT_POLICY;
  if (!existsSync(path)) {
    return {
      version: 0,
      name: "missing",
      rules: { tabCyclesInTui: true, tmuxStealTab: false, paneRestartOnTab: false },
      keybinds: { agent_cycle: "tab", agent_cycle_reverse: "shift+tab" },
      tuiFiles: ["config/tui.json"],
      path,
    };
  }
  return { ...JSON.parse(readFileSync(path, "utf8")), path };
}

function readJson(rel) {
  const p = join(ROOT, rel);
  try {
    return { path: p, data: JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    return { path: p, error: String(e?.message || e) };
  }
}

function readText(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * Drift checks — files + live tmux (if a gotchibot session exists).
 */
export function enforce(policy = loadPolicy()) {
  const issues = [];
  const kb = policy.keybinds || {};
  const files = policy.tuiFiles || ["config/tui.json"];

  for (const rel of files) {
    const { data, error } = readJson(rel);
    if (error) {
      issues.push({ code: "tui-json-missing", file: rel, detail: error });
      continue;
    }
    const got = data?.keybinds || {};
    for (const [k, want] of Object.entries(kb)) {
      if (String(got[k] || "") !== String(want)) {
        issues.push({
          code: "keybind-drift",
          file: rel,
          key: k,
          want,
          got: got[k] ?? null,
        });
      }
    }
  }

  const layout = readText("scripts/orchestrator-layout.sh");
  if (/\bbind-key\s+-n\s+Tab\b/.test(layout) || /\bbind-key\s+-T\s+gotchi-chat\s+Tab\b/.test(layout)) {
    issues.push({
      code: "tmux-steal-tab",
      file: "scripts/orchestrator-layout.sh",
      detail: "tmux must not bind Tab to agent-mode cycle --restart",
    });
  }

  const sync = readText(".opencode/tui-plugins/gotchi-agent-sync.ts");
  if (/agent-mode\.mjs["'][\s\S]*--restart/.test(sync) || /"set",\s*agent,\s*"--restart"/.test(sync)) {
    issues.push({
      code: "agent-sync-restart",
      file: ".opencode/tui-plugins/gotchi-agent-sync.ts",
      detail: "Tab cycle must persist mode without --restart",
    });
  }

  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const keys = spawnSync("tmux", ["list-keys", "-T", "root"], { encoding: "utf8" });
  if (keys.status === 0 && /^\s*bind-key\s+-T\s+root\s+Tab\b/m.test(keys.stdout || "")) {
    issues.push({
      code: "live-tmux-tab",
      detail: `session ${sess}: root Tab is bound — run tui-policy apply`,
    });
  }

  return {
    ok: issues.length === 0,
    policy: policy.name,
    rules: policy.rules,
    issues,
  };
}

export function apply(policy = loadPolicy()) {
  const kb = policy.keybinds || {};
  const files = policy.tuiFiles || [];
  const written = [];
  for (const rel of files) {
    const { path, data, error } = readJson(rel);
    if (error || !data) continue;
    data.keybinds = { ...(data.keybinds || {}), ...kb };
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    written.push(rel);
  }

  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const has = spawnSync("tmux", ["has-session", "-t", `=${sess}`], { stdio: "ignore" });
  let tmux = "no-session";
  if (has.status === 0) {
    for (const args of [
      ["unbind-key", "-n", "Tab"],
      ["unbind-key", "-n", "S-Tab"],
      ["unbind-key", "-n", "BTab"],
      ["unbind-key", "-T", "gotchi-chat", "Tab"],
      ["unbind-key", "-T", "gotchi-chat", "S-Tab"],
    ]) {
      spawnSync("tmux", args, { stdio: "ignore" });
    }
    tmux = "unbound-tab";
  }

  return { ok: true, policy: policy.name, written, tmux };
}

function printHuman(r) {
  console.log(`policy  ${r.policy}`);
  if (r.rules) {
    console.log(
      `rules   tabInTui=${r.rules.tabCyclesInTui} steal=${r.rules.tmuxStealTab} restartOnTab=${r.rules.paneRestartOnTab}`,
    );
  }
  if (r.written) console.log(`wrote   ${r.written.join(", ") || "(none)"}`);
  if (r.tmux) console.log(`tmux    ${r.tmux}`);
  if (r.issues?.length) {
    for (const i of r.issues) {
      console.log(`drift   ${i.code}  ${i.file || ""}  ${i.detail || i.key || ""}`);
    }
  } else if (r.ok != null) {
    console.log(r.ok ? "ok      enforce clean" : "fail");
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const cmd = args.find((a) => !a.startsWith("--")) || "show";
  const policy = loadPolicy();

  if (cmd === "show") {
    const out = {
      name: policy.name,
      path: policy.path,
      rules: policy.rules,
      keybinds: policy.keybinds,
      cycle: policy.cycle,
    };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`policy  ${out.name}`);
      console.log(`tab     ${out.keybinds?.agent_cycle} (reverse ${out.keybinds?.agent_cycle_reverse})`);
      console.log(`cycle   ${(out.cycle || []).join(" → ")}`);
      console.log(`tmux    steal Tab = ${out.rules?.tmuxStealTab}`);
      console.log(`restart on Tab = ${out.rules?.paneRestartOnTab}`);
      console.log(`meet    Tab = ${out.rules?.meetTab}`);
      console.log(`hard    ${out.rules?.hardRestartKey} (optional pane restart)`);
    }
    process.exit(0);
  }

  if (cmd === "enforce") {
    const r = enforce(policy);
    if (json) console.log(JSON.stringify(r, null, 2));
    else printHuman(r);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === "apply") {
    const r = apply(policy);
    if (json) console.log(JSON.stringify(r, null, 2));
    else printHuman(r);
    process.exit(0);
  }

  console.error(`usage:
  tui-policy.mjs show [--json]
  tui-policy.mjs enforce [--json]
  tui-policy.mjs apply`);
  process.exit(2);
}
