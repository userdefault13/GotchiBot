#!/usr/bin/env node
/**
 * Deterministic graph-state CLI for GotchiBot (no LangGraph).
 *
 * Store:
 *   sessions/graph/<id>/state.json
 *
 * Usage:
 *   node scripts/graph-state.mjs init [--id <id>] --goal "…" [--stop-when "…"]
 *   node scripts/graph-state.mjs get <id> [--json]
 *   node scripts/graph-state.mjs set <id> --status … | --next … | --findings-file <path> | --stop-when …
 *   node scripts/graph-state.mjs next <id>
 *   node scripts/graph-state.mjs stop <id> [--reason …] [--failed]
 *   node scripts/graph-state.mjs list [--json]
 *
 * Exit codes: 0 ok, 1 not found / write error, 2 usage / bad args
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readJsonMap, writeJsonAtomic } from "./json-store.mjs";

const STATUSES = new Set(["pending", "running", "blocked", "done", "failed"]);

function resolveRoot() {
  const fromEnv = process.env.GOTCHIBOT_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const ROOT = resolveRoot();
const GRAPH_ROOT = join(ROOT, "sessions", "graph");

function nowIso() {
  return new Date().toISOString();
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage:
  gotchibot graph init [--id <id>] --goal "…" [--stop-when "…"]
  gotchibot graph get <id> [--json]
  gotchibot graph set <id> --status … | --next … | --findings-file <path> | --stop-when …
  gotchibot graph next <id>
  gotchibot graph stop <id> [--reason …] [--failed]
  gotchibot graph list [--json]`);
  process.exit(2);
}

function statePath(id) {
  return join(GRAPH_ROOT, id, "state.json");
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function loadState(id) {
  const path = statePath(id);
  if (!existsSync(path)) return null;
  const { data, ok, missing } = readJsonMap(path);
  if (missing) return null;
  if (!ok) {
    console.error(`graph-state: unreadable state at ${path}`);
    process.exit(1);
  }
  return { state: data, path };
}

function saveState(id, state) {
  const dir = join(GRAPH_ROOT, id);
  ensureDir(dir);
  const path = statePath(id);
  state.updatedAt = nowIso();
  if (!writeJsonAtomic(path, state)) {
    console.error(`graph-state: failed to write ${path}`);
    process.exit(1);
  }
  return path;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
    } else if (a === "--failed") {
      out.failed = true;
    } else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq);
      out[key] = a.slice(eq + 1);
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printState(state, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  }
}

function cmdInit(args) {
  const goal = args.goal;
  if (!goal || goal === true) usage("graph init: --goal is required");
  const id = args.id && args.id !== true ? String(args.id) : randomUUID();
  const path = statePath(id);
  if (existsSync(path)) {
    console.error(`graph-state: id already exists: ${id}`);
    process.exit(1);
  }
  const state = {
    id,
    goal: String(goal),
    status: "pending",
    findings: {},
    next: null,
    stop_when: args["stop-when"] && args["stop-when"] !== true ? String(args["stop-when"]) : "",
    updatedAt: nowIso(),
  };
  const written = saveState(id, state);
  process.stdout.write(
    `id=${id}\npath=${written}\n${JSON.stringify(state, null, 2)}\n`,
  );
  process.exit(0);
}

function cmdGet(args) {
  const id = args._[0];
  if (!id) usage("graph get: <id> required");
  const loaded = loadState(id);
  if (!loaded) {
    console.error(`graph-state: not found: ${id}`);
    process.exit(1);
  }
  printState(loaded.state, !!args.json);
  process.exit(0);
}

function cmdSet(args) {
  const id = args._[0];
  if (!id) usage("graph set: <id> required");
  const loaded = loadState(id);
  if (!loaded) {
    console.error(`graph-state: not found: ${id}`);
    process.exit(1);
  }
  const state = { ...loaded.state };
  let touched = false;

  if (args.status !== undefined && args.status !== true) {
    const status = String(args.status);
    if (!STATUSES.has(status)) {
      usage(`graph set: invalid --status ${status} (pending|running|blocked|done|failed)`);
    }
    state.status = status;
    touched = true;
  }
  if (args.next !== undefined && args.next !== true) {
    const n = String(args.next);
    state.next = n === "null" ? null : n;
    touched = true;
  }
  if (args["stop-when"] !== undefined && args["stop-when"] !== true) {
    state.stop_when = String(args["stop-when"]);
    touched = true;
  }
  if (args["findings-file"] !== undefined && args["findings-file"] !== true) {
    const fp = resolve(String(args["findings-file"]));
    if (!existsSync(fp)) {
      console.error(`graph-state: findings file not found: ${fp}`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(fp, "utf8"));
    } catch (e) {
      console.error(`graph-state: invalid JSON in findings file: ${e.message || e}`);
      process.exit(1);
    }
    // Merge findings: object→object deep-ish shallow merge; array replaces; else wrap
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      state.findings &&
      typeof state.findings === "object" &&
      !Array.isArray(state.findings)
    ) {
      state.findings = { ...state.findings, ...parsed };
    } else {
      state.findings = parsed;
    }
    touched = true;
  }

  if (!touched) {
    usage("graph set: provide at least one of --status, --next, --findings-file, --stop-when");
  }

  const written = saveState(id, state);
  process.stdout.write(`path=${written}\n${JSON.stringify(state, null, 2)}\n`);
  process.exit(0);
}

function cmdNext(args) {
  const id = args._[0];
  if (!id) usage("graph next: <id> required");
  const loaded = loadState(id);
  if (!loaded) {
    console.error(`graph-state: not found: ${id}`);
    process.exit(1);
  }
  const state = { ...loaded.state };
  if (state.status === "done" || state.status === "failed") {
    state.next = "stop";
    saveState(id, state);
    process.stdout.write("next=stop\n");
    process.exit(0);
  }
  const n = state.next == null || state.next === "" ? "stop" : String(state.next);
  process.stdout.write(`next=${n}\n`);
  process.exit(0);
}

function cmdStop(args) {
  const id = args._[0];
  if (!id) usage("graph stop: <id> required");
  const loaded = loadState(id);
  if (!loaded) {
    console.error(`graph-state: not found: ${id}`);
    process.exit(1);
  }
  const state = { ...loaded.state };
  state.status = args.failed ? "failed" : "done";
  state.next = "stop";
  if (args.reason !== undefined && args.reason !== true) {
    const reason = String(args.reason);
    if (
      state.findings &&
      typeof state.findings === "object" &&
      !Array.isArray(state.findings)
    ) {
      state.findings = { ...state.findings, reason };
    } else if (Array.isArray(state.findings)) {
      state.findings = [...state.findings, { reason }];
    } else {
      state.findings = { reason };
    }
    state.reason = reason;
  }
  const written = saveState(id, state);
  process.stdout.write(`path=${written}\n${JSON.stringify(state, null, 2)}\n`);
  process.exit(0);
}

function cmdList(args) {
  ensureDir(GRAPH_ROOT);
  const ids = existsSync(GRAPH_ROOT)
    ? readdirSync(GRAPH_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  const rows = [];
  for (const id of ids) {
    const loaded = loadState(id);
    if (!loaded) continue;
    const s = loaded.state;
    rows.push({
      id: s.id || id,
      goal: s.goal ?? "",
      status: s.status ?? "",
      next: s.next ?? null,
      updatedAt: s.updatedAt ?? "",
    });
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else if (rows.length === 0) {
    process.stdout.write("(no graph states)\n");
  } else {
    for (const r of rows) {
      process.stdout.write(
        `${r.id}\t${r.status}\tnext=${r.next ?? ""}\t${r.goal}\t${r.updatedAt}\n`,
      );
    }
  }
  process.exit(0);
}

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._.shift();
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") usage();
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "get":
      return cmdGet(args);
    case "set":
      return cmdSet(args);
    case "next":
      return cmdNext(args);
    case "stop":
      return cmdStop(args);
    case "list":
      return cmdList(args);
    default:
      usage(`graph-state: unknown subcommand: ${cmd}`);
  }
}

main(process.argv.slice(2));
