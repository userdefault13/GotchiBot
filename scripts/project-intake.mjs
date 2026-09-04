#!/usr/bin/env node
/**
 * Unsupervised project intake — collect every requirement before spawn.
 *
 *   node scripts/project-intake.mjs show [--json]
 *   node scripts/project-intake.mjs new
 *   node scripts/project-intake.mjs set <field> <value…>
 *   node scripts/project-intake.mjs ready [--json]   # exit 1 if incomplete
 *   node scripts/project-intake.mjs prompts          # print all questions
 *
 * Policy: config/project-policy.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "config/project-policy.json");
const DIR = join(ROOT, "sessions/projects");
const CURRENT = join(ROOT, "sessions/.project-current");

export function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

function slug(s) {
  return String(s || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "project";
}

function emptyProject(policy) {
  const fields = {};
  for (const f of policy.fields || []) {
    fields[f.id] = f.default ?? "";
  }
  return {
    id: `p${Date.now()}`,
    status: "intake",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fields,
  };
}

export function currentPath() {
  try {
    const id = readFileSync(CURRENT, "utf8").trim();
    if (id) return join(DIR, `${id}.json`);
  } catch {
    /* none */
  }
  return null;
}

export function loadCurrent() {
  const p = currentPath();
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function save(project) {
  mkdirSync(DIR, { recursive: true });
  project.updatedAt = new Date().toISOString();
  const file = join(DIR, `${project.id}.json`);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  writeFileSync(CURRENT, `${project.id}\n`);
  return file;
}

export function missingFields(project, policy = loadPolicy()) {
  const miss = [];
  for (const f of policy.fields || []) {
    if (!f.required) continue;
    const v = String(project?.fields?.[f.id] ?? "").trim();
    if (!v) miss.push(f);
  }
  return miss;
}

export function walletGate() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/wallet-gate.mjs"), "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
  try {
    return JSON.parse((r.stdout || "").trim() || "{}");
  } catch {
    return { ok: false, code: "gate-parse", message: (r.stderr || r.stdout || "wallet-gate failed").slice(0, 200) };
  }
}

export function readiness(project = loadCurrent(), policy = loadPolicy()) {
  const gate = walletGate();
  const missing = project ? missingFields(project, policy) : policy.fields.filter((f) => f.required);
  const live = String(project?.fields?.live || "paper-only").toLowerCase();
  const issues = [];
  if (!project) issues.push({ code: "no-project", detail: "run: project-intake.mjs new" });
  for (const f of missing) issues.push({ code: "missing", field: f.id, prompt: f.prompt });
  if (policy.rules?.walletGateRequired && !gate.ok) {
    issues.push({ code: gate.code || "gate", detail: gate.message, fix: gate.fix });
  }
  if (live.includes("live") && !live.includes("paper")) {
    issues.push({ code: "live-confirm", detail: "live execution needs explicit Julius confirm — default is paper-only" });
  }
  return {
    ok: issues.length === 0,
    project: project?.id || null,
    status: project?.status || "none",
    gate,
    missing: missing.map((f) => f.id),
    issues,
    spawnOk: issues.length === 0 && policy.rules?.neverAutoSpawn === true ? "confirm-then-spawn" : false,
  };
}

function printShow(project, policy) {
  const r = readiness(project, policy);
  console.log(`project  ${project?.id || "(none)"}  status=${project?.status || "none"}`);
  console.log(`gate     ${r.gate.ok ? "ok" : `BLOCKED ${r.gate.code || ""} — ${r.gate.message || ""}`}`);
  if (r.gate.fix) console.log(`         → ${r.gate.fix}`);
  console.log("");
  console.log("Requirements (unsupervised agent project):");
  for (const f of policy.fields || []) {
    const v = String(project?.fields?.[f.id] ?? "").trim();
    const mark = v ? "✓" : f.required ? "○" : "·";
    console.log(`  ${mark} ${f.id.padEnd(10)} ${v || f.prompt}`);
  }
  console.log("");
  if (!r.ok) {
    console.log("Missing / blocked — answer these next:");
    for (const i of r.issues) {
      if (i.prompt) console.log(`  • ${i.field}: ${i.prompt}`);
      else console.log(`  • ${i.detail}${i.fix ? ` → ${i.fix}` : ""}`);
    }
    console.log("");
    console.log("Set:  node scripts/project-intake.mjs set <field> <value>");
    console.log("Do not spawn until: node scripts/project-intake.mjs ready");
  } else {
    console.log("Intake complete. Do not auto-spawn. Confirm with Julius, then delegate-first spawn.");
  }
}


if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const cmd = args.find((a) => !a.startsWith("--")) || "show";
  const policy = loadPolicy();

  if (cmd === "prompts") {
    for (const f of policy.fields) {
      console.log(`${f.id}\t${f.required ? "required" : "optional"}\t${f.prompt}`);
    }
    process.exit(0);
  }

  if (cmd === "new") {
    const p = emptyProject(policy);
    save(p);
    if (json) console.log(JSON.stringify(p, null, 2));
    else {
      console.log(`created ${p.id}`);
      printShow(p, policy);
    }
    process.exit(0);
  }

  if (cmd === "set") {
    const rest = args.filter((a) => a !== "set" && a !== "--json");
    const field = rest[0];
    const value = rest.slice(1).join(" ").trim();
    const ids = new Set((policy.fields || []).map((f) => f.id));
    if (!field || !ids.has(field) || !value) {
      console.error(`usage: project-intake.mjs set <${[...ids].join("|")}> <value>`);
      process.exit(2);
    }
    let p = loadCurrent() || emptyProject(policy);
    p.fields[field] = value;
    if (field === "title" && p.id.startsWith("p") && /^\d+$/.test(p.id.slice(1))) {
      p.id = `${slug(value)}-${Date.now().toString().slice(-6)}`;
    }
    save(p);
    if (json) console.log(JSON.stringify(p, null, 2));
    else console.log(`set ${field}`);
    process.exit(0);
  }

  if (cmd === "ready") {
    let p = loadCurrent();
    const r = readiness(p, policy);
    if (json) console.log(JSON.stringify(r, null, 2));
    else printShow(p, policy);
    process.exit(r.ok ? 0 : 1);
  }

  // show
  let p = loadCurrent();
  if (!p) {
    p = emptyProject(policy);
    save(p);
  }
  if (json) console.log(JSON.stringify({ project: p, ...readiness(p, policy) }, null, 2));
  else printShow(p, policy);
  process.exit(0);
}
