#!/usr/bin/env node
/**
 * ensure-local-config.mjs — seed local config from `.example` files.
 *
 * Creates ONLY missing files; never overwrites live configs.
 *
 *   import { ensureLocalConfig } from "./ensure-local-config.mjs";
 *   const { created, skipped, hubHostSet } = ensureLocalConfig(ROOT);
 *
 * Seeds:
 *   1. config/hub-bridge.json        ← hub-bridge.json.example
 *        host set from first of GOTCHIBOT_HUB_HOST / REMOTE_HOST /
 *        GOTCHIBOT_REMOTE_HOST, else left as YOUR-HUB-HOSTNAME (solo ok).
 *   2. config/aseprite.json          ← aseprite.json.example
 *   3. config/openclaw.install.json5 ← openclaw.install.json5.example
 *        literal `ROOT/` path segments replaced with the absolute root.
 *   4. sessions/                     mkdir -p
 *
 * CLI:
 *   node scripts/ensure-local-config.mjs [--quiet] [--json] [--self-test]
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HUB_HOST_ENVS = ["GOTCHIBOT_HUB_HOST", "REMOTE_HOST", "GOTCHIBOT_REMOTE_HOST"];

/* ─── per-file seeders (each returns { action: "created"|"skipped", ... }) ─── */

function seedHubBridge(root) {
  const dst = join(root, "config", "hub-bridge.json");
  const src = join(root, "config", "hub-bridge.json.example");
  if (existsSync(dst) || !existsSync(src)) return { action: "skipped" };
  const cfg = JSON.parse(readFileSync(src, "utf8"));
  const host = HUB_HOST_ENVS.map((e) => process.env[e]).find((v) => v && String(v).trim());
  let hubHostSet = false;
  if (host) {
    cfg.host = String(host).trim();
    hubHostSet = true;
  }
  writeFileSync(dst, `${JSON.stringify(cfg, null, 2)}\n`);
  return { action: "created", hubHostSet };
}

function seedAseprite(root) {
  const dst = join(root, "config", "aseprite.json");
  const src = join(root, "config", "aseprite.json.example");
  if (existsSync(dst) || !existsSync(src)) return { action: "skipped" };
  writeFileSync(dst, readFileSync(src, "utf8"));
  return { action: "created" };
}

function seedOpenclawInstall(root) {
  const dst = join(root, "config", "openclaw.install.json5");
  const src = join(root, "config", "openclaw.install.json5.example");
  if (existsSync(dst) || !existsSync(src)) return { action: "skipped" };
  // Replace literal ROOT/ path segments with the absolute checkout path.
  const content = readFileSync(src, "utf8").replace(/\bROOT\//g, `${root}/`);
  writeFileSync(dst, content);
  return { action: "created" };
}

/* ─── public API ──────────────────────────────────────────────────────────── */

/**
 * Ensure local config files exist, seeding from `.example` when missing.
 * Never overwrites files that already exist.
 *
 * @param {string} [root=ROOT] absolute GotchiBot package/checkout path
 * @param {{ quiet?: boolean }} [opts]
 * @returns {{ created: string[], skipped: string[], hubHostSet: boolean }}
 */
export function ensureLocalConfig(root = ROOT, { quiet = false } = {}) {
  root = resolve(root);
  const created = [];
  const skipped = [];
  let hubHostSet = false;

  const note = (msg) => {
    if (!quiet) console.log(`ensure-local-config: ${msg}`);
  };

  const hub = seedHubBridge(root);
  if (hub.action === "created") {
    created.push(join(root, "config", "hub-bridge.json"));
    hubHostSet = hub.hubHostSet;
    note(`created ${relative(root, join(root, "config", "hub-bridge.json"))}${hub.hubHostSet ? " (host from env)" : ""}`);
  } else {
    skipped.push(join(root, "config", "hub-bridge.json"));
    note(`skipped ${relative(root, join(root, "config", "hub-bridge.json"))} (exists)`);
  }

  const ase = seedAseprite(root);
  if (ase.action === "created") {
    created.push(join(root, "config", "aseprite.json"));
    note(`created ${relative(root, join(root, "config", "aseprite.json"))}`);
  } else {
    skipped.push(join(root, "config", "aseprite.json"));
    note(`skipped ${relative(root, join(root, "config", "aseprite.json"))} (exists)`);
  }

  const oi = seedOpenclawInstall(root);
  if (oi.action === "created") {
    created.push(join(root, "config", "openclaw.install.json5"));
    note(`created ${relative(root, join(root, "config", "openclaw.install.json5"))} (ROOT → ${root})`);
  } else {
    skipped.push(join(root, "config", "openclaw.install.json5"));
    note(`skipped ${relative(root, join(root, "config", "openclaw.install.json5"))} (exists)`);
  }

  mkdirSync(join(root, "sessions"), { recursive: true });
  if (!quiet) note("sessions/ ready");

  return { created, skipped, hubHostSet };
}

/* ─── CLI / self-test ─────────────────────────────────────────────────────── */

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "gotchibot-ensure-"));
  try {
    mkdirSync(join(tmp, "config"), { recursive: true });
    for (const ex of [
      "hub-bridge.json.example",
      "aseprite.json.example",
      "openclaw.install.json5.example",
    ]) {
      writeFileSync(join(tmp, "config", ex), readFileSync(join(ROOT, "config", ex), "utf8"));
    }

    const r = ensureLocalConfig(tmp, { quiet: true });
    const seededInstall = readFileSync(join(tmp, "config", "openclaw.install.json5"), "utf8");
    const checks = [
      ["hub-bridge.json created", r.created.includes(join(tmp, "config", "hub-bridge.json"))],
      ["aseprite.json created", r.created.includes(join(tmp, "config", "aseprite.json"))],
      ["openclaw.install.json5 created", r.created.includes(join(tmp, "config", "openclaw.install.json5"))],
      ["sessions/ exists", existsSync(join(tmp, "sessions"))],
      ["ROOT replaced with absolute root", seededInstall.includes(`${tmp}/config/openclaw.gotchi.json5`)],
      ["no ROOT/ path segments left", !/\bROOT\//.test(seededInstall)],
    ];

    const r2 = ensureLocalConfig(tmp, { quiet: true });
    checks.push([
      "second run is a no-op (all skipped, nothing overwritten)",
      r2.created.length === 0 && r2.skipped.length === 3,
    ]);

    const failed = checks.filter(([, pass]) => !pass);
    if (failed.length) {
      for (const [name] of failed) console.error(`  ✗ ${name}`);
      throw new Error(`self-test failed (${failed.length}/${checks.length} checks)`);
    }
    console.log(`self-test OK (${checks.length}/${checks.length} checks)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return runSelfTest();
  const json = args.includes("--json");
  const quiet = args.includes("--quiet") || json;
  const result = ensureLocalConfig(ROOT, { quiet });
  if (json) console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}