#!/usr/bin/env node
/**
 * Desk receiver (:45679) — check health and start the local script when it is down.
 * Used on GotchiBot desk load. Does not open VS Code or touch the Hub bridge :45678.
 *
 *   node ./scripts/desk-receiver-ensure.mjs [--json]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainModule } from "./is-main.mjs";

export const DESK_RECEIVER_PORT = 45679;
export const DESK_RECEIVER_HEALTH_URL = `http://127.0.0.1:${DESK_RECEIVER_PORT}/health`;

/** Mac desk receiver script. Dev/ is the usual checkout; dev/ is the lowercase fallback. */
export function receiverScriptCandidates(home = process.env.HOME || "") {
  return [
    join(home, "Dev/gotchibot-bridge/mbp-receiver/receiver.js"),
    join(home, "dev/gotchibot-bridge/mbp-receiver/receiver.js"),
  ];
}

export async function checkReceiverHealth(url = DESK_RECEIVER_HEALTH_URL) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function defaultSpawnReceiver(script) {
  const child = spawn(process.execPath, [script], {
    cwd: dirname(script),
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

/**
 * If :45679 /health fails, start mbp-receiver/receiver.js and recheck.
 * @returns {Promise<{ ok: boolean, started: boolean, port: number, script?: string, reason?: string }>}
 */
export async function ensureDeskReceiver({
  check,
  exists = existsSync,
  spawnReceiver = defaultSpawnReceiver,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home = process.env.HOME || "",
  waitMs = 700,
} = {}) {
  const probe = check || (() => checkReceiverHealth());
  if (await probe()) return { ok: true, started: false, port: DESK_RECEIVER_PORT };
  const script = receiverScriptCandidates(home).find((p) => exists(p));
  if (!script) {
    return { ok: false, started: false, port: DESK_RECEIVER_PORT, reason: "script-missing" };
  }
  spawnReceiver(script);
  await sleep(waitMs);
  const ok = await probe();
  return {
    ok,
    started: true,
    port: DESK_RECEIVER_PORT,
    script,
    ...(ok ? {} : { reason: "health-failed" }),
  };
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  const result = await ensureDeskReceiver();
  if (jsonOut) console.log(JSON.stringify(result));
  else if (result.ok && !result.started) console.log(`desk receiver :${DESK_RECEIVER_PORT} up`);
  else if (result.ok) console.log(`desk receiver started (${result.script})`);
  else console.error(`desk receiver :${DESK_RECEIVER_PORT} not reachable${result.reason ? ` (${result.reason})` : ""}`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main();
}
