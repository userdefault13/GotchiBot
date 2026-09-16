#!/usr/bin/env node
/**
 * add-dir — session allowlist of extra workspace roots for write-guard.
 *
 *   node scripts/add-dir.mjs <path>
 *   node scripts/add-dir.mjs list
 *   node scripts/add-dir.mjs remove <path>
 *   node scripts/add-dir.mjs clear
 *
 * Store: sessions/.gotchibot-add-dirs.json
 * Bookkeeping only. Never spawns.
 *
 * Note: prefer `remove` over `rm` — bash guard treats `rm /…` as destructive.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = join(ROOT, "sessions", ".gotchibot-add-dirs.json");
const HOME = realpathSync(homedir());

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  console.log(`usage:
  add-dir <path>             add an existing directory to the session allowlist
  add-dir list               show current extra roots
  add-dir remove <path>      remove a root (prefer over rm — bash guard)
  add-dir clear              remove all extra roots

Store: sessions/.gotchibot-add-dirs.json
Write-guard merges these into ALLOWED for Write/Delete.
`);
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function readList() {
  try {
    const raw = JSON.parse(readFileSync(STORE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((p) => String(p)).filter(Boolean))];
  } catch {
    return [];
  }
}

function writeList(list) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/** Refuse overly broad trees Julius did not mean to open. */
function tooBroad(abs) {
  const banned = new Set([
    "/",
    "/Users",
    "/home",
    "/var",
    "/private",
    "/System",
    "/Library",
    "/Applications",
    HOME,
    real(`${HOME}${sep}Library`),
    real(`${HOME}${sep}Downloads`),
    real(`${HOME}${sep}Desktop`),
    real(`${HOME}${sep}Documents`),
  ]);
  if (banned.has(abs)) return true;
  // single-segment under home like ~/foo is ok; bare ~/Dev is ok (project parent)
  return false;
}

function cmdList() {
  const list = readList();
  if (!list.length) {
    console.log("no extra directories (allowlist empty)");
    return;
  }
  for (const p of list) console.log(p);
}

function cmdAdd(raw) {
  if (!raw) die("usage: add-dir <path>");
  const resolved = resolve(process.cwd(), raw);
  if (!existsSync(resolved)) die(`not found: ${resolved}`);
  let st;
  try {
    st = statSync(resolved);
  } catch (e) {
    die(`cannot stat: ${resolved} (${e?.message || e})`);
  }
  if (!st.isDirectory()) die(`not a directory: ${resolved}`);
  const abs = real(resolved);
  if (tooBroad(abs)) {
    die(
      `refused: ${abs} is too broad for /add-dir. Pick a specific project under ~/Dev (or ask Julius).`,
    );
  }
  const list = readList();
  if (list.includes(abs)) {
    console.log(`already listed: ${abs}`);
    return;
  }
  list.push(abs);
  writeList(list);
  console.log(`added: ${abs}`);
  console.log(`write-guard will allow Write/Delete under this root (${list.length} extra).`);
}

function cmdRm(raw) {
  if (!raw) die("usage: add-dir remove <path>");
  const abs = real(resolve(process.cwd(), raw));
  const list = readList();
  const next = list.filter((p) => p !== abs && real(p) !== abs);
  if (next.length === list.length) die(`not in allowlist: ${abs}`);
  writeList(next);
  console.log(`removed: ${abs}`);
}

function cmdClear() {
  writeList([]);
  console.log("cleared add-dir allowlist");
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "list") return cmdList();
  if (cmd === "clear") return cmdClear();
  // Prefer `remove` — `rm /abs` trips install-guard's rm-of-/ detector.
  if (cmd === "remove") return cmdRm(rest[0]);
  if (cmd === "rm") {
    die("use: add-dir remove <path>  (rm trips the install-guard false positive on absolute paths)");
  }
  // bare path
  return cmdAdd(cmd === "add" ? rest[0] : cmd);
}

export { readList, STORE };

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    die(e?.message || String(e));
  }
}
