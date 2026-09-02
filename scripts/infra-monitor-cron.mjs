#!/usr/bin/env node
/**
 * infra-monitor-cron.mjs
 *
 * Home-stack infra monitor. Runs on the iMac (where Docker, :8787, and
 * cloudflared live) and checks three things every tick:
 *
 *   1. Docker containers  — any whose status is not "Up" (exited / restarting /
 *                           unhealthy) are flagged.
 *   2. Local subgraph     — curl http://127.0.0.1:8787 (graphql-proxy).
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
 *   INFRA_LOG_DIR        where to write the markdown summary
 *                       (default <repo>/sessions/infra-logs)
 *   INFRA_SUBGRAPH_URL   local :8787 subgraph POST target
 *                       (default http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base)
 *
 * Allowed commands only: docker, curl, scripts/*.mjs, abra run gotchibot -- *.
 * No arbitrary web curl, no Blockscout.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = process.env.INFRA_LOG_DIR || `${ROOT}/sessions/infra-logs`;
const SUBGRAPH_URL =
  process.env.INFRA_SUBGRAPH_URL ||
  "http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base";
const asJson = process.argv.includes("--json");

// Augmented PATH so docker and curl resolve under cron / abra run, where the
// default PATH is minimal. Uses system docker (no OrbStack dependency).
const HOME = process.env.HOME || "/Users/juliuswong";
const EXTRA_PATH = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${HOME}/.nvm/versions/node/current/bin`,
].join(":");
const ENV = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ""}` };

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

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

// --- 1. Docker ---------------------------------------------------------------
function checkDocker() {
  const r = run("docker", ["ps", "-a", "--format", "{{.Names}}|{{.Status}}"]);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      available: false,
      error: r.error || `docker ps exited ${r.status}`,
      containers: [],
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
      return { name, status, healthy };
    });
  const ok = containers.length > 0 && containers.every((c) => c.healthy);
  return { ok, available: true, error: null, containers };
}

// --- 2. Local subgraph :8787 ------------------------------------------------
function checkSubgraphLocal() {
  const r = run("curl", [
    "-sS",
    "-m",
    "8",
    "-X",
    "POST",
    SUBGRAPH_URL,
    "-H",
    "Content-Type: application/json",
    "-d",
    '{"query":"{ _meta { block { number } } }"}',
  ]);
  if (r.error || r.status !== 0) {
    return { ok: false, error: r.error || `curl exited ${r.status}`, block: null, raw: r.stderr || "" };
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
  return { ok: block != null && !parseError, block, error: parseError, raw: r.stdout.slice(0, 200) };
}

// --- 3. Tunnel (public gateway) ---------------------------------------------
function checkTunnel() {
  const r = run(process.execPath, [`${ROOT}/scripts/tunnel-health.mjs`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return { ok: r.status === 0, detail: out || "(no output)", exit: r.status };
}

// --- Report -----------------------------------------------------------------
function buildReport(docker, subgraph, tunnel) {
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
    lines.push("| Container | Status | Health |");
    lines.push("|-----------|--------|--------|");
    for (const c of docker.containers) {
      const tag = c.healthy ? "✅" : "❌";
      lines.push(`| \`${c.name}\` | ${c.status} | ${tag} |`);
    }
  }
  lines.push("");

  lines.push("## Subgraph :8787 (local)", "");
  lines.push(`- status: ${subgraph.ok ? "✅ ok" : "❌ FAIL"}`);
  if (subgraph.block != null) lines.push(`- block: ${subgraph.block}`);
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

function main() {
  const docker = checkDocker();
  const subgraph = checkSubgraphLocal();
  const tunnel = checkTunnel();
  const { overall, md } = buildReport(docker, subgraph, tunnel);

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = `${LOG_DIR}/infra-check-${stamp}.md`;
  writeFileSync(logPath, md, "utf8");

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          overall,
          docker: {
            ok: docker.ok,
            available: docker.available,
            count: docker.containers.length,
            containers: docker.containers,
            error: docker.error,
          },
          subgraph: { ok: subgraph.ok, block: subgraph.block, error: subgraph.error || null },
          tunnel: { ok: tunnel.ok, exit: tunnel.exit },
          log: logPath,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(md);
    console.error(`[infra-monitor] wrote ${logPath}`);
    console.error(`[infra-monitor] overall: ${overall ? "OK" : "DEGRADED"}`);
  }

  process.exit(overall ? 0 : 1);
}

main();
