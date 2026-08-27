#!/usr/bin/env node
/**
 * gotchibot mesh — cross-machine agent count + status (MBP <-> iMac).
 *
 * Read-only. Reuses the existing Tailscale-SSH scan already used by
 * `gotchibot agents` (agent-focus.mjs scanRemoteSessionsAsync): the MBP
 * orchestrator reads iMac sessions over SSH and the result is cached in
 * sessions/.focus-list.json by buildRoster().
 *
 *   node scripts/mesh-status.mjs                # instant view from cache
 *   node scripts/mesh-status.mjs --live         # re-scan the peer over SSH
 *   node scripts/mesh-status.mjs --json         # machine-readable payload
 *   node scripts/mesh-status.mjs ping           # Tailscale + SSH reachability
 *
 * Secrets stay in env (abra run gotchibot -- …); never logged.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const LIST_CACHE = `${SESSIONS}/.focus-list.json`;
const FOCUS = `${SESSIONS}/.focus.json`;

const STATUS_ORDER = ["running", "working", "active", "done", "failed", "idle", "available"];

function parseArgs(argv) {
  const out = { live: false, json: false, ping: false, help: false };
  for (const a of argv) {
    if (a === "--live") out.live = true;
    else if (a === "--json") out.json = true;
    else if (a === "ping") out.ping = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function refreshCache() {
  // Rebuild .focus-list.json via agent-focus.mjs list (buildRoster -> SSH scan).
  // Degrades gracefully when the iMac is unreachable (remote.ok = false).
  spawnSync(process.execPath, ["scripts/agent-focus.mjs", "list"], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

function readCache() {
  try {
    return JSON.parse(readFileSync(LIST_CACHE, "utf8"));
  } catch {
    return null;
  }
}

function readFocus() {
  try {
    return JSON.parse(readFileSync(FOCUS, "utf8"));
  } catch {
    return null;
  }
}

function groupByHost(cache) {
  const entries = (cache?.entries || []).filter((e) => e.kind === "session");
  const hosts = {
    local: { label: "MBP", total: 0, byStatus: {}, entries: [] },
    imac: {
      label: "iMac",
      total: 0,
      byStatus: {},
      entries: [],
      ok: cache?.remote?.ok !== false,
      reason: cache?.remote?.reason || null,
    },
    cartridge: { heroes: [] },
  };
  for (const e of entries) {
    const key = e.host === "imac" ? "imac" : e.host === "local" ? "local" : null;
    if (!key) continue;
    const h = hosts[key];
    h.total++;
    const s = e.status || "?";
    h.byStatus[s] = (h.byStatus[s] || 0) + 1;
    h.entries.push(e);
  }
  for (const e of cache?.entries || []) {
    if (e.kind === "hero") hosts.cartridge.heroes.push(e.id);
  }
  return hosts;
}

function statusLine(byStatus) {
  const parts = [];
  for (const s of STATUS_ORDER) {
    if (byStatus[s]) parts.push(`${byStatus[s]} ${s}`);
  }
  for (const [s, n] of Object.entries(byStatus)) {
    if (!STATUS_ORDER.includes(s)) parts.push(`${n} ${s}`);
  }
  return parts.length ? parts.join(" · ") : "0";
}

function printHuman(hosts, cache) {
  const at = cache?.at || "?";
  console.log("GotchiBot mesh — MBP ↔ iMac (Tailscale SSH)");
  console.log(`cache: ${at}`);
  console.log("");
  for (const key of ["local", "imac"]) {
    const h = hosts[key];
    const tag = key === "local" ? "MBP  (local)" : "iMac (remote)";
    if (key === "imac" && h.ok === false) {
      console.log(`${tag}: unreachable — ${h.reason || "unknown"}`);
    } else {
      console.log(`${tag}:  ${statusLine(h.byStatus)}`);
      if (!h.entries.length) console.log("  (none)");
      for (const e of h.entries) {
        console.log(`  ${e.id}  [${e.status}]  hero=${e.hero || "—"}`);
      }
    }
    console.log("");
  }
  const fc = readFocus();
  if (fc) {
    const f =
      fc.mode === "sub"
        ? `SUB hero=${fc.heroId || "—"} host=${fc.host || "—"}`
        : "ORCH (orchestrator)";
    console.log(`Focus: ${f}`);
  }
  const total = hosts.local.total + hosts.imac.total;
  console.log(
    `Totals: ${total} session(s) · heroes: ${(hosts.cartridge.heroes || []).join(", ") || "—"}`,
  );
}

function printJson(hosts, cache) {
  console.log(
    JSON.stringify(
      {
        at: cache?.at || null,
        remoteReachable: hosts.imac.ok !== false,
        hosts: {
          local: {
            label: "MBP",
            total: hosts.local.total,
            byStatus: hosts.local.byStatus,
            entries: hosts.local.entries,
          },
          imac: {
            label: "iMac",
            total: hosts.imac.total,
            byStatus: hosts.imac.byStatus,
            reachable: hosts.imac.ok !== false,
            reason: hosts.imac.reason,
            entries: hosts.imac.entries,
          },
          cartridge: { heroes: hosts.cartridge.heroes },
        },
      },
      null,
      2,
    ),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("gotchibot mesh [ping] [--live] [--json]");
    console.log("  (no args)  agent count + status across MBP and iMac (cached)");
    console.log("  --live     re-scan the iMac peer over Tailscale SSH");
    console.log("  --json     machine-readable payload");
    console.log("  ping       Tailscale + SSH reachability probe");
    process.exit(0);
  }
  if (args.ping) {
    const r = spawnSync(process.execPath, ["scripts/remote-status.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    process.exit(r.status ?? 0);
  }
  let cache = readCache();
  if (args.live || !cache) {
    refreshCache();
    cache = readCache();
  }
  const hosts = groupByHost(cache || { entries: [] });
  if (args.json) printJson(hosts, cache || {});
  else printHuman(hosts, cache || {});
}

main();
