#!/usr/bin/env node
/**
 * Remote picker — cockpit option 9. A factory-style tile grid of the desks in
 * config/desks.json that you can ssh into. Pick one and a new tmux window
 * (named after the desk) runs an interactive `ssh user@host`.
 *
 *   node scripts/remote-picker.mjs          interactive
 *   node scripts/remote-picker.mjs --list   print the desks and exit
 *
 * Keys: arrows / h j k l move · enter open · r refresh · esc / q close
 * Online state: `tailscale status --json` (read-only, 3s cap). Unknown when
 * tailscale is missing; the desk is still listed and ssh fails visibly.
 * This never runs anything on the remote desk and never uses gliff (that is a
 * Hyprland GUI client). No new protocol, no secrets, no ports.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import { isMainModule } from "./is-main.mjs";
import { loadDesks } from "./gliff-desk.mjs";
import { c, boxTop, boxRow, boxBottom, padVis, trunc } from "./pstack-window.mjs";

const TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "").split(".")[0];

/** Read-only tailnet facts: this machine's IPs/names and each peer's online flag. */
export function tailnetState(run = defaultTailscale) {
  const out = { ok: false, selfIps: new Set(), selfNames: new Set(), online: new Map() };
  let json;
  try {
    json = JSON.parse(run());
  } catch {
    return out;
  }
  out.ok = true;
  const self = json?.Self || {};
  for (const ip of self.TailscaleIPs || []) out.selfIps.add(ip);
  if (self.HostName) out.selfNames.add(norm(self.HostName));
  if (self.DNSName) out.selfNames.add(norm(self.DNSName));
  for (const p of Object.values(json?.Peer || {})) {
    const on = Boolean(p.Online);
    for (const ip of p.TailscaleIPs || []) out.online.set(ip, on);
    if (p.DNSName) out.online.set(norm(p.DNSName), on);
    if (p.HostName) out.online.set(norm(p.HostName), on);
  }
  return out;
}

function defaultTailscale() {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) throw new Error("tailscale status failed");
  return String(r.stdout || "");
}

/** Desks you can remote into: registry order, current machine skipped. */
export function buildRemoteDesks(registry, tail = { ok: false, selfIps: new Set(), selfNames: new Set(), online: new Map() }, hostname = os.hostname()) {
  const me = new Set([...tail.selfNames, norm(hostname)]);
  const list = [];
  for (const [name, d] of Object.entries(registry.desks || {})) {
    const user = d.user || registry.user;
    const names = [name, ...(d.aliases || []), /^\d+\./.test(d.host) ? "" : d.host].map(norm).filter(Boolean);
    if (tail.selfIps.has(d.host) || names.some((n) => me.has(n))) continue;
    const key = /^\d+\./.test(d.host) ? d.host : norm(d.host);
    const state = tail.ok && tail.online.has(key) ? (tail.online.get(key) ? "online" : "offline") : "unknown";
    list.push({ name, user, host: d.host, target: `${user}@${d.host}`, role: d.role || "", aliases: d.aliases || [], state });
  }
  return list;
}

/** argv for the ssh the new tile runs. Nothing else is ever sent to the desk. */
export function sshArgv(desk) {
  if (!TARGET_RE.test(desk.target)) throw new Error(`not a valid user@host: ${desk.target}`);
  return ["ssh", desk.target];
}

/** tmux argv: a new window named after the desk running the interactive ssh. */
export function tmuxOpenArgv(desk, session = "") {
  const t = session ? ["-t", `${String(session).replace(/^=/, "")}:`] : [];
  return ["new-window", "-n", String(desk.name).replace(/[^A-Za-z0-9._-]/g, "_"), ...t, ...sshArgv(desk)];
}

/** Open the tile. `run` is injectable so tests never exec tmux. */
export function openDesk(desk, { session = process.env.GOTCHIBOT_TMUX_SESSION || "", run = (a) => spawnSync("tmux", a, { stdio: "ignore" }).status } = {}) {
  return run(tmuxOpenArgv(desk, session));
}

const DOT = { online: `${c.green}●${c.reset}`, offline: `${c.gray}○${c.reset}`, unknown: `${c.yellow}◌${c.reset}` };

export function renderTiles(desks, sel, cols, rows = 40) {
  const innerW = Math.max(20, cols - 2);
  const tileW = innerW >= 90 ? Math.floor(innerW / 3) : innerW >= 56 ? Math.floor(innerW / 2) : innerW;
  const per = Math.max(1, Math.floor(innerW / tileW));
  const out = [boxTop("Remote · desks over ssh", innerW)];
  if (!desks.length) out.push(boxRow(` ${c.dim}no other desks in config/desks.json${c.reset}`, innerW));
  for (let i = 0; i < desks.length; i += per) {
    const row = desks.slice(i, i + per);
    const cells = [0, 1, 2].map((line) => row.map((d, j) => {
      const on = i + j === sel;
      const mark = on ? `${c.pink}▌${c.reset}` : " ";
      const w = tileW - 2;
      const text = line === 0
        ? `${DOT[d.state]} ${on ? c.bold + c.pink : c.white}${trunc(d.name, w - 4)}${c.reset}${d.role ? ` ${c.dim}${d.role}${c.reset}` : ""}`
        : line === 1 ? `${c.cyan}${trunc(d.target, w - 1)}${c.reset}`
          : `${c.dim}${d.state}${d.aliases.length ? " · " + d.aliases.join(" · ") : ""}${c.reset}`;
      return mark + padVis(text, w) + " ";
    }).join(""));
    for (const line of cells) out.push(boxRow(line, innerW));
    out.push(boxRow("", innerW));
  }
  out.push(boxBottom(innerW));
  out.push(`${c.dim}arrows/hjkl move · enter open ssh tile · r refresh · esc/q close${c.reset}`);
  return out.slice(0, Math.max(rows, 8));
}

async function interactive() {
  const registry = loadDesks();
  let tail = tailnetState();
  let desks = buildRemoteDesks(registry, tail);
  let sel = 0;
  const paint = () => {
    const cols = process.stdout.columns || 80;
    process.stdout.write(`\x1b[2J\x1b[H${renderTiles(desks, sel, cols, process.stdout.rows || 40).join("\n")}\n`);
  };
  const { default: readline } = await import("node:readline");
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");
  const done = (code = 0) => {
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    process.exit(code);
  };
  paint();
  process.stdin.on("keypress", (str, key = {}) => {
    const n = desks.length;
    const cols = process.stdout.columns || 80;
    const per = cols - 2 >= 90 ? 3 : cols - 2 >= 56 ? 2 : 1;
    if (key.name === "escape" || str === "q" || (key.ctrl && key.name === "c")) return done();
    if (key.name === "return" && n) {
      openDesk(desks[sel]);
      return done();
    }
    if (str === "r") {
      tail = tailnetState();
      desks = buildRemoteDesks(registry, tail);
      sel = Math.min(sel, Math.max(0, desks.length - 1));
    } else if (key.name === "left" || str === "h") sel = Math.max(0, sel - 1);
    else if (key.name === "right" || str === "l") sel = Math.min(n - 1, sel + 1);
    else if (key.name === "up" || str === "k") sel = Math.max(0, sel - per);
    else if (key.name === "down" || str === "j") sel = Math.min(n - 1, sel + per);
    paint();
  });
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--list")) {
    for (const d of buildRemoteDesks(loadDesks(), tailnetState())) console.log(`${d.name.padEnd(14)} ${d.target.padEnd(34)} ${d.state}`);
  } else {
    interactive();
  }
}
