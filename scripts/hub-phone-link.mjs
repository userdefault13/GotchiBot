#!/usr/bin/env node
/**
 * Link a phone to the Hub: print a one-time pairing QR for the phone app.
 *
 *   node scripts/hub-phone-link.mjs [--name iPhone] [--json]
 *   gotchibot hub phone [--name iPhone]
 *   cockpit → Hub… → Link a phone (QR code)
 *
 * On the Hub (sessions/.hub-api.json) this is `hub pair --qr --kind phone`.
 * On a paired desk it asks the Hub API for a phone code
 * (POST /api/gotchibot/hub/pair/phone, desk token) and draws the same QR — no
 * SSH, so it works from any desk. Scan it inside the phone app
 * (Pair → Scan QR) or type the code.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { pairDeepLink, renderPairQr, resolveAppBase } from "./hub-pair.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parse(argv) {
  const out = { name: "iPhone", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name" && argv[i + 1]) out.name = argv[++i];
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
  }
  return out;
}

/** Text block for a phone code fetched from the Hub API (pure; testable). */
export function phoneLinkOutput({ code, expiresAt, appUrl, host }) {
  const appBase = resolveAppBase({ appUrl, host, env: {} });
  const link = pairDeepLink(appBase, code);
  const mins = expiresAt ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60000)) : null;
  return {
    link,
    appBase,
    text: [
      "Link a phone to the Hub",
      "",
      renderPairQr(link),
      `code     ${code}${mins ? `   (expires in ~${mins} min, one use)` : ""}`,
      `app      ${appBase}`,
      "",
      "On the phone (Tailscale on, same account):",
      `  1. Open ${appBase} in Safari`,
      "  2. Pair → Scan QR, and point it here — or type the code",
      "  3. Share → Add to Home Screen",
    ].join("\n"),
  };
}

export async function main(argv = process.argv.slice(2), { root = ROOT, request } = {}) {
  const opts = parse(argv);
  if (opts.help) {
    console.log("usage: hub-phone-link.mjs [--name NAME] [--json]");
    return 0;
  }
  // This computer is the Hub: mint locally (same as `hub pair --qr --kind phone`).
  if (existsSync(join(root, "sessions", ".hub-api.json"))) {
    const args = [join(root, "scripts", "hub-pair.mjs"), "pair", "--qr", "--kind", "phone", "--name", opts.name];
    if (opts.json) args.push("--json");
    const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    return r.status ?? 1;
  }
  const pin = readJson(join(root, "sessions", ".hub.json"));
  if (!pin?.deskToken) {
    console.error("This computer is not paired with a Hub. Pair first: gotchibot hub join <host> <code>");
    return 1;
  }
  const hubRequest = request || (await import("./chat-hub-client.mjs")).hubRequest;
  let res;
  try {
    res = await hubRequest("POST", "/api/gotchibot/hub/pair/phone", {
      body: { name: opts.name },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const why = e?.status === 404 ? "this Hub is older than the phone-link endpoint — update the Hub, or run `gotchibot hub pair --qr` on it" : e?.message || String(e);
    console.error(`Could not get a phone code from the Hub: ${why}`);
    return 1;
  }
  const out = phoneLinkOutput({ code: res.code, expiresAt: res.expiresAt, appUrl: res.appUrl, host: pin.tailscaleHost });
  if (opts.json) console.log(JSON.stringify({ code: res.code, expiresAt: res.expiresAt, link: out.link }, null, 2));
  else console.log(out.text);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0), (e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
