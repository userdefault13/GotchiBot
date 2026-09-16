#!/usr/bin/env node
/**
 * pstack-orch — GotchiBot-native program store for pstack chief + hero workers.
 *
 * Bookkeeping only. Never spawns. Spawn stays on gotchi-orchestrate.mjs;
 * briefs are pasted into that spawn prompt by the chief.
 *
 *   node scripts/pstack-orch.mjs init <slug> [--goal "…"] [--force]
 *   node scripts/pstack-orch.mjs status [<slug>] [--json]
 *   node scripts/pstack-orch.mjs unit add <slug> --role <role> [--hero id] [--brief path] [--id u1]
 *   node scripts/pstack-orch.mjs unit set <slug> <unitId> [--state s] [--hero id] [--session id] [--brief path]
 *   node scripts/pstack-orch.mjs ledger record <slug> --unit <id> --verdict <v> [--evidence path] [--note "…"]
 *   node scripts/pstack-orch.mjs decision <slug> --phase <p> --decision <d> [--reason "…"] [--evidence "…"] [--result "…"]
 *   node scripts/pstack-orch.mjs brief <slug> --role <role> --playbook <label> --goal "…" --verify "…"
 *                                 [--scope "…"] [--context "…"] [--acceptance "…"] [--timebox "…"]
 *                                 [--forbidden "…"] [--approach A] [--unit u1] [--print-only]
 *   node scripts/pstack-orch.mjs roles [--json]
 *   node scripts/pstack-orch.mjs list [--json]
 *   node scripts/pstack-orch.mjs dossier <args…>   # forward to pstack-dossier.mjs
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const ROLES_PATH = join(ROOT, "config", "pstack-roles.json");

const UNIT_HEADER = "id\trole\thero\tstate\tsession\tbrief\tupdatedAt\n";
const LEDGER_HEADER = "ts\tunit\tverdict\tevidence\tnote\n";
const DECISIONS_HEADER = "ts\tphase\tdecision\treason\tevidence\tresult\n";

const VALID_ROLES = new Set([
  "worker",
  "verifier",
  "how-explorer",
  "why-investigator",
  "arena-runner",
  "coordinator",
]);

const VALID_STATES = new Set([
  "planned",
  "spawned",
  "running",
  "done",
  "failed",
  "abandoned",
  "needs-verify",
]);

const VALID_VERDICTS = new Set([
  "live-verified",
  "unit-test-verified",
  "cli-verified",
  "type-check-only",
  "self-reported",
  "verifier-blocked",
  "verifier-failed",
]);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  console.log(`usage:
  pstack-orch init <slug> [--goal "…"] [--force]
  pstack-orch status [<slug>] [--json]
  pstack-orch list [--json]
  pstack-orch roles [--json]
  pstack-orch unit add <slug> --role <role> [--hero id] [--brief path] [--id uN]
  pstack-orch unit set <slug> <unitId> [--state s] [--hero id] [--session id] [--brief path]
  pstack-orch ledger record <slug> --unit <id> --verdict <v> [--evidence path] [--note "…"]
  pstack-orch decision <slug> --phase <p> --decision <d> [--reason "…"] [--evidence "…"] [--result "…"]
  pstack-orch brief <slug> --role <role> --playbook <label> --goal "…" --verify "…"
                   [--scope "…"] [--context "…"] [--acceptance "…"] [--timebox "…"]
                   [--forbidden "…"] [--approach A] [--unit uN] [--print-only]

Roles: ${[...VALID_ROLES].join(", ")}
States: ${[...VALID_STATES].join(", ")}
Verdicts: ${[...VALID_VERDICTS].join(", ")}
Store: sessions/pstack/<slug>/
`);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path, fallback = "") {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function writeText(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

function storeDir(slug) {
  return join(PSTACK_ROOT, slug);
}

function loadRoles() {
  const cfg = readJson(ROLES_PATH);
  if (!cfg) die(`missing roles config: ${ROLES_PATH}`);
  return cfg;
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

function parseTsv(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i] ?? "";
    return obj;
  });
  return { header, rows };
}

function formatTsv(headerLine, rows) {
  const keyList = headerLine.trim().split("\t");
  const head = keyList.join("\t");
  const body = rows
    .map((r) => keyList.map((k) => String(r[k] ?? "").replace(/\t|\n/g, " ")).join("\t"))
    .join("\n");
  return body ? `${head}\n${body}\n` : `${head}\n`;
}

function ensureStore(slug, { create = false } = {}) {
  if (!slugOk(slug)) die(`invalid slug: ${slug}`);
  const dir = storeDir(slug);
  if (!existsSync(dir)) {
    if (!create) die(`no pstack program: ${slug} (run: pstack-orch init ${slug})`);
    return null;
  }
  return dir;
}

function defaultPreferences(goal) {
  const lines = [
    "# Standing orders (paste into every spawn / resume)",
    "1. Obey GotchiBot Charter: no autonomous installs, no secrets in chat or output.md.",
    "2. Stay inside the repo tree unless the brief SCOPE says otherwise.",
    "3. Never steal LINK/YFI/WBTC standing desks; you are a pstack unit hero.",
    "4. Write the deliverable to sessions/<id>/output.md; evidence belongs there.",
    "5. VERIFY against the real artifact named in the brief — compiles-only is not done.",
    "6. Do not rebase, force-push, or expand scope past FORBIDDEN.",
    "7. On TIMEBOX expiry, return partial findings and stop.",
  ];
  if (goal) lines.push(`8. Program goal: ${goal}`);
  return `${lines.join("\n")}\n`;
}

function regenerateStatus(dir, slug) {
  const units = parseTsv(readText(join(dir, "units.tsv"), UNIT_HEADER));
  const ledger = parseTsv(readText(join(dir, "ledger.tsv"), LEDGER_HEADER));
  const counts = {};
  for (const r of units.rows) {
    const s = r.state || "unknown";
    counts[s] = (counts[s] || 0) + 1;
  }
  const countLine = Object.keys(counts).length
    ? Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "none";
  const recentLedger = ledger.rows.slice(-5);
  const lines = [
    `# pstack status — ${slug}`,
    "",
    `Updated: ${new Date().toISOString()}`,
    `Units: ${units.rows.length} (${countLine})`,
    `Ledger rows: ${ledger.rows.length}`,
    "",
    "## Units",
    "",
  ];
  if (!units.rows.length) {
    lines.push("_none_");
  } else {
    for (const u of units.rows) {
      lines.push(
        `- \`${u.id}\` · ${u.role} · hero=${u.hero || "—"} · ${u.state}` +
          (u.session ? ` · session=${u.session}` : ""),
      );
    }
  }
  lines.push("", "## Recent ledger", "");
  if (!recentLedger.length) {
    lines.push("_none_");
  } else {
    for (const r of recentLedger) {
      lines.push(`- ${r.ts} · ${r.unit} · **${r.verdict}**` + (r.note ? ` — ${r.note}` : ""));
    }
  }
  lines.push("");
  writeText(join(dir, "status.md"), lines.join("\n"));
  return { units: units.rows, ledger: ledger.rows, counts };
}

function cmdInit(slug, flags) {
  if (!slugOk(slug)) die(`invalid slug: ${slug}`);
  const dir = storeDir(slug);
  if (existsSync(dir) && !flags.force) {
    die(`already exists: sessions/pstack/${slug} (pass --force to re-seed files)`);
  }
  mkdirSync(join(dir, "briefs"), { recursive: true });
  const goal = typeof flags.goal === "string" ? flags.goal : "";
  if (!existsSync(join(dir, "preferences.md")) || flags.force) {
    writeText(join(dir, "preferences.md"), defaultPreferences(goal));
  }
  if (!existsSync(join(dir, "units.tsv")) || flags.force) {
    writeText(join(dir, "units.tsv"), UNIT_HEADER);
  }
  if (!existsSync(join(dir, "ledger.tsv")) || flags.force) {
    writeText(join(dir, "ledger.tsv"), LEDGER_HEADER);
  }
  if (!existsSync(join(dir, "decisions.tsv")) || flags.force) {
    writeText(join(dir, "decisions.tsv"), DECISIONS_HEADER);
  }
  if (goal) {
    writeText(
      join(dir, "overview.md"),
      `# ${slug}\n\nGoal: ${goal}\n\nStarted: ${new Date().toISOString()}\n`,
    );
  } else if (!existsSync(join(dir, "overview.md"))) {
    writeText(
      join(dir, "overview.md"),
      `# ${slug}\n\nStarted: ${new Date().toISOString()}\n`,
    );
  }
  regenerateStatus(dir, slug);
  const rel = relative(ROOT, dir);
  console.log(`initialized ${rel}`);
  console.log(`preferences: ${rel}/preferences.md`);
  console.log(`next: pstack-orch brief ${slug} --role worker --playbook Investigation --goal "…" --verify "…"`);
}

function cmdList(flags) {
  mkdirSync(PSTACK_ROOT, { recursive: true });
  const slugs = existsSync(PSTACK_ROOT)
    ? readdirSync(PSTACK_ROOT).filter((name) => {
        try {
          return statSync(join(PSTACK_ROOT, name)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  if (flags.json) {
    console.log(JSON.stringify({ programs: slugs }, null, 2));
    return;
  }
  if (!slugs.length) {
    console.log("no pstack programs");
    return;
  }
  for (const s of slugs) console.log(s);
}

function cmdRoles(flags) {
  const cfg = loadRoles();
  if (flags.json) {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  console.log(`coordinator: ${cfg.coordinator.heroId} (${cfg.coordinator.modelHint})`);
  console.log(`protected: ${(cfg.protectedHeroIds || []).join(", ")}`);
  for (const [name, role] of Object.entries(cfg.roles || {})) {
    const prefer = (role.preferHeroIds || []).join(", ") || "—";
    console.log(
      `${name}: model=${role.spawnModel || role.modelHint} prefer=[${prefer}]` +
        (role.readOnly ? " read-only" : "") +
        (role.differentFrom ? ` ≠${role.differentFrom}` : ""),
    );
  }
}

function cmdStatus(slug, flags) {
  if (!slug) {
    cmdList(flags);
    return;
  }
  const dir = ensureStore(slug);
  const snap = regenerateStatus(dir, slug);
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          slug,
          path: relative(ROOT, dir),
          counts: snap.counts,
          units: snap.units,
          ledger: snap.ledger,
        },
        null,
        2,
      ),
    );
    return;
  }
  process.stdout.write(readText(join(dir, "status.md")));
}

function nextUnitId(rows) {
  let max = 0;
  for (const r of rows) {
    const m = /^u(\d+)$/i.exec(r.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `u${max + 1}`;
}

function cmdUnitAdd(slug, flags) {
  const dir = ensureStore(slug);
  const role = flags.role;
  if (!role || !VALID_ROLES.has(role)) {
    die(`--role required (${[...VALID_ROLES].join("|")})`);
  }
  if (role === "coordinator") {
    die("coordinator is owned-954 — do not add coordinator units");
  }
  const roles = loadRoles();
  const protectedIds = new Set(roles.protectedHeroIds || []);
  const hero = typeof flags.hero === "string" ? flags.hero : "";
  if (hero && protectedIds.has(hero)) {
    die(`hero ${hero} is a protected standing desk — pick an available spare`);
  }
  const parsed = parseTsv(readText(join(dir, "units.tsv"), UNIT_HEADER));
  const id = typeof flags.id === "string" ? flags.id : nextUnitId(parsed.rows);
  if (parsed.rows.some((r) => r.id === id)) die(`unit already exists: ${id}`);
  const brief = typeof flags.brief === "string" ? flags.brief : "";
  const row = {
    id,
    role,
    hero,
    state: "planned",
    session: "",
    brief,
    updatedAt: new Date().toISOString(),
  };
  parsed.rows.push(row);
  writeText(join(dir, "units.tsv"), formatTsv(UNIT_HEADER, parsed.rows));
  regenerateStatus(dir, slug);
  if (flags.json) {
    console.log(JSON.stringify(row, null, 2));
  } else {
    console.log(`unit add ${slug}/${id} role=${role}` + (hero ? ` hero=${hero}` : ""));
  }
}

function cmdUnitSet(slug, unitId, flags) {
  const dir = ensureStore(slug);
  const parsed = parseTsv(readText(join(dir, "units.tsv"), UNIT_HEADER));
  const row = parsed.rows.find((r) => r.id === unitId);
  if (!row) die(`unknown unit: ${unitId}`);
  if (typeof flags.state === "string") {
    if (!VALID_STATES.has(flags.state)) die(`invalid state: ${flags.state}`);
    row.state = flags.state;
  }
  if (typeof flags.hero === "string") {
    const roles = loadRoles();
    if ((roles.protectedHeroIds || []).includes(flags.hero)) {
      die(`hero ${flags.hero} is a protected standing desk`);
    }
    row.hero = flags.hero;
  }
  if (typeof flags.session === "string") row.session = flags.session;
  if (typeof flags.brief === "string") row.brief = flags.brief;
  row.updatedAt = new Date().toISOString();
  writeText(join(dir, "units.tsv"), formatTsv(UNIT_HEADER, parsed.rows));
  regenerateStatus(dir, slug);
  if (flags.json) console.log(JSON.stringify(row, null, 2));
  else console.log(`unit set ${slug}/${unitId} state=${row.state} hero=${row.hero || "—"} session=${row.session || "—"}`);
}

function cmdLedgerRecord(slug, flags) {
  const dir = ensureStore(slug);
  const unit = flags.unit;
  const verdict = flags.verdict;
  if (!unit) die("--unit required");
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    die(`--verdict required (${[...VALID_VERDICTS].join("|")})`);
  }
  const parsed = parseTsv(readText(join(dir, "units.tsv"), UNIT_HEADER));
  if (!parsed.rows.some((r) => r.id === unit)) die(`unknown unit: ${unit}`);
  const row = {
    ts: new Date().toISOString(),
    unit,
    verdict,
    evidence: typeof flags.evidence === "string" ? flags.evidence : "",
    note: typeof flags.note === "string" ? flags.note : "",
  };
  const ledger = parseTsv(readText(join(dir, "ledger.tsv"), LEDGER_HEADER));
  ledger.rows.push(row);
  writeText(join(dir, "ledger.tsv"), formatTsv(LEDGER_HEADER, ledger.rows));
  regenerateStatus(dir, slug);
  if (flags.json) console.log(JSON.stringify(row, null, 2));
  else console.log(`ledger ${slug}/${unit} ${verdict}`);
}

function cmdDecision(slug, flags) {
  const dir = ensureStore(slug);
  const phase = flags.phase;
  const decision = flags.decision;
  if (!phase || typeof phase !== "string") die("--phase required");
  if (!decision || typeof decision !== "string") die("--decision required");
  const row = {
    ts: new Date().toISOString(),
    phase,
    decision,
    reason: typeof flags.reason === "string" ? flags.reason : "",
    evidence: typeof flags.evidence === "string" ? flags.evidence : "",
    result: typeof flags.result === "string" ? flags.result : "",
  };
  const parsed = parseTsv(readText(join(dir, "decisions.tsv"), DECISIONS_HEADER));
  parsed.rows.push(row);
  writeText(join(dir, "decisions.tsv"), formatTsv(DECISIONS_HEADER, parsed.rows));
  if (flags.json) console.log(JSON.stringify(row, null, 2));
  else console.log(`decision ${slug}: [${phase}] ${decision}`);
}

function roleModelHint(rolesCfg, role) {
  if (role === "coordinator") return rolesCfg.coordinator?.modelHint || "orch-chat";
  const r = rolesCfg.roles?.[role];
  return r?.spawnModel || r?.modelHint || "sub";
}

function preferHeroLine(rolesCfg, role) {
  const r = rolesCfg.roles?.[role];
  if (!r) return "";
  const ids = r.preferHeroIds || [];
  return ids.length ? ids.join(", ") : "";
}

function cmdBrief(slug, flags) {
  const dir = ensureStore(slug);
  const role = flags.role;
  const playbook = flags.playbook;
  const goal = flags.goal;
  const verify = flags.verify;
  if (!role || !VALID_ROLES.has(role)) die(`--role required (${[...VALID_ROLES].join("|")})`);
  if (role === "coordinator") die("briefs are for hero units, not the coordinator");
  if (!playbook || typeof playbook !== "string") die("--playbook required");
  if (!goal || typeof goal !== "string") die("--goal required");
  if (!verify || typeof verify !== "string") die("--verify required");

  const rolesCfg = loadRoles();
  const standing = readText(join(dir, "preferences.md"), "").trim();
  const scope =
    typeof flags.scope === "string"
      ? flags.scope
      : "Only paths named in this brief; do not edit sessions/pstack bookkeeping.";
  const context = typeof flags.context === "string" ? flags.context : "(none)";
  const acceptance =
    typeof flags.acceptance === "string"
      ? flags.acceptance
      : `- Goal satisfied: ${goal}\n- VERIFY command/surface succeeds with evidence in output.md`;
  const timebox = typeof flags.timebox === "string" ? flags.timebox : "one session; return partial on expiry";
  const forbidden =
    typeof flags.forbidden === "string"
      ? flags.forbidden
      : "no installs; no secrets; no protected desk work; no scope creep past SCOPE";
  const approach = typeof flags.approach === "string" ? flags.approach : "";
  const model = roleModelHint(rolesCfg, role);
  const prefer = preferHeroLine(rolesCfg, role);
  const readOnly = Boolean(rolesCfg.roles?.[role]?.readOnly);

  const unitId =
    typeof flags.unit === "string" ? flags.unit : `brief-${Date.now().toString(36)}`;
  const approachBlock = approach
    ? `\nAPPROACH     ${approach} — pursue only this candidate; do not blend arms\n`
    : "\n";
  const readOnlyBlock = readOnly
    ? "MODE         READ-ONLY — no file edits; report findings only\n"
    : "";

  const body = `Playbook: ${playbook}
ROLE         ${role}
${readOnlyBlock}GOAL         ${goal}
SCOPE        ${scope}
CONTEXT      ${context}
ACCEPTANCE
${acceptance}
VERIFY       ${verify}
TIMEBOX      ${timebox}
FORBIDDEN    ${forbidden}
REPORT       status, paths touched (if any), evidence you ran, deviations, follow-ups
MODEL_HINT   ${model}
PREFER_HERO  ${prefer || "(delegate-pick available spare; never protected desks)"}
${approachBlock}STANDING
${standing || "(no preferences.md — obey Charter)"}
`;

  const briefRel = `briefs/${unitId}.md`;
  const briefPath = join(dir, briefRel);
  if (!flags["print-only"]) {
    writeText(briefPath, body);
    if (/^u\d+$/i.test(unitId)) {
      const parsed = parseTsv(readText(join(dir, "units.tsv"), UNIT_HEADER));
      if (!parsed.rows.some((r) => r.id === unitId)) {
        parsed.rows.push({
          id: unitId,
          role,
          hero: "",
          state: "planned",
          session: "",
          brief: relative(ROOT, briefPath),
          updatedAt: new Date().toISOString(),
        });
        writeText(join(dir, "units.tsv"), formatTsv(UNIT_HEADER, parsed.rows));
      } else {
        const row = parsed.rows.find((r) => r.id === unitId);
        row.brief = relative(ROOT, briefPath);
        row.role = role;
        row.updatedAt = new Date().toISOString();
        writeText(join(dir, "units.tsv"), formatTsv(UNIT_HEADER, parsed.rows));
      }
      regenerateStatus(dir, slug);
    }
  }

  const spawnHint = `GOTCHIBOT_HERO_ID=<available> ./scripts/gotchi-orchestrate.mjs spawn --host auto --model ${model} "$(cat ${relative(ROOT, briefPath)})"`;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          slug,
          unitId,
          role,
          playbook,
          model,
          briefPath: flags["print-only"] ? null : relative(ROOT, briefPath),
          spawnHint: flags["print-only"] ? null : spawnHint,
          body,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!flags["print-only"]) {
    console.error(`wrote ${relative(ROOT, briefPath)}`);
    console.error(`spawn: ${spawnHint}`);
    console.error("--- brief ---");
  }
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
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
    case "init": {
      const slug = positional[0];
      if (!slug) die("init requires <slug>");
      cmdInit(slug, flags);
      break;
    }
    case "list":
      cmdList(flags);
      break;
    case "roles":
      cmdRoles(flags);
      break;
    case "status":
      cmdStatus(positional[0], flags);
      break;
    case "unit": {
      const sub = positional[0];
      const slug = positional[1];
      if (sub === "add") {
        if (!slug) die("unit add requires <slug>");
        cmdUnitAdd(slug, flags);
      } else if (sub === "set") {
        const unitId = positional[2];
        if (!slug || !unitId) die("unit set requires <slug> <unitId>");
        cmdUnitSet(slug, unitId, flags);
      } else {
        die("unit subcommand: add|set");
      }
      break;
    }
    case "ledger": {
      const sub = positional[0];
      const slug = positional[1];
      if (sub !== "record") die("ledger subcommand: record");
      if (!slug) die("ledger record requires <slug>");
      cmdLedgerRecord(slug, flags);
      break;
    }
    case "decision": {
      const slug = positional[0];
      if (!slug) die("decision requires <slug>");
      cmdDecision(slug, flags);
      break;
    }
    case "brief": {
      const slug = positional[0];
      if (!slug) die("brief requires <slug>");
      cmdBrief(slug, flags);
      break;
    }
    case "dossier": {
      // Forward to the dossier SoT CLI (gotchibot pstack dossier routes here too).
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/pstack-dossier.mjs"), ...argv.slice(1)], {
        stdio: "inherit",
      });
      process.exit(r.status ?? 1);
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export {
  loadRoles,
  storeDir,
  PSTACK_ROOT,
  ROLES_PATH,
};
