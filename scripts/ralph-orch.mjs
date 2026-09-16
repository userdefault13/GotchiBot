#!/usr/bin/env node
/**
 * ralph-orch — GotchiBot-native ralph-loop store (Ralph Wiggum technique).
 *
 * Bookkeeping only. Never spawns. The loop is driven by Cursor hooks
 * (.cursor/hooks/ralph-capture.mjs + ralph-stop.mjs) which import the helpers
 * exported here; the chief frames the prompt, workers iterate, hooks feed the
 * same prompt back until the completion promise fires or max iterations hit.
 *
 *   node scripts/ralph-orch.mjs start [--slug s] --prompt "…"
 *                                  [--max-iterations N] [--completion-promise TEXT] [--force]
 *   node scripts/ralph-orch.mjs status [<slug>] [--json]
 *   node scripts/ralph-orch.mjs cancel [<slug>]
 *   node scripts/ralph-orch.mjs list [--json]
 *   node scripts/ralph-orch.mjs bump [<slug>]        (internal — hooks use this)
 *
 * State: sessions/ralph/<slug>/scratchpad.md (upstream frontmatter shape),
 * sessions/ralph/<slug>/done, sessions/ralph/<slug>/status.md,
 * sessions/ralph/ACTIVE (current slug pointer for the hooks).
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RALPH_ROOT = join(ROOT, "sessions", "ralph");
const ACTIVE_PATH = join(RALPH_ROOT, "ACTIVE");

const DEFAULT_MAX_ITERATIONS = 20; // never unlimited on GotchiBot

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  console.log(`usage:
  ralph-orch start [--slug s] --prompt "…" [--max-iterations N] [--completion-promise TEXT] [--force]
  ralph-orch status [<slug>] [--json]
  ralph-orch cancel [<slug>]
  ralph-orch list [--json]
  ralph-orch bump [<slug>]

max-iterations defaults to ${DEFAULT_MAX_ITERATIONS}; 0/unlimited is refused.
Store: sessions/ralph/<slug>/  (scratchpad.md, done, status.md) + sessions/ralph/ACTIVE
`);
}

function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

function slugify(text) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `loop-${Date.now().toString(36)}`;
}

function storeDir(slug) {
  return join(RALPH_ROOT, slug);
}

function scratchpadPath(slug) {
  return join(storeDir(slug), "scratchpad.md");
}

function donePath(slug) {
  return join(storeDir(slug), "done");
}

function activeMarkerPath(slug) {
  return join(storeDir(slug), "active");
}

function statusPath(slug) {
  return join(storeDir(slug), "status.md");
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

/** Current active slug (from sessions/ralph/ACTIVE), or null. */
export function activeSlug(root = RALPH_ROOT) {
  const activePath = join(root, "ACTIVE");
  const raw = readText(activePath, "").trim();
  if (!raw || !slugOk(raw)) return null;
  if (!existsSync(join(root, raw))) return null;
  return raw;
}

/** Parse scratchpad.md → { iteration, max_iterations, completion_promise, prompt }. */
export function readScratchpad(slug) {
  if (!slugOk(slug)) return null;
  const body = readText(scratchpadPath(slug));
  const lines = body.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return null;
  let i = 1;
  const front = {};
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (m) front[m[1]] = m[2].trim();
  }
  const iteration = Number.parseInt(front.iteration, 10);
  const maxIterations = Number.parseInt(front.max_iterations, 10);
  if (!Number.isFinite(iteration) || !Number.isFinite(maxIterations)) return null;
  let promise = front.completion_promise ?? "null";
  if (promise === "null" || promise === "") promise = null;
  else {
    const q = /^"(.*)"$/.exec(promise);
    if (q) promise = q[1];
  }
  const prompt = lines.slice(i + 1).join("\n").trim();
  return { iteration, max_iterations: maxIterations, completion_promise: promise, prompt };
}

/** Write scratchpad.md in the upstream ralph-loop frontmatter shape. */
export function writeScratchpad(slug, data) {
  const promise = data.completion_promise
    ? JSON.stringify(data.completion_promise)
    : "null";
  const body = `---
iteration: ${data.iteration}
max_iterations: ${data.max_iterations}
completion_promise: ${promise}
---

${data.prompt}
`;
  writeText(scratchpadPath(slug), body);
}

/** Increment iteration in scratchpad; returns the new iteration. */
export function bumpIteration(slug) {
  const sp = readScratchpad(slug);
  if (!sp) die(`no ralph scratchpad for ${slug}`);
  const next = sp.iteration + 1;
  writeScratchpad(slug, { ...sp, iteration: next });
  return next;
}

/** Touch the done flag (completion promise matched). */
export function markDone(slug) {
  writeText(donePath(slug), new Date().toISOString() + "\n");
}

/** Clear the loop: ACTIVE pointer, done flag, active marker. Keeps history. */
export function clearActive(slug) {
  if (!slugOk(slug)) return;
  const active = activeSlug();
  if (active === slug) {
    try {
      unlinkSync(ACTIVE_PATH);
    } catch {
      /* already gone */
    }
  }
  for (const p of [donePath(slug), activeMarkerPath(slug)]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

function frontmatterLine(label, value) {
  return `${label}: ${value}`;
}

function regenerateStatus(slug, { done = false, active = false, cancelled = false } = {}) {
  const sp = readScratchpad(slug);
  if (!sp) return null;
  const promiseLine = sp.completion_promise
    ? `Completion promise: "${sp.completion_promise}"`
    : "Completion promise: none (runs to max iterations)";
  const stateLine = cancelled
    ? "State: **cancelled**"
    : done
      ? "State: **done** (promise matched)"
      : active
        ? "State: **active**"
        : "State: finished";
  const promptPreview =
    sp.prompt.length > 200 ? `${sp.prompt.slice(0, 200)}…` : sp.prompt;
  const lines = [
    `# ralph status — ${slug}`,
    "",
    `Updated: ${new Date().toISOString()}`,
    `Iteration: ${sp.iteration} / ${sp.max_iterations}`,
    promiseLine,
    stateLine,
    "",
    "## Prompt",
    "",
    "```text",
    promptPreview,
    "```",
    "",
  ];
  writeText(statusPath(slug), lines.join("\n"));
  return sp;
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

function cmdStart(flags) {
  const prompt = typeof flags.prompt === "string" ? flags.prompt.trim() : "";
  if (!prompt) die("--prompt \"…\" is required");
  const slug = typeof flags.slug === "string" && flags.slug ? flags.slug : slugify(prompt);
  if (!slugOk(slug)) die(`invalid slug: ${slug}`);

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  if (typeof flags["max-iterations"] === "string") {
    maxIterations = Number.parseInt(flags["max-iterations"], 10);
    if (!Number.isFinite(maxIterations) || maxIterations < 1) {
      die("--max-iterations must be a positive integer (never unlimited on GotchiBot)");
    }
  }
  const completionPromise =
    typeof flags["completion-promise"] === "string" && flags["completion-promise"].trim()
      ? flags["completion-promise"].trim()
      : null;

  const other = activeSlug();
  if (other && !flags.force) {
    die(
      `another ralph loop is active: ${other} (run: gotchibot ralph cancel ${other}, or pass --force)`,
    );
  }
  if (other && flags.force) clearActive(other);

  mkdirSync(storeDir(slug), { recursive: true });
  writeScratchpad(slug, {
    iteration: 1,
    max_iterations: maxIterations,
    completion_promise: completionPromise,
    prompt,
  });
  writeText(ACTIVE_PATH, `${slug}\n`);
  writeText(activeMarkerPath(slug), new Date().toISOString() + "\n");
  regenerateStatus(slug, { active: true });

  const rel = relative(ROOT, storeDir(slug));
  console.log(`ralph loop started: ${slug}`);
  console.log(`  store: ${rel}/`);
  console.log(`  iterations: 1 / ${maxIterations}`);
  console.log(
    completionPromise
      ? `  completion promise: "${completionPromise}" (worker outputs <promise>${completionPromise}</promise> when genuinely done)`
      : "  completion promise: none — loop runs to max iterations",
  );
  console.log("  hooks: .cursor/hooks/ralph-capture.mjs + ralph-stop.mjs drive the loop");
  console.log(`  next: delegate the prompt to a worker hero (prefer spare DAI; never LINK/YFI/WBTC)`);
}

function cmdList(flags) {
  mkdirSync(RALPH_ROOT, { recursive: true });
  const active = activeSlug();
  const slugs = existsSync(RALPH_ROOT)
    ? readdirSync(RALPH_ROOT).filter((name) => {
        try {
          return statSync(join(RALPH_ROOT, name)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  if (flags.json) {
    console.log(JSON.stringify({ active, loops: slugs }, null, 2));
    return;
  }
  if (!slugs.length) {
    console.log("no ralph loops");
    return;
  }
  for (const s of slugs) console.log(s === active ? `* ${s} (active)` : `  ${s}`);
}

function cmdStatus(slug, flags) {
  const target = slug || activeSlug();
  if (!target) {
    cmdList(flags);
    return;
  }
  if (!slugOk(target)) die(`invalid slug: ${target}`);
  if (!existsSync(storeDir(target))) die(`no ralph loop: ${target}`);
  const done = existsSync(donePath(target));
  const active = activeSlug() === target;
  const sp = regenerateStatus(target, { done, active });
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          slug: target,
          path: relative(ROOT, storeDir(target)),
          iteration: sp.iteration,
          max_iterations: sp.max_iterations,
          completion_promise: sp.completion_promise,
          done,
          active,
          prompt: sp.prompt,
        },
        null,
        2,
      ),
    );
    return;
  }
  process.stdout.write(readText(statusPath(target)));
}

function cmdCancel(slug) {
  const target = slug || activeSlug();
  if (!target) {
    console.log("no active ralph loop");
    return;
  }
  if (!slugOk(target)) die(`invalid slug: ${target}`);
  if (!existsSync(storeDir(target))) die(`no ralph loop: ${target}`);
  const sp = readScratchpad(target);
  const iteration = sp ? sp.iteration : 0;
  clearActive(target);
  regenerateStatus(target, { cancelled: true });
  console.log(`cancelled ralph loop ${target} (was at iteration ${iteration})`);
}

function cmdBump(slug) {
  const target = slug || activeSlug();
  if (!target) die("no active ralph loop to bump");
  const next = bumpIteration(target);
  console.log(`iteration ${next}`);
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
    case "start":
      cmdStart(flags);
      break;
    case "status":
      cmdStatus(positional[0], flags);
      break;
    case "cancel":
      cmdCancel(positional[0]);
      break;
    case "list":
      cmdList(flags);
      break;
    case "bump":
      cmdBump(positional[0]);
      break;
    default:
      die(`unknown command: ${cmd}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export {
  RALPH_ROOT,
  ACTIVE_PATH,
  DEFAULT_MAX_ITERATIONS,
  slugOk,
  storeDir,
  scratchpadPath,
  donePath,
  activeMarkerPath,
  statusPath,
  frontmatterLine,
};