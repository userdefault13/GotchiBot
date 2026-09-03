#!/usr/bin/env node
/**
 * Open / focus Hub VS Code on the GotchiBot workspace so the Claude bridge can run.
 *
 *   abra run gotchibot -- ./scripts/gotchibot vscode-open
 *   abra run gotchibot -- ./scripts/gotchibot vscode-open --check
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMOTE_SH = "scripts/hub-vscode-open-remote.sh";

function usage() {
  console.error(`usage:
  hub-vscode-open.mjs [--check] [--no-wait] [--timeout SEC] [--path <folder>] [--json]`);
  process.exit(2);
}

const args = process.argv.slice(2);
let check = false;
let wait = true;
let jsonOut = false;
let timeoutSec = 45;
let folderOverride = "";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--check") check = true;
  else if (a === "--no-wait") wait = false;
  else if (a === "--wait") wait = true;
  else if (a === "--json") jsonOut = true;
  else if (a === "--timeout") timeoutSec = Number(args[++i]) || timeoutSec;
  else if (a === "--path") folderOverride = args[++i] || "";
  else if (a === "-h" || a === "--help") usage();
  else {
    console.error(`unknown arg: ${a}`);
    usage();
  }
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function main() {
  const { assertRemoteReady, materializeKey, runSsh } = await import(join(__dirname, "remote-lib.mjs"));
  const cfg = assertRemoteReady();
  const mat = materializeKey(cfg.key);
  try {
    const pref = folderOverride || cfg.dir || "";
    const probe = runSsh(cfg, mat.path, `bash ${REMOTE_SH} check ${timeoutSec} ${q(pref)}`, {
      stdio: "pipe",
      timeout: 25000,
    });
    const probeLine = String(probe.stdout || "").trim().split("\n").pop() || "{}";
    let info;
    try {
      info = JSON.parse(probeLine);
    } catch {
      console.error(String(probe.stderr || probe.stdout || "probe failed").trim());
      process.exit(probe.status || 1);
    }

    if (check) {
      const out = {
        ok: Boolean(info.folder && (info.codeBin || info.vscodeApp)),
        host: cfg.host,
        ...info,
      };
      console.log(jsonOut ? JSON.stringify(out) : JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }

    if (!info.folder) {
      console.error("GotchiBot folder not found on Hub");
      process.exit(1);
    }

    if (info.bridgeOk && !folderOverride) {
      const out = {
        ok: true,
        already: true,
        folder: info.folder,
        bridgeOk: true,
        note: "bridge already up — workspace likely open",
      };
      if (jsonOut) console.log(JSON.stringify(out));
      else console.log(`✓ Hub VS Code ready (bridge up)\n  folder: ${info.folder}`);
      process.exit(0);
    }

    const open = runSsh(cfg, mat.path, `bash ${REMOTE_SH} open ${timeoutSec} ${q(info.folder)}`, {
      stdio: "pipe",
      timeout: 30000,
    });
    if (open.status !== 0) {
      console.error(String(open.stderr || open.stdout || "open failed").trim());
      process.exit(open.status || 1);
    }

    let bridgeOk = false;
    if (wait) {
      const w = runSsh(cfg, mat.path, `bash ${REMOTE_SH} wait-bridge ${timeoutSec}`, {
        stdio: "pipe",
        timeout: (timeoutSec + 30) * 1000,
      });
      bridgeOk = w.status === 0;
      if (!bridgeOk) {
        console.error(String(w.stderr || w.stdout || "bridge wait failed").trim());
        console.error("If VS Code just launched: enable gotchibot-bridge + reload window once.");
      }
    }

    const out = {
      ok: wait ? bridgeOk : true,
      folder: info.folder,
      opened: String(open.stdout || "").trim(),
      bridgeOk: wait ? bridgeOk : null,
    };
    if (jsonOut) console.log(JSON.stringify(out));
    else {
      console.log(`✓ opened Hub VS Code → ${info.folder}`);
      if (wait) console.log(bridgeOk ? "✓ bridge :45678 up" : "✗ bridge not up yet");
    }
    process.exit(out.ok ? 0 : 1);
  } finally {
    mat.dispose();
  }
}

await main();
