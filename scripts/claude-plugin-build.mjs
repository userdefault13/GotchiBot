#!/usr/bin/env node
/**
 * Package the Claude-side layer (.claude/) as an installable Claude Code plugin
 * so the iMac orchestrator gets the identical setup instead of drifting.
 *
 *   node scripts/claude-plugin-build.mjs [--check] [--json]
 *
 * .claude/ stays the source of truth — this generates, never hand-edit the
 * output:
 *
 *   plugins/gotchibot-claude/.claude-plugin/plugin.json
 *   plugins/gotchibot-claude/{agents,commands,hooks}/…
 *   plugins/gotchibot-claude/hooks/hooks.json     (from .claude/settings.json)
 *   .claude-plugin/marketplace.json               (repo = a one-plugin marketplace)
 *
 * Install on the other machine:
 *   /plugin marketplace add <path-to-GotchiBot>
 *   /plugin install gotchibot-claude@gotchibot
 *
 * --check verifies the committed output matches .claude/ and exits non-zero if
 * it drifted, so a stale plugin cannot ship quietly.
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = `${ROOT}/.claude`;
const PLUGIN_NAME = "gotchibot-claude";
const MARKETPLACE_NAME = "gotchibot";
const OUT = `${ROOT}/plugins/${PLUGIN_NAME}`;
const MARKETPLACE = `${ROOT}/.claude-plugin/marketplace.json`;
/** Hook paths inside a plugin resolve against the plugin root, not the repo. */
const PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const PROJECT_DIR_VAR = "${CLAUDE_PROJECT_DIR:-.}";

function version() {
  try {
    return JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function listFiles(dir, filter = () => true) {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .filter((n) => statSync(join(dir, n)).isFile())
      .filter(filter)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Rewrite the hook commands from settings.json (project-relative) to
 * plugin-relative. Everything else about the hook block is carried over as-is.
 */
function hooksForPlugin() {
  const settings = JSON.parse(readFileSync(`${SRC}/settings.json`, "utf8"));
  const hooks = JSON.parse(JSON.stringify(settings.hooks || {}));
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === "string") {
          hook.command = hook.command.split(`"${PROJECT_DIR_VAR}/.claude/`).join(`"${PLUGIN_ROOT_VAR}/`);
        }
      }
    }
  }
  return hooks;
}

/** Everything the plugin ships, as path → contents. Pure: no writes. */
export function buildArtifacts() {
  const files = new Map();
  const v = version();

  files.set(`${OUT}/.claude-plugin/plugin.json`, `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: v,
      description:
        "GotchiBot's Claude Code layer: hooks that enforce the AGENTS.md hard rules (no autonomous installs, no writes outside the tree, syntax-gated script edits), the desk-state session brief, the meeting/passoff/mesh commands, and the gotchibot subagents.",
      author: { name: "userdefault13" },
      keywords: ["gotchibot", "aavegotchi", "orchestration", "hooks"],
    },
    null,
    2,
  )}\n`);

  for (const name of listFiles(`${SRC}/agents`, (n) => n.endsWith(".md"))) {
    files.set(`${OUT}/agents/${name}`, readFileSync(`${SRC}/agents/${name}`, "utf8"));
  }
  for (const name of listFiles(`${SRC}/commands`, (n) => n.endsWith(".md"))) {
    files.set(`${OUT}/commands/${name}`, readFileSync(`${SRC}/commands/${name}`, "utf8"));
  }
  for (const name of listFiles(`${SRC}/hooks`, (n) => n.endsWith(".mjs"))) {
    files.set(`${OUT}/hooks/${name}`, readFileSync(`${SRC}/hooks/${name}`, "utf8"));
  }
  files.set(`${OUT}/hooks/hooks.json`, `${JSON.stringify({ hooks: hooksForPlugin() }, null, 2)}\n`);

  files.set(`${OUT}/README.md`, [
    `# ${PLUGIN_NAME}`,
    "",
    "**Generated — do not edit.** Source of truth is `.claude/` in the GotchiBot repo;",
    "regenerate with `./scripts/gotchibot claude-plugin build`.",
    "",
    "## Install on another machine",
    "",
    "```",
    "/plugin marketplace add /path/to/GotchiBot",
    `/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    "```",
    "",
    "The hooks need a GotchiBot checkout to act on: they resolve it from",
    "`CLAUDE_PROJECT_DIR`, else by walking up from the working directory looking for",
    "`scripts/gotchibot`. Outside a checkout the write guard denies nothing it should",
    "not — it simply has no repo to protect.",
    "",
  ].join("\n"));

  files.set(MARKETPLACE, `${JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      owner: { name: "userdefault13" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: `./plugins/${PLUGIN_NAME}`,
          description: "GotchiBot Claude Code layer — enforcement hooks, desk commands, subagents.",
          version: v,
        },
      ],
    },
    null,
    2,
  )}\n`);

  return files;
}

function write(files) {
  rmSync(OUT, { recursive: true, force: true });
  for (const [path, body] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function drift(files) {
  const out = [];
  for (const [path, body] of files) {
    if (!existsSync(path)) out.push(`missing: ${path.replace(`${ROOT}/`, "")}`);
    else if (readFileSync(path, "utf8") !== body) out.push(`stale: ${path.replace(`${ROOT}/`, "")}`);
  }
  // Files in the output that the build no longer produces.
  const walk = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!files.has(p)) out.push(`orphan: ${p.replace(`${ROOT}/`, "")}`);
    }
  };
  walk(OUT);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const files = buildArtifacts();

  if (args.includes("--check")) {
    const problems = drift(files);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok: !problems.length, problems }, null, 2));
    } else if (problems.length) {
      console.error(`claude plugin is out of date (${problems.length}):`);
      for (const p of problems) console.error(`  ${p}`);
      console.error("rebuild: ./scripts/gotchibot claude-plugin build");
    } else {
      console.log(`claude plugin up to date (${files.size} files)`);
    }
    process.exit(problems.length ? 1 : 0);
  }

  write(files);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, files: [...files.keys()].map((p) => p.replace(`${ROOT}/`, "")) }, null, 2));
    return;
  }
  console.log(`built ${PLUGIN_NAME} v${version()} — ${files.size} files`);
  for (const p of files.keys()) console.log(`  ${p.replace(`${ROOT}/`, "")}`);
  console.log("");
  console.log("install elsewhere:");
  console.log(`  /plugin marketplace add ${ROOT}`);
  console.log(`  /plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
