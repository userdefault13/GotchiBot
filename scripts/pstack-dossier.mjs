#!/usr/bin/env node
/**
 * pstack-dossier — chief (owned-954) SoT per program slug.
 *
 * The dossier.json at sessions/pstack/<slug>/dossier.json is the single source
 * of truth for a pstack program's template fields. The dossier window
 * (scripts/pstack-window.mjs, tmux work.2 while mode=pstack-dossier) renders it;
 * fields are edited here via CLI. Separate from sandbox project-intake.
 *
 *   node scripts/pstack-dossier.mjs new <slug> [--title "…"] [--goal "…"] [--playbook <label>]
 *       [--scope "…"] [--context "…"] [--acceptance "…"] [--verify "…"] [--forbidden "…"]
 *       [--done "…"] [--timebox "…"] [--units "…"] [--principles "…"] [--approaches "…"]
 *       [--host auto] [--report "…"] [--notes "…"] [--force]
 *   node scripts/pstack-dossier.mjs show [<slug>] [--json]
 *   node scripts/pstack-dossier.mjs set <slug> <field> <value…>
 *   node scripts/pstack-dossier.mjs ready <slug> [--json]   # exit 1 if incomplete
 *   node scripts/pstack-dossier.mjs list [--json]
 *   node scripts/pstack-dossier.mjs fields [--json]
 *   node scripts/pstack-dossier.mjs current [<slug>]        # get/set pane current
 *
 * Policy: config/pstack-dossier-policy.json
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { setCurrentProject as syncProjectPointers, ensureProjectDirs } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "config", "pstack-dossier-policy.json");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const CURRENT = join(ROOT, "sessions", ".pstack-dossier-current");

const DEFAULT_STATUS = "draft";
const VALID_STATUS = new Set(["draft", "ready"]);

export function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function dossierPath(slug) {
  return join(PSTACK_ROOT, slug, "dossier.json");
}

function emptyDossier(slug, policy) {
  const fields = {};
  for (const f of policy.fields || []) {
    fields[f.id] = f.default ?? "";
  }
  return {
    slug,
    schemaVersion: policy.version || 1,
    status: DEFAULT_STATUS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fields,
  };
}

function loadDossier(slug) {
  const p = dossierPath(slug);
  if (!existsSync(p)) return null;
  return readJson(p);
}

function saveDossier(dossier) {
  dossier.updatedAt = new Date().toISOString();
  const p = dossierPath(dossier.slug);
  writeJson(p, dossier);
  return p;
}

export function missingFields(dossier, policy = loadPolicy()) {
  const miss = [];
  for (const f of policy.fields || []) {
    if (!f.required) continue;
    const v = String(dossier?.fields?.[f.id] ?? "").trim();
    if (!v) miss.push(f);
  }
  return miss;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function listPrograms() {
  mkdirSync(PSTACK_ROOT, { recursive: true });
  if (!existsSync(PSTACK_ROOT)) return [];
  return readdirSync(PSTACK_ROOT)
    .filter((name) => {
      try {
        return statSync(join(PSTACK_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function currentSlug() {
  try {
    const s = readFileSync(CURRENT, "utf8").trim();
    return s || null;
  } catch {
    return null;
  }
}

function setCurrent(slug) {
  mkdirSync(dirname(CURRENT), { recursive: true });
  writeFileSync(CURRENT, `${slug}\n`, "utf8");
  // Projects are sealed rooms — keep .project-current + dirs in lockstep.
  try {
    syncProjectPointers(slug);
  } catch {
    writeFileSync(join(ROOT, "sessions", ".project-current"), `${slug}\n`, "utf8");
    try {
      ensureProjectDirs(slug);
    } catch {
      /* ignore */
    }
  }
}

function resolveSlug(given) {
  if (given) {
    if (!slugOk(given)) die(`invalid slug: ${given}`);
    return given;
  }
  const cur = currentSlug();
  if (cur && existsSync(dossierPath(cur))) return cur;
  const withDossier = listPrograms().filter((s) => existsSync(dossierPath(s)));
  if (withDossier.length) return withDossier[0];
  return null;
}

function cmdNew(slug, flags) {
  if (!slugOk(slug)) die(`invalid slug: ${slug}`);
  const policy = loadPolicy();
  const p = dossierPath(slug);
  if (existsSync(p) && !flags.force) {
    die(`dossier already exists: ${relative(ROOT, p)} (pass --force to reseed)`);
  }
  const d = emptyDossier(slug, policy);
  const map = {
    title: "title",
    goal: "goal",
    playbook: "playbook",
    scope: "scope",
    context: "context",
    acceptance: "acceptance",
    verify: "verify",
    forbidden: "forbidden",
    done: "done",
    timebox: "timebox",
    units: "units",
    principles: "principles",
    approaches: "approaches",
    host: "host",
    report: "report",
    notes: "notes",
  };
  for (const [flag, field] of Object.entries(map)) {
    if (typeof flags[flag] === "string" && flags[flag] !== "") {
      d.fields[field] = flags[flag];
    }
  }
  if (typeof flags.status === "string") d.status = flags.status;
  const saved = saveDossier(d);
  setCurrent(slug);
  const miss = missingFields(d, policy);
  if (flags.json) {
    console.log(JSON.stringify({ slug, path: relative(ROOT, saved), missing: miss.map((f) => f.id) }, null, 2));
    return;
  }
  console.log(`dossier ${slug} → ${relative(ROOT, saved)}`);
  if (miss.length) {
    console.log(`missing required: ${miss.map((f) => f.id).join(", ")}`);
    console.log(`set: ./scripts/gotchibot pstack dossier set ${slug} <field> <value>`);
  } else {
    console.log("complete — ready");
  }
}

function cmdShow(slug, flags) {
  const target = resolveSlug(slug);
  if (!target) {
    if (flags.json) {
      console.log(JSON.stringify({ slug: null, dossier: null }, null, 2));
      return;
    }
    die(`no dossier — run: ./scripts/gotchibot pstack dossier new <slug> --goal "…"`);
  }
  const d = loadDossier(target);
  const policy = loadPolicy();
  const miss = missingFields(d, policy);
  if (flags.json) {
    console.log(JSON.stringify({ slug: target, dossier: d, missing: miss.map((f) => f.id) }, null, 2));
    return;
  }
  console.log(`# dossier — ${target} (${d.status})`);
  console.log(`path: sessions/pstack/${target}/dossier.json`);
  console.log(`created: ${d.createdAt}`);
  console.log(`updated: ${d.updatedAt}`);
  console.log("");
  for (const f of policy.fields || []) {
    const v = String(d?.fields?.[f.id] ?? "").trim();
    const mark = f.required && !v ? "!" : " ";
    console.log(` ${mark} ${f.id.padEnd(10)} ${v || f.prompt}`);
  }
  console.log("");
  if (miss.length) {
    console.log(`missing required: ${miss.map((f) => f.id).join(", ")}`);
    console.log(`set: ./scripts/gotchibot pstack dossier set ${target} <field> <value>`);
  } else {
    console.log("complete — ready");
  }
}

function cmdSet(slug, field, value, flags) {
  if (!slugOk(slug)) die(`invalid slug: ${slug}`);
  const policy = loadPolicy();
  const d = loadDossier(slug);
  if (!d) die(`no dossier: ${slug} (run: gotchibot pstack dossier new ${slug} --goal "…")`);
  const ids = new Set((policy.fields || []).map((f) => f.id));
  if (field === "status") {
    if (!VALID_STATUS.has(value)) die(`status must be draft|ready`);
    d.status = value;
    const saved = saveDossier(d);
    setCurrent(slug);
    if (flags.json) console.log(JSON.stringify({ slug, field, value, path: relative(ROOT, saved) }, null, 2));
    else console.log(`dossier ${slug}: status = ${value}`);
    return;
  }
  if (!field || !ids.has(field)) {
    die(`unknown field: ${field} (fields: ${[...ids].join(", ")})`);
  }
  if (!value) die(`set ${slug} ${field} <value…> — value required`);
  d.fields[field] = value;
  if (field === "status") d.status = value;
  const saved = saveDossier(d);
  setCurrent(slug);
  const miss = missingFields(d, policy);
  if (flags.json) {
    console.log(JSON.stringify({ slug, field, value, path: relative(ROOT, saved), missing: miss.map((f) => f.id) }, null, 2));
    return;
  }
  console.log(`dossier ${slug}: ${field} = ${value}`);
  if (miss.length) console.log(`missing required: ${miss.map((f) => f.id).join(", ")}`);
  else console.log("complete — ready");
}

function cmdReady(slug, flags) {
  const target = resolveSlug(slug);
  if (!target) {
    if (flags.json) {
      console.log(JSON.stringify({ ready: false, slug: null, missing: [] }, null, 2));
    } else {
      console.error(`no dossier — run: ./scripts/gotchibot pstack dossier new <slug> --goal "…"`);
    }
    process.exit(1);
  }
  const d = loadDossier(target);
  const miss = missingFields(d);
  if (miss.length === 0 && d.status !== "ready") {
    d.status = "ready";
    saveDossier(d);
  }
  if (flags.json) {
    console.log(JSON.stringify({ ready: miss.length === 0, slug: target, status: d.status, missing: miss.map((f) => f.id) }, null, 2));
  } else if (miss.length) {
    console.log(`not ready: ${target} — missing ${miss.map((f) => f.id).join(", ")}`);
  } else {
    console.log(`ready: ${target} (status=${d.status})`);
  }
  process.exit(miss.length ? 1 : 0);
}

function cmdList(flags) {
  const slugs = listPrograms().filter((s) => existsSync(dossierPath(s)));
  if (flags.json) {
    console.log(JSON.stringify({ dossiers: slugs }, null, 2));
    return;
  }
  if (!slugs.length) {
    console.log("no dossiers");
    return;
  }
  const cur = currentSlug();
  for (const s of slugs) {
    const d = loadDossier(s);
    const miss = missingFields(d);
    const mark = miss.length ? "!" : "✓";
    const star = s === cur ? "*" : " ";
    console.log(`${star}${mark} ${s} · ${d?.status || "?"} · ${d?.fields?.goal || "(no goal)"}`);
  }
  console.log("");
  console.log("* = pane current · ✓ complete · ! missing required fields");
}

function cmdFields(flags) {
  const policy = loadPolicy();
  if (flags.json) {
    console.log(JSON.stringify(policy, null, 2));
    return;
  }
  for (const f of policy.fields || []) {
    console.log(`${f.id}\t${f.required ? "required" : "optional"}\t${f.prompt}`);
  }
}

function cmdCurrent(slug, flags) {
  if (slug) {
    if (!slugOk(slug)) die(`invalid slug: ${slug}`);
    if (!existsSync(dossierPath(slug))) die(`no dossier: ${slug}`);
    setCurrent(slug);
    console.log(`current: ${slug}`);
    return;
  }
  const cur = currentSlug();
  if (flags.json) {
    console.log(JSON.stringify({ current: cur }, null, 2));
    return;
  }
  console.log(cur || "(none)");
}

function usage() {
  console.log(`usage:
  pstack-dossier new <slug> [--title "…"] [--goal "…"] [--playbook <label>] [--scope "…"]
      [--context "…"] [--acceptance "…"] [--verify "…"] [--forbidden "…"] [--done "…"]
      [--timebox "…"] [--units "…"] [--principles "…"] [--approaches "…"] [--host auto]
      [--report "…"] [--notes "…"] [--force]
  pstack-dossier show [<slug>] [--json]
  pstack-dossier set <slug> <field> <value…>
  pstack-dossier ready <slug> [--json]
  pstack-dossier list [--json]
  pstack-dossier fields [--json]
  pstack-dossier current [<slug>]

SoT: sessions/pstack/<slug>/dossier.json
Policy: config/pstack-dossier-policy.json
Window: scripts/pstack-window.mjs (tmux work.2 while mode=pstack-dossier)
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    usage();
    process.exit(argv.length ? 0 : 2);
  }
  const cmd = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (cmd) {
    case "new": {
      const slug = positional[0];
      if (!slug) die("new requires <slug>");
      cmdNew(slug, flags);
      break;
    }
    case "show":
      cmdShow(positional[0], flags);
      break;
    case "set": {
      const slug = positional[0];
      const field = positional[1];
      if (!slug || !field) die("set requires <slug> <field> <value…>");
      cmdSet(slug, field, positional.slice(2).join(" "), flags);
      break;
    }
    case "ready":
      cmdReady(positional[0], flags);
      break;
    case "list":
      cmdList(flags);
      break;
    case "fields":
      cmdFields(flags);
      break;
    case "current":
      cmdCurrent(positional[0], flags);
      break;
    default:
      die(`unknown command: ${cmd}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { dossierPath, loadDossier, currentSlug, setCurrent };