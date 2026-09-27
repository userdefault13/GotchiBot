#!/usr/bin/env node
/**
 * Hub network setup — wire Desk ↔ Hub over Tailscale.
 *
 *   gotchibot hub setup                  guided: one computer or two, Tailscale sign-in, install or join
 *   gotchibot hub setup --status [--json]
 *
 * One computer: Hub API on loopback, desk paired to 127.0.0.1 (no Tailscale).
 * Two computers: both signed into the same Tailscale account; the Hub runs
 * `hub install`, the Desk finds it on the tailnet and runs `hub join`.
 * Tailscale accounts are free; the first sign-in link creates one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import os from "node:os";
import { isMainModule } from "./is-main.mjs";
import { hubPinPath } from "./infra-client.mjs";
import { HUB_CONFIG_DEFAULT_PATH, readHubApiConfig } from "../services/gotchibot-api/config.mjs";
import {
  tailscaleBin,
  readTailscaleStatus,
  tailscaleState,
  hubProbeTargets,
  tailscaleDownloadUrl,
} from "./tailscale-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_INSTALL = `${ROOT}/scripts/hub-install.mjs`;
const HUB_PAIR = `${ROOT}/scripts/hub-pair.mjs`;

/** `hub install` takes 8793 unless something else holds it. */
export const HUB_PORTS = [8793, 8794, 8795, 8796, 8797, 8798, 8799];

const say = (msg = "") => console.log(msg);

// ─── state (no network) ──────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function hubConfigPath() {
  return process.env.GOTCHIBOT_HUB_CONFIG || HUB_CONFIG_DEFAULT_PATH;
}

export function hubNetworkSummary() {
  const hubCfg = existsSync(hubConfigPath()) ? readHubApiConfig(hubConfigPath()) : null;
  const pin = readJson(hubPinPath());
  const deskPaired = Boolean(pin?.deskToken && pin?.deskApiBase);
  return {
    hubInstalled: Boolean(hubCfg),
    hubPort: hubCfg?.port ?? null,
    hubTailscaleHost: hubCfg?.tailscaleHost ?? null,
    deskPaired,
    deskApiBase: deskPaired ? pin.deskApiBase : null,
    deskName: deskPaired ? pin.deskName ?? null : null,
  };
}

// ─── discovery ───────────────────────────────────────────────────────────────

export async function probeHealth(host, port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return j?.service === "gotchibot-api" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Probe every online tailnet device for a gotchibot-api /health.
 * `tailscale serve` routes by MagicDNS hostname (a request to the bare IP gets 404),
 * so devices without a MagicDNS name can't be found or joined.
 */
export async function discoverHubs(statusJson, { ports = HUB_PORTS, probe = probeHealth } = {}) {
  const targets = hubProbeTargets(statusJson).filter((t) => t.dnsName);
  const hits = [];
  await Promise.all(
    targets.flatMap((t) =>
      ports.map(async (port) => {
        const h = await probe(t.dnsName, port);
        if (h) hits.push({ ...t, joinHost: t.dnsName, port, version: h.version ?? null, db: h.db ?? null });
      }),
    ),
  );
  return hits.sort((a, b) => Number(b.sameUser) - Number(a.sameUser) || a.name.localeCompare(b.name));
}

// ─── prompts ─────────────────────────────────────────────────────────────────

let rl = null;

function ask(q) {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => r(String(a).trim())));
}

async function pick(prompt, options) {
  say(prompt);
  options.forEach((o, i) => say(`  ${i + 1}) ${o.label}`));
  for (;;) {
    const a = (await ask(`Choose 1-${options.length} (q to stop): `)).toLowerCase();
    if (a === "q") return null;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].key;
  }
}

async function confirm(q, defaultYes = true) {
  const a = (await ask(`${q} [${defaultYes ? "Y/n" : "y/N"}]: `)).toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes";
}

/** Child owns the terminal while it runs. */
function runInherit(cmd, args) {
  rl?.pause();
  try {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: process.env });
    return r.status ?? 1;
  } finally {
    rl?.resume();
  }
}

function openUrl(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawnSync(cmd, args, { stdio: "ignore" });
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

function manualUpHint() {
  return process.platform === "linux" ? "sudo tailscale up" : "tailscale up";
}

/** Walk the user from "not installed" to "signed in and connected". Returns the running state or null. */
async function ensureTailscale() {
  let starting = 0;
  for (;;) {
    const ts = tailscaleState(readTailscaleStatus());
    if (ts.state === "running") {
      say(`  ✓ Tailscale connected — this computer is ${ts.dnsName || "(no MagicDNS name)"}`);
      if (ts.login) say(`    signed in as ${ts.login}`);
      return ts;
    }

    if (ts.state === "missing") {
      say("  Tailscale isn't installed. It's the free private network your Desk and Hub use to find each other.");
      say(`  Download: ${tailscaleDownloadUrl()}`);
      if (process.platform === "linux") say("  Or in a terminal: curl -fsSL https://tailscale.com/install.sh | sh");
      const a = (await ask("  Enter = open the download page · r = re-check after installing · q = stop: ")).toLowerCase();
      if (a === "q") return null;
      if (!a) openUrl(tailscaleDownloadUrl());
      if (a !== "r") await ask("  Press Enter once Tailscale is installed… ");
      continue;
    }

    if (ts.state === "daemon-down") {
      if (process.platform === "darwin") {
        say("  Tailscale is installed but not running. Opening the app (look for it in the menu bar)…");
        spawnSync("open", ["-a", "Tailscale"], { stdio: "ignore" });
      } else {
        say("  Tailscale is installed but its service isn't running. In a terminal:");
        say("    sudo systemctl enable --now tailscaled");
      }
      if ((await ask("  Press Enter to re-check (q to stop): ")).toLowerCase() === "q") return null;
      continue;
    }

    if (ts.state === "needs-login" || ts.state === "stopped") {
      if (ts.state === "needs-login") {
        say("  Sign in to Tailscale. New to Tailscale? The same link creates your free account");
        say("  (Google, GitHub, Microsoft, or Apple). Use the SAME account on both computers.");
      } else {
        say("  Tailscale is signed in but switched off. Turning it on…");
      }
      const code = runInherit(tailscaleBin(), [ts.state === "needs-login" ? "login" : "up"]);
      if (code !== 0) {
        say(`  Couldn't do that from here. In another terminal run:  ${manualUpHint()}`);
        say("  Open the link it prints, sign in, then come back.");
        if ((await ask("  Press Enter to re-check (q to stop): ")).toLowerCase() === "q") return null;
      }
      continue;
    }

    if (ts.state === "needs-approval") {
      say("  This device is waiting for approval in your Tailscale admin console:");
      say("    https://login.tailscale.com/admin/machines");
      if ((await ask("  Press Enter after approving (q to stop): ")).toLowerCase() === "q") return null;
      continue;
    }

    if (++starting > 5) {
      say(`  Tailscale is still ${ts.backend || "starting"}.`);
      if ((await ask("  Press Enter to re-check (q to stop): ")).toLowerCase() === "q") return null;
      starting = 0;
    } else {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ─── flows ───────────────────────────────────────────────────────────────────

function deskName() {
  return os.hostname().replace(/\.local$/, "");
}

function mintCode(name) {
  const r = spawnSync(process.execPath, [HUB_PAIR, "pair", "--json", "--name", name], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(r.stdout).code || null;
  } catch {
    say(`  Couldn't make a pairing code: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return null;
  }
}

function activeDeskCount() {
  const r = spawnSync(process.execPath, [HUB_PAIR, "desks", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return (JSON.parse(r.stdout).desks || []).filter((d) => !d.revoked).length;
  } catch {
    return null;
  }
}

async function okToRepair(summary) {
  if (!summary.deskPaired) return true;
  say(`  This desk is already paired with ${summary.deskApiBase}.`);
  return confirm("  Pair it again (replaces that pairing)?", false);
}

async function oneComputer(summary) {
  say("\nStep 1 of 2: Install the Hub on this computer (private to this computer, no Tailscale needed)");
  if (runInherit(process.execPath, [HUB_INSTALL, "install", "--no-tailscale"]) !== 0) return 1;

  say("\nStep 2 of 2: Pair this Desk with it");
  if (!(await okToRepair(summary))) return 0;
  const port = readHubApiConfig(hubConfigPath())?.port ?? HUB_PORTS[0];
  const code = mintCode(`${deskName()} (local)`);
  if (!code) return 1;
  return runInherit(process.execPath, [HUB_PAIR, "join", `127.0.0.1:${port}`, code, "--name", `${deskName()} (local)`]);
}

async function hubComputer() {
  say("\nStep 1 of 3: Tailscale");
  if (!(await ensureTailscale())) return 1;

  say("\nStep 2 of 3: Install the Hub");
  if (runInherit(process.execPath, [HUB_INSTALL, "install"]) !== 0) return 1;

  say("\nStep 3 of 3: Pairing code for your Desk");
  // With no paired desks yet, `hub install` already printed a code.
  const active = activeDeskCount();
  if (active && (await confirm(`  ${active} desk(s) already paired. Make a code for another desk?`))) {
    runInherit(process.execPath, [HUB_PAIR, "pair", "--name", "desk"]);
  }
  say("  On your Desk computer run:  gotchibot hub setup");
  say("  and choose \"this computer is the Desk\". It finds this Hub by itself; you just type the code.");
  return 0;
}

async function chooseHub(statusJson) {
  for (;;) {
    say("  Looking for your Hub on Tailscale…");
    const hits = await discoverHubs(statusJson);
    if (hits.length) {
      const label = (h) =>
        `${h.name}${h.self ? " (this computer)" : ""} — ${h.joinHost}:${h.port}${h.sameUser ? "" : " · different Tailscale account"}`;
      if (hits.length === 1) {
        say(`  Found: ${label(hits[0])}`);
        if (await confirm("  Use this Hub?")) return hits[0];
      } else {
        const key = await pick("  Found more than one Hub:", hits.map((h, i) => ({ key: i, label: label(h) })));
        if (key == null) return null;
        return hits[key];
      }
    } else {
      say("  No Hub found. On the Hub computer run  gotchibot hub setup  and choose \"this computer is the Hub\".");
      say("  Both computers must be on and signed into the same Tailscale account, with MagicDNS on");
      say("  (the default; check https://login.tailscale.com/admin/dns).");
    }
    const next = await pick("  What now?", [
      { key: "retry", label: "Look again" },
      { key: "manual", label: "Type the Hub's address myself" },
    ]);
    if (next == null) return null;
    if (next === "manual") {
      const addr = await ask("  Hub address (MagicDNS name, optionally :port): ");
      if (!addr) continue;
      const [host, p] = addr.replace(/^https?:\/\//, "").split(/:(?=\d+$)/);
      return { name: host, joinHost: host, port: Number(p) || HUB_PORTS[0] };
    }
    statusJson = readTailscaleStatus().json || statusJson;
  }
}

async function deskComputer(summary) {
  say("\nStep 1 of 3: Tailscale");
  if (!(await ensureTailscale())) return 1;
  if (!(await okToRepair(summary))) return 0;

  say("\nStep 2 of 3: Find your Hub");
  const hub = await chooseHub(readTailscaleStatus().json);
  if (!hub) return 1;

  say("\nStep 3 of 3: Pair with the code the Hub showed you");
  say("  (No code? On the Hub run:  gotchibot hub pair)");
  for (;;) {
    const code = await ask("  Pairing code (XXXX-XXXX, q to stop): ");
    if (!code || code.toLowerCase() === "q") return 1;
    const status = runInherit(process.execPath, [HUB_PAIR, "join", `${hub.joinHost}:${hub.port}`, code, "--name", deskName()]);
    if (status === 0) return 0;
  }
}

function printSummary(s) {
  if (s.hubInstalled) say(`  Hub:  installed on this computer (port ${s.hubPort ?? "?"}${s.hubTailscaleHost ? `, ${s.hubTailscaleHost}` : ", this computer only"})`);
  if (s.deskPaired) say(`  Desk: paired with ${s.deskApiBase}${s.deskName ? ` as ${s.deskName}` : ""}`);
  if (!s.hubInstalled && !s.deskPaired) say("  Not set up yet.");
}

export async function runSetup() {
  const summary = hubNetworkSummary();
  say("");
  say("GotchiBot Hub network");
  say("The Hub keeps your chats and runs the GotchiBot API; the Desk is where you work.");
  say("Two computers talk over Tailscale, a free private network only your devices can reach.");
  say("");
  printSummary(summary);
  say("");
  const mode = await pick("How many computers will run GotchiBot?", [
    { key: "one", label: "One — this computer is both Desk and Hub" },
    { key: "hub", label: "Two — this computer is the Hub (always on, keeps the chats)" },
    { key: "desk", label: "Two — this computer is the Desk (where you work)" },
  ]);
  try {
    if (mode === "one") return await oneComputer(summary);
    if (mode === "hub") return await hubComputer();
    if (mode === "desk") return await deskComputer(summary);
    return 1;
  } finally {
    rl?.close();
    rl = null;
  }
}

async function status(json) {
  const s = hubNetworkSummary();
  const ts = tailscaleState(readTailscaleStatus());
  const reachable = s.deskPaired ? Boolean(await probeHealthBase(s.deskApiBase)) : null;
  if (json) {
    say(JSON.stringify({ ok: true, tailscale: ts, ...s, deskReachable: reachable }, null, 2));
    return 0;
  }
  say(`  Tailscale: ${ts.state}${ts.dnsName ? ` · ${ts.dnsName}` : ""}${ts.login ? ` · ${ts.login}` : ""}`);
  printSummary(s);
  if (s.deskPaired) say(`  Hub reachable: ${reachable ? "yes" : "no"}`);
  return 0;
}

async function probeHealthBase(base) {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j?.service === "gotchibot-api" ? j : null;
  } catch {
    return null;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = argv[0] === "setup" ? argv.slice(1) : argv;
  if (args.includes("-h") || args.includes("--help")) {
    say("usage: gotchibot hub setup [--status [--json]]");
    return 0;
  }
  if (args.includes("--status")) return status(args.includes("--json"));
  if (!process.stdin.isTTY) {
    console.error("gotchibot hub setup asks questions — run it in a terminal. For state: --status [--json]");
    return 2;
  }
  return runSetup();
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(e?.message || e);
      process.exit(1);
    });
}
