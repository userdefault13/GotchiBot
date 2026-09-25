#!/usr/bin/env node
/**
 * Hub phone-reply runner CLI.
 *
 * Canonical (injects provider keys):
 *   abra run gotchibot -- node scripts/hub-runner.mjs
 *   abra run gotchibot -- node scripts/hub-runner.mjs --once
 *   abra run gotchibot -- node scripts/hub-runner.mjs --check
 *
 * Also: ./scripts/gotchibot hub runner [--once|--check]
 *
 * Escape hatch (tests / free models only): GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY=1
 */
import { isMainModule } from "./is-main.mjs";
import { resolveApiConfig } from "../services/gotchibot-api/config.mjs";
import { connectStore } from "../services/gotchibot-api/store.mjs";
import {
  createHubRunner,
  preflightChecks,
  resolvePinnedChatModel,
} from "../services/gotchibot-api/runner.mjs";

function usage() {
  console.error(`usage:
  hub-runner.mjs              poll pending phone replies (needs abra env)
  hub-runner.mjs --once       single tick then exit
  hub-runner.mjs --check      preflight only (opencode + key presence; never prints values)`);
}

async function runCheck(env = process.env) {
  const pre = preflightChecks(env);
  const model = resolvePinnedChatModel(env);
  if (pre.opencode) console.log("ok  opencode CLI on PATH");
  else console.log("error  opencode CLI not found on PATH");
  if (pre.keys) {
    console.log(
      env.GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY === "1"
        ? "ok  provider key check skipped (GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY=1)"
        : "ok  provider key present in env",
    );
  } else {
    console.log(
      "error  no provider key in env — run under: abra run gotchibot -- node scripts/hub-runner.mjs",
    );
  }
  if (model) console.log(`ok  pinned chat model: ${model}`);
  else console.log("ok  pinned chat model: (none — will use model-policy chat chain)");
  if (env.GOTCHIBOT_HUB_RUNNER_MODEL) {
    console.log(`ok  hub-runner model override: ${env.GOTCHIBOT_HUB_RUNNER_MODEL}`);
  }
  return pre.ok ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    process.exit(0);
  }
  const once = argv.includes("--once");
  const check = argv.includes("--check");

  if (check) {
    process.exit(await runCheck(process.env));
  }

  const config = resolveApiConfig(process.env);
  const store = await connectStore({
    mongoUri: config.mongoUri,
    dbName: config.dbName,
  });
  await store.ensureIndexes();

  const runner = createHubRunner({
    store,
    runnerId: process.env.GOTCHIBOT_HUB_RUNNER_ID || "hub-runner",
    env: process.env,
  });

  const shutdown = async (code = 0) => {
    try {
      await runner.stop();
    } finally {
      try {
        await store.close();
      } catch {
        /* ignore */
      }
      process.exit(code);
    }
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  if (once) {
    await runner.tick();
    await shutdown(0);
    return;
  }

  runner.start();
  console.log(
    `[hub-runner] listening (db ${config.dbName}) — abra run gotchibot -- node scripts/hub-runner.mjs`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(sanitizeBootError(err));
    process.exit(1);
  });
}

function sanitizeBootError(err) {
  const msg = String(err?.message || err || "error");
  return msg
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://***")
    .replace(/gbd_[A-Za-z0-9_-]+/gi, "gbd_***")
    .slice(0, 300);
}

export { main, runCheck, usage };
