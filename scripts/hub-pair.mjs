#!/usr/bin/env node
/**
 * Hub pairing CLI — mint codes on the Hub, join from a desk.
 *
 *   gotchibot hub pair [--name NAME] [--json]
 *   gotchibot hub desks [--json] [--via-api]
 *   gotchibot hub revoke <deskId>
 *   gotchibot hub join <host> <code> [--name NAME]
 *
 * Dispatcher keeps the subcommand in argv (process.argv[2] = pair|join|…).
 */
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import os from "node:os";
import { isMainModule } from "./is-main.mjs";
import { hubPinPath, isArcadeSharedChatBase } from "./infra-client.mjs";
import { hubRequest } from "./chat-hub-client.mjs";
import { resolveApiConfig } from "../services/gotchibot-api/config.mjs";
import { connectStore } from "../services/gotchibot-api/store.mjs";

function usage() {
  console.log(`Hub pairing — one-time codes so a desk can talk to YOUR Hub.

  gotchibot hub pair [--name NAME] [--json]
      On the Hub: make a short code. Give it to a desk. It works once.

  gotchibot hub desks [--json] [--via-api]
      On the Hub: list paired desks (no secrets). --via-api uses the desk API.

  gotchibot hub revoke <deskId>
      On the Hub: turn off a desk's token.

  gotchibot hub join <host> <code> [--name NAME]
      On a desk: use the code from the Hub. Saves your desk token locally.
`);
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--via-api") out.viaApi = true;
    else if (a === "--name") out.name = argv[++i];
    else if (a === "-h" || a === "--help" || a === "help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function magicDnsFromTailscale() {
  const r = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout || "{}");
    const dns = j?.Self?.DNSName;
    if (!dns) return null;
    return String(dns).replace(/\.$/, "");
  } catch {
    return null;
  }
}

function resolveJoinBase(host) {
  const h = String(host || "").trim();
  if (!h) throw new Error("host required");
  if (/^https?:\/\//i.test(h)) return h.replace(/\/$/, "");
  if (h.includes(":")) return `http://${h}`;
  return `http://${h}:8793`;
}

/** Host for `hub join` hints: bare when port is default 8793 / missing, else host:port. */
function formatJoinHost(host, port) {
  const h = String(host || "").trim();
  if (!h) return h;
  if (port == null || port === "") return h;
  const n = Number(port);
  if (!Number.isFinite(n) || n === 8793) return h;
  return `${h}:${n}`;
}

function hostWithoutSchemePort(hostOrBase) {
  let s = String(hostOrBase || "").trim();
  s = s.replace(/^https?:\/\//i, "");
  // strip path
  s = s.split("/")[0];
  // strip :port (but keep IPv6 carefully — we only expect MagicDNS / 100.x)
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s) || /^[^:]+:\d+$/.test(s)) {
    s = s.replace(/:\d+$/, "");
  }
  return s;
}

function writeHubPinMerge(patch) {
  const pinPath = hubPinPath();
  mkdirSync(dirname(pinPath), { recursive: true });
  let prev = {};
  try {
    if (existsSync(pinPath)) prev = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch {
    prev = {};
  }
  const next = { ...prev, ...patch };
  const existed = existsSync(pinPath);
  writeFileSync(pinPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (existed) {
    try {
      chmodSync(pinPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return next;
}

async function cmdPair(opts) {
  const config = resolveApiConfig();
  const store = await connectStore({
    mongoUri: config.mongoUri,
    dbName: config.dbName,
  });
  try {
    await store.ensureIndexes();
    const { code, expiresAt } = await store.mintPairingCode({ name: opts.name });
    const host =
      config.tailscaleHost || magicDnsFromTailscale() || "<your-hub-MagicDNS>";
    const joinHost = formatJoinHost(host, config.port);
    const expiresLocal = expiresAt.toLocaleString();
    const out = {
      ok: true,
      code,
      expiresAt: expiresAt.toISOString(),
      host,
      joinHost,
      joinCommand: `gotchibot hub join ${joinHost} ${code}`,
    };
    if (opts.json) {
      console.log(JSON.stringify(out));
      return out;
    }
    console.log("");
    console.log(`Pairing code:  ${code}`);
    console.log(`Expires:       ${expiresLocal} (in 15 minutes)`);
    console.log(`This code works once — after a desk uses it, make a new one.`);
    console.log("");
    console.log(`On the other computer, run:`);
    console.log(`  gotchibot hub join ${joinHost} ${code}`);
    console.log("");
    return out;
  } finally {
    await store.close();
  }
}

function formatDeskRow(d) {
  return {
    deskId: d.deskId,
    name: d.name,
    created: d.createdAt || d.created,
    lastSeen: d.lastSeen,
    revoked: d.revokedAt ?? null,
  };
}

async function cmdDesks(opts) {
  if (opts.viaApi) {
    const json = await hubRequest("GET", "/api/gotchibot/hub/desks");
    const desks = (json.desks || []).map(formatDeskRow);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, desks }));
      return;
    }
    if (!desks.length) {
      console.log("No paired desks yet.");
      return;
    }
    for (const d of desks) {
      const rev = d.revoked ? " (revoked)" : "";
      console.log(
        `${d.deskId}\t${d.name || "—"}\tcreated=${d.created || "—"}\tlastSeen=${d.lastSeen || "—"}${rev}`,
      );
    }
    return;
  }

  const config = resolveApiConfig();
  const store = await connectStore({
    mongoUri: config.mongoUri,
    dbName: config.dbName,
  });
  try {
    await store.ensureIndexes();
    const rows = await store.listDesks();
    const desks = rows.map(formatDeskRow);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, desks }));
      return;
    }
    if (!desks.length) {
      console.log("No paired desks yet. Run: gotchibot hub pair");
      return;
    }
    for (const d of desks) {
      const rev = d.revoked ? " (revoked)" : "";
      console.log(
        `${d.deskId}\t${d.name || "—"}\tcreated=${d.created || "—"}\tlastSeen=${d.lastSeen || "—"}${rev}`,
      );
    }
  } finally {
    await store.close();
  }
}

async function cmdRevoke(deskId) {
  const id = String(deskId || "").trim();
  if (!id) {
    console.error("usage: gotchibot hub revoke <deskId>");
    process.exit(2);
  }
  const config = resolveApiConfig();
  const store = await connectStore({
    mongoUri: config.mongoUri,
    dbName: config.dbName,
  });
  try {
    await store.ensureIndexes();
    const rows = await store.listDesks();
    const found = rows.find((d) => d.deskId === id);
    if (!found) {
      console.error(`Unknown deskId: ${id}`);
      process.exit(1);
    }
    if (found.revokedAt) {
      console.log(`Desk ${id} (${found.name}) was already revoked.`);
      return;
    }
    const ok = await store.revokeDesk(id);
    if (ok) {
      console.log(`Revoked desk ${id} (${found.name}). It can no longer sync chats.`);
    } else {
      console.log(`Desk ${id} was already revoked.`);
    }
  } finally {
    await store.close();
  }
}

async function cmdJoin(host, code, opts) {
  if (!host || !code) {
    console.error("usage: gotchibot hub join <host> <code> [--name NAME]");
    process.exit(2);
  }
  const base = resolveJoinBase(host);
  if (isArcadeSharedChatBase(base)) {
    console.error(
      "That host looks like Arcade shared chat — refuse. Use YOUR Hub MagicDNS or 100.x address.",
    );
    process.exit(1);
  }
  const name = opts.name || os.hostname();
  let res;
  try {
    const r = await fetch(`${base}/api/gotchibot/hub/pair/claim`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GotchiBot/desk-pair",
      },
      body: JSON.stringify({ code, name }),
    });
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (!r.ok) {
      const msg = json.error || `HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403) {
        console.error(`Pairing failed (${r.status}): ${msg}`);
        console.error(
          "Likely: the code expired or was already used, or you're not signed into the same Tailscale account as the Hub owner.",
        );
        process.exit(1);
      }
      console.error(`Pairing failed (${r.status}): ${msg}`);
      process.exit(1);
    }
    res = json;
  } catch (e) {
    console.error(`Could not reach Hub at ${base}: ${e.message || e}`);
    process.exit(1);
  }

  const deskId = res.deskId;
  const deskToken = res.deskToken;
  const deskName = res.name || name;
  if (!deskId || !deskToken) {
    console.error("Hub reply missing deskId/deskToken");
    process.exit(1);
  }

  writeHubPinMerge({
    tailscaleHost: hostWithoutSchemePort(host),
    deskApiBase: base,
    deskId,
    deskToken,
    deskName,
    pairedAt: new Date().toISOString(),
  });

  // Confirm with whoami (never print the token)
  try {
    const who = await fetch(`${base}/api/gotchibot/hub/whoami`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GotchiBot/desk-pair",
        "X-GotchiBot-Desk-Token": deskToken,
      },
    });
    const whoJson = await who.json().catch(() => ({}));
    if (!who.ok) {
      console.warn(
        `Paired, but whoami check failed (${who.status}): ${whoJson.error || who.statusText}`,
      );
    }
  } catch (e) {
    console.warn(`Paired, but whoami check failed: ${e.message || e}`);
  }

  console.log(
    `Paired! This desk is ${deskName} (${deskId}). Chats now go to your Hub at ${base}.`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || "help";
  const opts = parseFlags(argv.slice(1));
  if (opts.help || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  try {
    if (cmd === "pair") await cmdPair(opts);
    else if (cmd === "desks") await cmdDesks(opts);
    else if (cmd === "revoke") await cmdRevoke(opts._[0]);
    else if (cmd === "join") await cmdJoin(opts._[0], opts._[1], opts);
    else {
      usage();
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

export {
  main,
  resolveJoinBase,
  formatJoinHost,
  hostWithoutSchemePort,
  magicDnsFromTailscale,
  usage,
};
