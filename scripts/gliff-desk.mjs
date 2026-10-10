#!/usr/bin/env node
/**
 * gotchibot gliff <desk> [--headless]
 *
 * Opens a desk by name with gliff (Hyprland-to-Hyprland remote desktop over
 * ssh): resolves the name to user@host from config/desks.json and runs
 * `gliff user@host`. No protocol of our own, no secrets, no ports. gliff is
 * only run on this machine; it is never installed or built from here.
 *
 *   gotchibot gliff omarchymini
 *   gotchibot gliff 2011 --headless
 *   gotchibot gliff someone@host.tailnet.ts.net
 *   gotchibot gliff --list
 *
 * Exit: 0 ok (or gliff's own code), 1 cannot run here, 2 usage / unknown desk.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESKS_FILE = join(ROOT, "config", "desks.json");
const TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

export function loadDesks(path = DESKS_FILE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Lowercase, first DNS label: imacOmarchy and imacomarchy.tail….ts.net are the same desk. */
function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "").split(".")[0];
}

/**
 * name -> { name, target } where target is user@host. Accepts a desk name, an
 * alias, a bare tailnet host or IP of a known desk (with the registry user), or
 * a literal user@host (passed through).
 */
export function resolveDesk(input, registry = loadDesks()) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("no desk given");
  if (raw.includes("@")) {
    if (!TARGET_RE.test(raw)) throw new Error(`not a valid user@host: ${raw}`);
    return { name: raw.split("@")[1], target: raw };
  }
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(raw);
  const want = norm(raw);
  for (const [name, d] of Object.entries(registry.desks || {})) {
    const hit = isIp
      ? String(d.host) === raw
      : [name, ...(d.aliases || []), /^\d+\./.test(d.host) ? "" : d.host].map(norm).includes(want);
    if (hit) return { name, target: `${d.user || registry.user}@${d.host}`, desk: d };
  }
  const known = Object.keys(registry.desks || {}).join(", ");
  throw new Error(`unknown desk "${raw}" (known: ${known}; or pass user@host)`);
}

function onPath(cmd, env = process.env) {
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export const INSTALL_GUIDANCE =
  "gliff is not installed on this machine. On an Omarchy desk run: omarchy pkg add gliff  " +
  "(or re-run scripts/omarchy-desk-install.sh, which does that on eligible desks).";

export function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s));
  const err = deps.err || ((s) => process.stderr.write(s));
  const platform = deps.platform || process.env.GOTCHIBOT_GLIFF_PLATFORM || process.platform;
  const has = deps.has || ((c) => onPath(c));
  const run = deps.run || ((bin, args) => spawnSync(bin, args, { stdio: "inherit" }).status ?? 1);

  const headless = argv.includes("--headless");
  const rest = argv.filter((a) => a !== "--headless");
  if (rest.includes("-h") || rest.includes("--help") || !rest.length) {
    out("usage: gotchibot gliff <desk|user@host> [--headless]\n       gotchibot gliff --list\n");
    out("Open a desk with gliff (Hyprland remote desktop over ssh). Desk names: config/desks.json\n");
    return rest.length ? 0 : 2;
  }
  let registry;
  try {
    registry = deps.registry || loadDesks();
  } catch (e) {
    err(`cannot read desk registry: ${e.message}\n`);
    return 1;
  }
  if (rest.includes("--list")) {
    for (const [name, d] of Object.entries(registry.desks)) {
      out(`${name.padEnd(14)} ${(d.user || registry.user)}@${d.host}${d.role ? `  (${d.role})` : ""}\n`);
    }
    return 0;
  }
  let hit;
  try {
    hit = resolveDesk(rest[0], registry);
  } catch (e) {
    err(`${e.message}\n`);
    return 2;
  }
  if (platform === "darwin") {
    err("gotchibot gliff: the gliff client needs Hyprland, which macOS does not have. Run it from an Omarchy desk.\n");
    return 1;
  }
  if (!has("gliff")) {
    err(`${INSTALL_GUIDANCE}\n`);
    return 1;
  }
  const args = [...(headless ? ["--headless"] : []), hit.target];
  return run("gliff", args);
}

if (isMainModule(import.meta.url)) process.exit(main());
