#!/usr/bin/env node
/**
 * Agent roster + focus for gotchi mode.
 *
 *   node scripts/agent-focus.mjs list [--json]
 *   node scripts/agent-focus.mjs switch [index|id]  # list all, or switch avatar+direct chat
 *   node scripts/agent-focus.mjs select <index|id> [--host local|imac]
 *   node scripts/agent-focus.mjs orch
 *   node scripts/agent-focus.mjs status [--json]
 *   node scripts/agent-focus.mjs chat "prompt…"   # route to focused sub-agent
 *
 * /switch, /list, and /orch OpenCode commands call this. Switching a gotchi pins
 * the avatar and sets SUB focus so chat prompts that agent directly; /orch returns
 * to the orchestrator hero.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta, saveMeta } from "./identity.mjs";
import {
  pinAvatar,
  loadOnboarding,
  fetchCartridgeHeroes,
} from "./onboarding-lib.mjs";
import { classifyFocusRoute } from "./focus-classify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS = `${SESSIONS}/.focus.json`;
const LIST_CACHE = `${SESSIONS}/.focus-list.json`;
const PIN = `${SESSIONS}/.pin`;

function ensureSessions() {
  mkdirSync(SESSIONS, { recursive: true });
}

function loadFocus() {
  try {
    return JSON.parse(readFileSync(FOCUS, "utf8"));
  } catch {
    return { mode: "orch", updatedAt: null };
  }
}

function saveFocus(data) {
  ensureSessions();
  writeFileSync(
    FOCUS,
    `${JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function signalAvatar(heroId) {
  if (!process.env.TMUX) return;
  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const pid = spawnSync(
    "tmux",
    ["display", "-p", "-t", `${sess}:work.2`, "#{pane_pid}"],
    { encoding: "utf8" },
  ).stdout?.trim();
  if (pid) spawnSync("kill", ["-USR1", pid], { stdio: "ignore" });
  // Also refresh pin via gotchibot avatar path for status bar
  try {
    writeFileSync(PIN, `${heroId}\n`);
  } catch {}
}

function field(path, key) {
  try {
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : "";
  } catch {
    return "";
  }
}

function scanLocalSessions() {
  if (!existsSync(SESSIONS)) return [];
  const out = [];
  for (const name of readdirSync(SESSIONS)) {
    if (!/^s\d/.test(name)) continue;
    const dir = `${SESSIONS}/${name}`;
    const st = `${dir}/state.env`;
    if (!existsSync(st)) continue;
    out.push({
      kind: "session",
      host: "local",
      id: name,
      status: field(st, "status") || "?",
      hero: field(st, "hero") || null,
      model: field(st, "model") || null,
      started: field(st, "started") || null,
    });
  }
  out.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return out;
}

async function scanRemoteSessionsAsync() {
  const host = process.env.REMOTE_HOST || "";
  const user = process.env.REMOTE_USER || "";
  const key = process.env.SSH_PRIVATE_KEY || "";
  if (!host || !user || !key) {
    return { ok: false, reason: "no-remote-ssh-env (abra run gotchibot -- …)", sessions: [] };
  }
  const { runSsh, assertRemoteReady, materializeKey } = await import("./remote-lib.mjs");
  let cfg;
  let keyMat;
  try {
    cfg = assertRemoteReady();
    keyMat = materializeKey(cfg.key);
  } catch (e) {
    return { ok: false, reason: String(e.message || e).split("\n")[0], sessions: [] };
  }
  try {
    const script = [
      `cd ${shellQuote(cfg.dir)}`,
      `for d in sessions/s*/; do`,
      `  [ -f "$d/state.env" ] || continue`,
      `  id=$(basename "$d")`,
      `  st=$(grep -E '^status=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  hero=$(grep -E '^hero=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  model=$(grep -E '^model=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  started=$(grep -E '^started=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$st" "$hero" "$model" "$started"`,
      `done`,
    ].join("\n");
    const r = runSsh(cfg, keyMat.path, script, { stdio: "pipe" });
    if (r.status !== 0) {
      return { ok: false, reason: (r.stderr || "ssh failed").slice(0, 200), sessions: [] };
    }
    const sessions = String(r.stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, status, hero, model, started] = line.split("\t");
        return {
          kind: "session",
          host: "imac",
          id,
          status: status || "?",
          hero: hero || null,
          model: model || null,
          started: started || null,
        };
      })
      .sort((a, b) => String(b.started).localeCompare(String(a.started)));
    return { ok: true, sessions };
  } finally {
    keyMat?.dispose?.();
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function loadHeroes() {
  const meta = loadMeta();
  if (!meta?.cartridgeId) return [];
  try {
    const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
    return heroes.map((h) => ({
      kind: "hero",
      host: "cartridge",
      id: h.id,
      status: h.agentStatus || "available",
      hero: h.id,
      collateral: h.collateral || h.collateralAddress || null,
      bindType: h.bindType || null,
      name: h.name || null,
      agentSessionId: h.agentSessionId || null,
      agentTask: h.agentTask || null,
    }));
  } catch (e) {
    // Fallback: active hero from meta only
    if (meta.activeHeroId) {
      return [
        {
          kind: "hero",
          host: "cartridge",
          id: meta.activeHeroId,
          status: "available",
          hero: meta.activeHeroId,
          collateral: null,
          bindType: null,
          name: null,
        },
      ];
    }
    return [];
  }
}

async function buildRoster() {
  const local = scanLocalSessions();
  const remote = await scanRemoteSessionsAsync();
  const heroes = await loadHeroes();
  const entries = [];
  for (const h of heroes) entries.push(h);
  for (const s of local) entries.push(s);
  for (const s of remote.sessions || []) entries.push(s);
  const numbered = entries.map((e, i) => ({ index: i + 1, ...e }));
  ensureSessions();
  writeFileSync(
    LIST_CACHE,
    `${JSON.stringify({ remote, entries: numbered, at: new Date().toISOString() }, null, 2)}\n`,
  );
  return { numbered, remote, heroes: heroes.length, local: local.length };
}

function printRoster({ numbered, remote }, { switchMode = false } = {}) {
  console.log(
    switchMode
      ? "GotchiBot /switch — pick an agent (avatar + direct chat)"
      : "GotchiBot agents — select with: /switch <n|id>   or   ./scripts/agent-focus.mjs switch <n|id>",
  );
  console.log("");

  const heroes = numbered.filter((e) => e.kind === "hero");
  const local = numbered.filter((e) => e.host === "local");
  const imac = numbered.filter((e) => e.host === "imac");

  if (heroes.length) {
    console.log("cAavegotchis");
    for (const e of heroes) {
      const coll = e.collateral ? ` · ${String(e.collateral).slice(0, 12)}` : "";
      const bt = e.bindType ? ` · ${e.bindType}` : "";
      const st = e.status || e.agentStatus ? ` [${e.status || e.agentStatus}]` : "";
      console.log(`  ${String(e.index).padStart(2)}. ${e.id}${bt}${coll}${st}`);
    }
    console.log("");
  }

  console.log("Local MBP sessions");
  if (!local.length) console.log("  (none)");
  for (const e of local) {
    console.log(
      `  ${String(e.index).padStart(2)}. ${e.id}  [${e.status}]  hero=${e.hero || "—"}`,
    );
  }
  console.log("");

  console.log("Remote iMac sessions");
  if (!remote.ok) {
    console.log(`  (unreachable: ${remote.reason})`);
    console.log("  tip: abra run gotchibot -- ./scripts/gotchibot agents");
  } else if (!imac.length) {
    console.log("  (none)");
  }
  for (const e of imac) {
    console.log(
      `  ${String(e.index).padStart(2)}. ${e.id}  [${e.status}]  hero=${e.hero || "—"}`,
    );
  }
  console.log("");

  const focus = loadFocus();
  if (focus.mode === "sub") {
    console.log(
      `Focus: SUB  hero=${focus.heroId || "—"}  session=${focus.sessionId || "—"}  host=${focus.host || "—"}`,
    );
  } else {
    console.log("Focus: ORCH (orchestrator)");
  }
  if (switchMode) {
    console.log("Next: /switch <n|id>   ·   back: /orch");
  } else {
    console.log("Switch: /switch <n|id>   ·   back: /orch");
  }
}

function resolveEntry(arg, hostFilter) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
  } catch {
    cache = null;
  }
  const entries = (cache?.entries || []).filter((e) =>
    hostFilter ? e.host === hostFilter || (hostFilter === "local" && e.host === "cartridge") : true,
  );
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    const hit = (cache?.entries || []).find((e) => e.index === n);
    if (!hit) throw new Error(`no entry #${n} — run list first`);
    return hit;
  }
  const hit =
    (cache?.entries || []).find((e) => e.id === arg) ||
    entries.find((e) => e.id === arg);
  if (hit) return hit;
  // Allow selecting a hero id even without fresh list
  if (arg.startsWith("starter-") || arg.startsWith("owned-") || arg.startsWith("s20")) {
    return {
      kind: arg.startsWith("s20") ? "session" : "hero",
      host: arg.startsWith("s20") ? "local" : "cartridge",
      id: arg,
      hero: arg.startsWith("s20") ? null : arg,
      status: "?",
    };
  }
  throw new Error(`unknown id ${arg} — run list first`);
}

function orchestratorHeroId() {
  const ob = loadOnboarding();
  const meta = loadMeta();
  // Prefer owned-* orchestrator; ignore starter-* left over from a bad pin
  if (ob.orchestratorHeroId && String(ob.orchestratorHeroId).startsWith("owned-")) {
    return ob.orchestratorHeroId;
  }
  try {
    const cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
    const owned = (cache.entries || []).find(
      (e) => e.kind === "hero" && String(e.id).startsWith("owned-"),
    );
    if (owned) return owned.id;
  } catch {}
  if (meta?.activeHeroId && String(meta.activeHeroId).startsWith("owned-")) {
    return meta.activeHeroId;
  }
  if (ob.orchestratorHeroId) return ob.orchestratorHeroId;
  return meta?.activeHeroId || "owned-954";
}

async function cmdSelect(arg, { host, via = "select" } = {}) {
  if (!arg) {
    console.error(`usage: agent-focus.mjs ${via} <index|id>`);
    process.exit(2);
  }
  // Always refresh roster so indexes match what the user just saw
  await buildRoster();
  const entry = resolveEntry(arg, host);
  let heroId = entry.hero || (entry.kind === "hero" ? entry.id : null);
  let sessionId = entry.kind === "session" ? entry.id : null;

  if (entry.kind === "session" && !heroId) {
    const st =
      entry.host === "local"
        ? `${SESSIONS}/${entry.id}/state.env`
        : null;
    if (st) heroId = field(st, "hero") || null;
  }

  if (!heroId && entry.kind === "hero") heroId = entry.id;
  if (!heroId) {
    console.error(`cannot pin avatar — no hero on ${entry.id}`);
    process.exit(1);
  }

  // Selecting the orchestrator hero returns to ORCH focus
  if (heroId === orchestratorHeroId() && entry.kind === "hero") {
    await cmdOrch();
    return;
  }

  pinAvatar(heroId, { asOrchestrator: false });
  signalAvatar(heroId);
  saveMeta({
    activeHeroId: heroId,
    sessionHeroes: {
      ...(loadMeta()?.sessionHeroes || {}),
      ...(sessionId ? { [sessionId]: heroId } : {}),
    },
  });
  const hostLabel =
    entry.host === "imac" ? "imac" : entry.host === "local" ? "local" : "local";
  saveFocus({
    mode: "sub",
    heroId,
    sessionId,
    host: hostLabel,
    kind: entry.kind,
    label: entry.id,
  });

  // Cartridge: spun up, waiting for prompts
  try {
    spawnSync(
      process.execPath,
      [
        `${ROOT}/scripts/hero-agent-state.mjs`,
        "set",
        heroId,
        "idle",
        "--host",
        hostLabel,
        ...(sessionId ? ["--session", sessionId] : []),
        "--task",
        `focused via /${via}`,
      ],
      { cwd: ROOT, stdio: "ignore", env: process.env },
    );
  } catch {}

  console.log(`switched → ${entry.id}`);
  console.log(`avatar  → ${heroId}`);
  console.log(`host    → ${hostLabel}`);
  console.log(`focus   → SUB`);
  console.log("");
  console.log("DIRECT_CHAT=1 — every following user message goes to this agent:");
  console.log(`  ./scripts/agent-focus.mjs chat "<their message>"`);
  console.log("Back to orchestrator: /orch   or   ./scripts/agent-focus.mjs orch");
}

/** /switch — list all agents, or switch to one (avatar + direct chat). */
async function cmdSwitch(arg, { host, json } = {}) {
  if (!arg) {
    const roster = await buildRoster();
    if (json) {
      console.log(JSON.stringify(roster, null, 2));
    } else {
      printRoster(roster, { switchMode: true });
    }
    return;
  }
  await cmdSelect(arg, { host, via: "switch" });
}

async function cmdOrch() {
  const heroId = orchestratorHeroId();
  pinAvatar(heroId, { asOrchestrator: true });
  signalAvatar(heroId);
  saveMeta({ activeHeroId: heroId });
  saveFocus({ mode: "orch", heroId, sessionId: null, host: null, kind: null });
  console.log(`orchestrator focus restored`);
  console.log(`avatar → ${heroId}`);
}

function cmdStatus(json) {
  const focus = loadFocus();
  const pin = existsSync(PIN) ? readFileSync(PIN, "utf8").trim() : null;
  const payload = { focus, pin };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else if (focus.mode === "sub") {
    console.log(
      `SUB focus hero=${focus.heroId} session=${focus.sessionId || "—"} host=${focus.host || "—"} pin=${pin || "—"}`,
    );
  } else {
    console.log(`ORCH focus hero=${focus.heroId || pin || "—"}`);
  }
}

function ensureGotchiAgentMode({ restart = false } = {}) {
  const args = [`${ROOT}/scripts/agent-mode.mjs`, "set", "gotchi"];
  if (restart) args.push("--restart");
  spawnSync(process.execPath, args, { cwd: ROOT, stdio: "ignore" });
}

/**
 * Switch SUB → ORCH + gotchi mode and hand the prompt back to the orchestrator.
 * By default does not spawn — the gotchi agent continues with the same prompt.
 * Pass spawn:true (CLI --spawn) to fan out immediately.
 */
async function escalateToOrch(prompt, { reason, spawn = false } = {}) {
  await cmdOrch();
  let mode = "gotchi";
  try {
    mode =
      spawnSync(process.execPath, [`${ROOT}/scripts/agent-mode.mjs`, "get"], {
        cwd: ROOT,
        encoding: "utf8",
      }).stdout?.trim() || "gotchi";
  } catch {}
  ensureGotchiAgentMode({ restart: mode !== "gotchi" });

  const payload = {
    escalated: true,
    route: "orch",
    reason: reason || "orch task",
    prompt: prompt.trim(),
    mode: "gotchi",
  };
  console.log(`escalated → orchestrator (${payload.reason})`);
  console.log(`gotchi mode + ORCH focus restored`);
  console.log(`prompt: ${payload.prompt}`);
  console.log(JSON.stringify(payload));

  if (!spawn) {
    console.log("");
    console.log("Continue as orchestrator: delegate-pick → spawn this prompt.");
    return;
  }

  const env = {
    ...process.env,
    GOTCHIBOT_SKIP_ABRA: process.env.GOTCHIBOT_SKIP_ABRA || "1",
    GOTCHIBOT_AUTO_APPROVE: "1",
  };
  delete env.GOTCHIBOT_HERO_ID;
  const wrapped = [
    `You are a GotchiBot sub-agent spawned by the orchestrator.`,
    `User task (escalated from SUB focus): ${prompt.trim()}`,
    `Write deliverable to sessions/<id>/output.md. Follow AGENTS.md.`,
  ].join("\n");
  const orchPath = `${ROOT}/scripts/gotchi-orchestrate.mjs`;
  const r = existsSync(orchPath)
    ? spawnSync(process.execPath, [orchPath, "spawn", "--model", "nim", wrapped], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      })
    : spawnSync(`${ROOT}/scripts/opencode-dispatch.sh`, ["new", "--model", "nim", wrapped], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

async function cmdChat(prompt, { force, spawnOnEscalate = false } = {}) {
  const focus = loadFocus();
  if (!prompt?.trim()) {
    console.error('usage: agent-focus.mjs chat "prompt" [--orch|--sub] [--spawn]');
    process.exit(2);
  }

  const classification = classifyFocusRoute(prompt);
  const shouldEscalate =
    force === "orch" ||
    (force !== "sub" && focus.mode === "sub" && classification.route === "orch");

  if (shouldEscalate) {
    await escalateToOrch(prompt, {
      reason: force === "orch" ? "forced --orch" : classification.reason,
      spawn: spawnOnEscalate,
    });
    return;
  }

  if (focus.mode !== "sub") {
    console.error("not in sub-agent focus — already ORCH; handle as orchestrator (delegate-pick / spawn)");
    console.log(
      JSON.stringify({
        escalated: false,
        route: "orch",
        reason: "already-orch",
        prompt: prompt.trim(),
      }),
    );
    return;
  }

  const env = {
    ...process.env,
    GOTCHIBOT_HERO_ID: focus.heroId || "",
    GOTCHIBOT_SKIP_ABRA: process.env.GOTCHIBOT_SKIP_ABRA || "1",
    GOTCHIBOT_AUTO_APPROVE: "1",
  };

  const wrapped = [
    `You are GotchiBot sub-agent focused as ${focus.heroId || focus.label}.`,
    focus.sessionId ? `Prior session: ${focus.sessionId} (host=${focus.host}).` : "",
    `User message: ${prompt.trim()}`,
    `Write deliverable to sessions/<new-id>/output.md. Follow AGENTS.md.`,
  ]
    .filter(Boolean)
    .join("\n");

  if (focus.host === "imac") {
    console.log(`sub chat → ${focus.heroId || focus.label} on imac (${classification.reason})`);
    const r = spawnSync(
      process.execPath,
      [
        `${ROOT}/scripts/remote-spawn.mjs`,
        "--model",
        "nim",
        ...(focus.heroId ? ["--hero", focus.heroId] : []),
        wrapped,
      ],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }

  console.log(`sub chat → ${focus.heroId || focus.label} local (${classification.reason})`);

  const r = spawnSync(
    `${ROOT}/scripts/opencode-dispatch.sh`,
    ["new", "--model", "nim", wrapped],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json") || process.argv.includes("--json");

  if (!cmd || cmd === "list" || cmd === "agents") {
    const hostIdx = rest.indexOf("--host");
    const roster = await buildRoster();
    if (json) {
      console.log(JSON.stringify(roster, null, 2));
    } else {
      printRoster(roster);
    }
    return;
  }

  if (cmd === "select" || cmd === "focus") {
    const hostIdx = rest.indexOf("--host");
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : null;
    const arg = rest.find((a) => a !== "--host" && a !== host && a !== "--json");
    await cmdSelect(arg, { host });
    return;
  }

  if (cmd === "switch") {
    const hostIdx = rest.indexOf("--host");
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : null;
    const arg = rest.find((a) => a !== "--host" && a !== host && a !== "--json");
    await cmdSwitch(arg, { host, json });
    return;
  }

  if (cmd === "orch" || cmd === "orchestrator") {
    await cmdOrch();
    return;
  }

  if (cmd === "status") {
    cmdStatus(json);
    return;
  }

  if (cmd === "classify") {
    const prompt = rest.filter((a) => a !== "--json").join(" ").trim();
    const result = classifyFocusRoute(prompt);
    if (json) console.log(JSON.stringify(result));
    else console.log(result.route);
    return;
  }

  if (cmd === "chat") {
    const forceOrch = rest.includes("--orch");
    const forceSub = rest.includes("--sub");
    const spawnOnEscalate = rest.includes("--spawn");
    const prompt = rest
      .filter((a) => a !== "--json" && a !== "--orch" && a !== "--sub" && a !== "--spawn")
      .join(" ")
      .trim();
    await cmdChat(prompt, {
      force: forceOrch ? "orch" : forceSub ? "sub" : null,
      spawnOnEscalate,
    });
    return;
  }

  console.error(`usage:
  agent-focus.mjs list [--json]
  agent-focus.mjs switch [index|id]     # list, or switch avatar+direct chat
  agent-focus.mjs select <index|id>
  agent-focus.mjs orch
  agent-focus.mjs status [--json]
  agent-focus.mjs classify "prompt" [--json]
  agent-focus.mjs chat "prompt" [--orch|--sub] [--spawn]`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
