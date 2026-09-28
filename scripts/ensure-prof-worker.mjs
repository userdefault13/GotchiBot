#!/usr/bin/env node
/**
 * Ensure a request/generic sub is seated by Prof. Link-Cube as pack `worker`
 * (worker template + Prof tool index: config/worker-index.json).
 *
 *   node scripts/ensure-prof-worker.mjs <heroId> [--force] [--json] [--dry-run]
 *
 * Skips: standing desks (LINK/YFI/WBTC), specialized roles (≠ worker),
 * GOTCHIBOT_SKIP_PROF_WORKER=1. Never auto-mints.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROLES_PATH = `${ROOT}/config/agent-roles.json`;

/** Standing desks — never overwrite with generic worker. */
export const STANDING = new Set([
  "starter-link-h1-1", // trader
  "starter-yfi-h1-1", // infra
  "owned-22899", // comms (when not orch pin)
]);

function readRoles() {
  try {
    return JSON.parse(readFileSync(ROLES_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function roleOf(heroId, roles) {
  const row = roles?.[heroId];
  if (!row) return null;
  if (typeof row === "string") return row;
  return row.roleId || row.role || row.packId || null;
}

/**
 * Seat hero as Prof worker pack when this is a request/generic sub.
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, heroId: string, applied?: boolean }}
 */
export function ensureProfWorkerSeat(heroId, { force = false, dryRun = false } = {}) {
  const id = String(heroId || process.env.GOTCHIBOT_HERO_ID || "").trim();
  if (!id) {
    return {
      ok: false,
      heroId: "",
      reason: "hero id required (GOTCHIBOT_HERO_ID or argv)",
    };
  }

  if (process.env.GOTCHIBOT_SKIP_PROF_WORKER === "1" && !force) {
    return { ok: true, skipped: true, heroId: id, reason: "GOTCHIBOT_SKIP_PROF_WORKER=1" };
  }

  if (STANDING.has(id) && !force) {
    return {
      ok: true,
      skipped: true,
      heroId: id,
      reason: "standing desk — leave role; never steal into generic worker",
    };
  }

  const roles = readRoles();
  const current = roleOf(id, roles);
  const explicitRole = String(process.env.GOTCHIBOT_ROLE || "").trim();

  if (explicitRole && explicitRole !== "worker" && !force) {
    return {
      ok: true,
      skipped: true,
      heroId: id,
      reason: `GOTCHIBOT_ROLE=${explicitRole} — not a request worker`,
      role: explicitRole,
    };
  }

  if (current && current !== "worker" && !force) {
    return {
      ok: true,
      skipped: true,
      heroId: id,
      reason: `already seated as ${current} — not overwriting with worker`,
      role: current,
    };
  }

  if (current === "worker" && !force) {
    // Already worker — still refresh skills/workspace if pack apply is cheap? Skip to avoid churn.
    return {
      ok: true,
      skipped: true,
      heroId: id,
      reason: "already worker",
      role: "worker",
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      heroId: id,
      wouldApply: "worker",
      via: "gotchibot templates apply worker --hero … --yes",
    };
  }

  const args = [
    `${ROOT}/scripts/template-pack.mjs`,
    "apply",
    "worker",
    "--hero",
    id,
    "--yes",
  ];
  if (force) args.push("--reassign");
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GOTCHIBOT_AUTO_APPROVE: process.env.GOTCHIBOT_AUTO_APPROVE || "1" },
  });
  if (r.status !== 0) {
    return {
      ok: false,
      heroId: id,
      reason: `Prof worker apply failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    applied: true,
    heroId: id,
    role: "worker",
    toolsIndex: "config/worker-index.json",
    stdout: (r.stdout || "").trim().slice(0, 400),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const hero = args.find((a) => !a.startsWith("--")) || "";
  const r = ensureProfWorkerSeat(hero, { force, dryRun });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.ok) {
    console.error(`ensure-prof-worker: ${r.reason}`);
    process.exit(1);
  } else if (r.skipped) {
    console.log(`ensure-prof-worker: skip ${r.heroId} — ${r.reason}`);
  } else if (r.dryRun) {
    console.log(`ensure-prof-worker: dry-run would apply worker → ${r.heroId}`);
  } else {
    console.log(`ensure-prof-worker: Prof seated worker → ${r.heroId} (tools: ${r.toolsIndex})`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
