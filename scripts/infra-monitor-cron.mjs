#!/usr/bin/env node
/**
 * infra-monitor-cron.mjs
 *
 * Home-stack infra monitor. Runs on the iMac (where Docker, :8787, and
 * cloudflared live) and checks three things every tick:
 *
 *   1. Docker containers  — only the WATCHED set (the containers that actually
 *                           back the public stack) gates the result. Anything
 *                           else on the machine is reported but informational,
 *                           so an unrelated stopped container cannot page us.
 *   2. Local subgraph     — curl http://127.0.0.1:8787 (graphql-proxy). The
 *                           proxy requires x-subgraph-proxy-key; without it
 *                           every probe comes back 401 Unauthorized.
 *   3. Tunnel             — node scripts/tunnel-health.mjs (public gateway).
 *
 * Writes a markdown summary to sessions/infra-logs/infra-check-<timestamp>.md,
 * prints a short console summary, and exits NON-ZERO if ANY check fails so the
 * wrapping cron job can alert.
 *
 *   node scripts/infra-monitor-cron.mjs
 *   node scripts/infra-monitor-cron.mjs --json
 *
 * Env:
 *   INFRA_LOG_DIR          where to write the markdown summary
 *                          (default <repo>/sessions/infra-logs)
 *   INFRA_SUBGRAPH_URL     local :8787 subgraph POST target
 *                          (default http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base)
 *   INFRA_WATCHED_CONTAINERS
 *                          comma-separated container names that gate the docker
 *                          check (default: the aarcade + envio stack below)
 *   SUBGRAPH_PROXY_SECRET / INFRA_SUBGRAPH_PROXY_KEY
 *                          key sent as x-subgraph-proxy-key
 *   INFRA_SUBGRAPH_ENV_FILE
 *                          .env to read SUBGRAPH_PROXY_SECRET from when it is
 *                          not already in the environment
 *
 * Allowed commands only: docker, curl, scripts/*.mjs, abra run gotchibot -- *.
 * No arbitrary web curl, no Blockscout.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostServiceUrl } from "./lib/host-services.mjs";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = process.env.INFRA_LOG_DIR || `${ROOT}/sessions/infra-logs`;
const SUBGRAPH_URL =
  process.env.INFRA_SUBGRAPH_URL ||
  hostServiceUrl(8787, "/subgraphs/name/aavegotchi-core-base");
const asJson = process.argv.includes("--json");

// Augmented PATH so docker, curl and claude resolve under cron / abra run,
// where the default PATH is minimal. Uses system docker (no OrbStack dependency).
const HOME = process.env.HOME || "/Users/juliuswong";
const EXTRA_PATH = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${HOME}/.local/bin`,
  `${HOME}/.nvm/versions/node/current/bin`,
].join(":");
const ENV = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ""}` };

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// Containers that actually back the public stack. Only these gate the check —
// everything else on the iMac (side projects, scratch databases) is listed for
// context but never fails the run. Previously ANY stopped container anywhere on
// the machine marked infra DEGRADED, which made the alert meaningless.
const DEFAULT_WATCHED = [
  "aarcade-mongo",
  "aarcade-cartridge-sim",
  "aarcade-subgraph-api",
  "aavegotchi-monolith-base-graphql-proxy-1",
  "aarcade-cartridge-base-envio-indexer-1",
  "aarcade-cartridge-base-graphql-engine-1",
  "aarcade-cartridge-base-envio-postgres-1",
  "aavegotchi-monolith-base-envio-indexer-1",
  "aavegotchi-monolith-base-graphql-engine-1",
  "aavegotchi-monolith-base-envio-postgres-1",
  "gotchiverse-base-envio-indexer-1",
  "gotchiverse-base-graphql-engine-1",
  "gotchiverse-base-envio-postgres-1",
];

export const WATCHED_CONTAINERS = (
  process.env.INFRA_WATCHED_CONTAINERS
    ? process.env.INFRA_WATCHED_CONTAINERS.split(",")
    : DEFAULT_WATCHED
)
  .map((s) => s.trim())
  .filter(Boolean);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, env: ENV, ...opts });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// Resolve the subgraph proxy key. The proxy (services/subgraph-api-proxy/
// server.cjs) rejects unauthenticated GraphQL with 401 Unauthorized, so a probe
// without this header reports FAIL no matter how healthy the service is.
function subgraphKey() {
  const fromEnv =
    process.env.INFRA_SUBGRAPH_PROXY_KEY || process.env.SUBGRAPH_PROXY_SECRET;
  if (fromEnv) return { key: fromEnv, source: "env" };

  const envFile =
    process.env.INFRA_SUBGRAPH_ENV_FILE ||
    `${HOME}/Dev/AarcadeGh-t/services/subgraph-api-proxy/.env`;
  if (!existsSync(envFile)) return { key: null, source: null };
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*SUBGRAPH_PROXY_SECRET\s*=\s*(.*)\s*$/);
      if (m) {
        const key = m[1].trim().replace(/^["']|["']$/g, "");
        if (key) return { key, source: envFile };
      }
    }
  } catch {
    /* unreadable .env — fall through to no key */
  }
  return { key: null, source: null };
}

// --- 1. Docker ---------------------------------------------------------------
export function checkDocker() {
  const r = run("docker", ["ps", "-a", "--format", "{{.Names}}|{{.Status}}"]);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      available: false,
      error: r.error || `docker ps exited ${r.status}`,
      containers: [],
      missing: [...WATCHED_CONTAINERS],
    };
  }
  const containers = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("|");
      const name = idx === -1 ? line : line.slice(0, idx);
      const status = idx === -1 ? "" : line.slice(idx + 1);
      const isUp = status.startsWith("Up");
      const unhealthy = /\(unhealthy\)/.test(status);
      const healthy = isUp && !unhealthy;
      const watched = WATCHED_CONTAINERS.includes(name);
      return { name, status, healthy, watched };
    });

  const seen = new Set(containers.map((c) => c.name));
  const missing = WATCHED_CONTAINERS.filter((n) => !seen.has(n));
  const watched = containers.filter((c) => c.watched);
  // A watched container that is unhealthy OR absent entirely is a real failure.
  const ok = missing.length === 0 && watched.length > 0 && watched.every((c) => c.healthy);
  return { ok, available: true, error: null, containers, missing };
}

// --- 2. Local subgraph :8787 ------------------------------------------------
export function checkSubgraphLocal() {
  const { key, source } = subgraphKey();
  const args = [
    "-sS",
    "-m",
    "8",
    "-X",
    "POST",
    SUBGRAPH_URL,
    "-H",
    "Content-Type: application/json",
  ];
  if (key) args.push("-H", `x-subgraph-proxy-key: ${key}`);
  args.push("-d", '{"query":"{ _meta { block { number } } }"}');

  const r = run("curl", args);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: r.error || `curl exited ${r.status}`,
      block: null,
      keyed: Boolean(key),
      keySource: source,
      raw: r.stderr || "",
    };
  }
  let block = null;
  let parseError = null;
  try {
    const body = JSON.parse(r.stdout);
    block = body?.data?._meta?.block?.number ?? null;
    if (body?.errors?.length) parseError = body.errors[0].message;
  } catch {
    parseError = "non-JSON response (tunnel/proxy down?)";
  }
  if (parseError === "Unauthorized" && !key) {
    parseError = "Unauthorized (no SUBGRAPH_PROXY_SECRET found — set it or point INFRA_SUBGRAPH_ENV_FILE at the proxy .env)";
  }
  return {
    ok: block != null && !parseError,
    block,
    error: parseError,
    keyed: Boolean(key),
    keySource: source,
    raw: r.stdout.slice(0, 200),
  };
}

// --- 3. Tunnel (public gateway) ---------------------------------------------
export function checkTunnel() {
  const r = run(process.execPath, [`${ROOT}/scripts/tunnel-health.mjs`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return { ok: r.status === 0, detail: out || "(no output)", exit: r.status };
}

// --- Report -----------------------------------------------------------------
export function buildReport(docker, subgraph, tunnel) {
  const failed = [docker, subgraph, tunnel].filter((c) => !c.ok);
  const overall = failed.length === 0;
  const lines = [];
  lines.push(`# Infra check — ${new Date().toISOString()}`, "");
  lines.push(`**Overall:** ${overall ? "✅ OK" : `❌ DEGRADED (${failed.length} check(s) failing)`}`, "");

  lines.push("## Docker (iMac)", "");
  if (!docker.available) {
    lines.push(`- ❌ docker unavailable: ${docker.error}`);
  } else if (docker.containers.length === 0) {
    lines.push("- (no containers reported)");
  } else {
    if (docker.missing?.length) {
      lines.push(`- ❌ watched container(s) missing: ${docker.missing.map((n) => `\`${n}\``).join(", ")}`, "");
    }
    lines.push("| Container | Status | Watched | Health |");
    lines.push("|-----------|--------|---------|--------|");
    for (const c of docker.containers) {
      const tag = c.healthy ? "✅" : "❌";
      const w = c.watched ? "yes" : "—";
      // Unwatched containers show their real state but never gate the result.
      lines.push(`| \`${c.name}\` | ${c.status} | ${w} | ${c.watched ? tag : `${tag} (ignored)`} |`);
    }
  }
  lines.push("");

  lines.push("## Subgraph :8787 (local)", "");
  lines.push(`- status: ${subgraph.ok ? "✅ ok" : "❌ FAIL"}`);
  if (subgraph.block != null) lines.push(`- block: ${subgraph.block}`);
  lines.push(`- auth: ${subgraph.keyed ? `x-subgraph-proxy-key sent (${subgraph.keySource})` : "NO KEY — probe will 401"}`);
  if (subgraph.error) lines.push(`- error: ${subgraph.error}`);
  lines.push("");

  lines.push("## Tunnel (subgraph.aarcadeghst.com)", "");
  lines.push(`- status: ${tunnel.ok ? "✅ ok" : "❌ DOWN"}`);
  if (tunnel.detail) lines.push("```", tunnel.detail, "```");
  lines.push("");

  lines.push("## Checks", "");
  lines.push(`- docker:   ${docker.ok ? "PASS" : "FAIL"}`);
  lines.push(`- subgraph: ${subgraph.ok ? "PASS" : "FAIL"}`);
  lines.push(`- tunnel:   ${tunnel.ok ? "PASS" : "FAIL"}`);
  lines.push("");
  return { overall, md: lines.join("\n") };
}

// Run all three checks and return a plain result object. Exported so the
// always-on watcher (scripts/infra-watch.mjs) reuses exactly these probes
// instead of drifting into a second, subtly different definition of "healthy".
export function runChecks() {
  const docker = checkDocker();
  const subgraph = checkSubgraphLocal();
  const tunnel = checkTunnel();
  const { overall, md } = buildReport(docker, subgraph, tunnel);
  return { overall, md, docker, subgraph, tunnel };
}

export function summarize({ overall, docker, subgraph, tunnel }, logPath = null) {
  return {
    at: new Date().toISOString(),
    overall,
    docker: {
      ok: docker.ok,
      available: docker.available,
      count: docker.containers.length,
      watched: docker.containers.filter((c) => c.watched).length,
      missing: docker.missing || [],
      containers: docker.containers,
      error: docker.error,
    },
    subgraph: {
      ok: subgraph.ok,
      block: subgraph.block,
      keyed: subgraph.keyed,
      error: subgraph.error || null,
    },
    tunnel: { ok: tunnel.ok, exit: tunnel.exit },
    log: logPath,
  };
}

function main() {
  const result = runChecks();

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = `${LOG_DIR}/infra-check-${stamp}.md`;
  writeFileSync(logPath, result.md, "utf8");

  if (asJson) {
    console.log(JSON.stringify(summarize(result, logPath), null, 2));
  } else {
    console.log(result.md);
    console.error(`[infra-monitor] wrote ${logPath}`);
    console.error(`[infra-monitor] overall: ${result.overall ? "OK" : "DEGRADED"}`);
  }

  process.exit(result.overall ? 0 : 1);
}

// Only run when executed directly — infra-watch.mjs imports the checks above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
