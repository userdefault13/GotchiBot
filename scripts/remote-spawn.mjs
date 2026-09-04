#!/usr/bin/env node
/**
 * Spawn a gated GotchiBot sub-agent on the home iMac over Tailscale SSH.
 *
 * Forwards API keys from the local abra env (same set as remote-serve) so the
 * iMac can run opencode without interactive Keychain unlock.
 *
 *   abra run gotchibot -- node scripts/remote-spawn.mjs [--model nim] [--hero ID] "PROMPT"
 *   abra run gotchibot -- ./scripts/gotchibot spawn --host imac "PROMPT"
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey, runSsh, runScp, localSessionFiles } from "./remote-lib.mjs";
import { checkSpawnGate } from "./wallet-gate.mjs";
import { looksStandingTask, assertSandboxHeroAvailable } from "./hero-agent-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FORWARD = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "AARCADE_GOTCHIBOT_SERVICE_SECRET",
  "GOTCHIBOT_OWNER",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function usage() {
  console.error(`usage:
  remote-spawn.mjs [--model nim|pro|local|<id>] [--hero <heroId>] [--sandbox] [--json] "PROMPT"
  remote-spawn.mjs output <sessionId>
  remote-spawn.mjs wait <sessionId>…
  remote-spawn.mjs status <sessionId>`);
  process.exit(2);
}

function parseArgs(argv) {
  let model = "auto";
  let hero = process.env.GOTCHIBOT_HERO_ID || "";
  let json = false;
  let sandbox = process.env.GOTCHIBOT_SANDBOX === "1";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (a === "--hero" && argv[i + 1]) {
      hero = argv[++i];
    } else if (a === "--json") {
      json = true;
    } else if (a === "--sandbox") {
      sandbox = true;
    } else {
      rest.push(a);
    }
  }
  return { model, hero, json, sandbox, rest };
}

function writeForwardEnv({ sandbox = false } = {}) {
  const lines = ["export GOTCHIBOT_SKIP_ABRA=1", "export GOTCHIBOT_AUTO_APPROVE=1"];
  if (sandbox) lines.push("export GOTCHIBOT_SANDBOX=1");
  for (const k of FORWARD) {
    if (process.env[k]) lines.push(`export ${k}=${shellQuote(process.env[k])}`);
  }
  // Sandbox-only: forward ABRA_KEY so the container can hit host.docker.internal:7331
  if (sandbox && process.env.ABRA_KEY) {
    lines.push(`export ABRA_KEY=${shellQuote(process.env.ABRA_KEY)}`);
    lines.push(`export ABRA_PROJECT=${shellQuote(process.env.ABRA_PROJECT || "gotchibot")}`);
  }
  const path = join(tmpdir(), `gotchibot-spawn-env-${process.pid}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

function syncIdentity(cfg, keyPath) {
  const files = localSessionFiles(ROOT);
  if (!files.length) return { synced: 0 };
  const r = runScp(cfg, keyPath, files, "sessions");
  return { synced: files.length, status: r.status };
}

function sshSpawn(cfg, keyPath, { model, hero, prompt, sandbox }) {
  const localEnv = writeForwardEnv({ sandbox });
  const remoteEnv = `/tmp/gotchibot-spawn-${process.pid}.env`;
  try {
    const scp = spawnSync(
      "scp",
      [
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        keyPath,
        localEnv,
        `${cfg.user}@${cfg.host}:${remoteEnv}`,
      ],
      { encoding: "utf8" },
    );
    if (scp.status !== 0) {
      throw new Error(`scp env failed: ${(scp.stderr || "").slice(0, 200)}`);
    }

    const heroExport = hero ? `export GOTCHIBOT_HERO_ID=${shellQuote(hero)}; ` : "";
    const sandboxFlag = sandbox ? " --sandbox" : "";
    const remoteCmd = [
      `set -euo pipefail`,
      `source ${shellQuote(remoteEnv)}`,
      `rm -f ${shellQuote(remoteEnv)}`,
      heroExport +
        `node ./scripts/gotchi-orchestrate.mjs spawn --host local${sandboxFlag} --model ${shellQuote(model)} ${shellQuote(prompt)}`,
    ].join("; ");

    const r = runSsh(cfg, keyPath, remoteCmd, { stdio: "pipe" });
    return r;
  } finally {
    try {
      unlinkSync(localEnv);
    } catch {}
  }
}

function sshCatState(cfg, keyPath, id, file = "output.md") {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "");
  return runSsh(
    cfg,
    keyPath,
    `if [ -f sessions/${safeId}/${file} ]; then cat sessions/${safeId}/${file}; else echo "missing: sessions/${safeId}/${file}" >&2; exit 1; fi`,
    { stdio: "pipe" },
  );
}

function sshField(cfg, keyPath, id, key) {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "");
  const r = runSsh(
    cfg,
    keyPath,
    `grep -E '^${key}=' sessions/${safeId}/state.env 2>/dev/null | head -1 | cut -d= -f2-`,
    { stdio: "pipe" },
  );
  return (r.stdout || "").trim();
}

async function cmdSpawn(argv) {
  const { model, hero, json, sandbox, rest } = parseArgs(argv);
  const prompt = rest.join(" ").trim();
  if (!prompt) usage();

  if (sandbox) {
    const heroCheck = await assertSandboxHeroAvailable(hero || process.env.GOTCHIBOT_HERO_ID || "");
    if (!heroCheck.ok) {
      console.error(`sandbox spawn blocked (${heroCheck.code}): ${heroCheck.message}`);
      if (heroCheck.fix) console.error(`fix: ${heroCheck.fix}`);
      console.error("Never auto-mint. Use /spawn overlay yourself if you need a new hero.");
      process.exit(13);
    }
  }

  // Gate on MBP first (same cartridge/wallet truth); then sync to iMac.
  const gate = await checkSpawnGate();
  if (!gate.ok) {
    console.error(`spawn blocked (${gate.code}): ${gate.message}`);
    if (gate.fix) console.error(`fix: ${gate.fix}`);
    process.exit(gate.code === "wallet" ? 10 : gate.code === "cartridge" ? 11 : 12);
  }

  const cfg = assertRemoteReady();
  const key = materializeKey(cfg.key);
  try {
    const sync = syncIdentity(cfg, key.path);
    const r = sshSpawn(cfg, key.path, {
      model,
      hero: hero || gate.activeHeroId || "",
      prompt,
      sandbox,
    });
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    if (r.status !== 0) {
      if (err) console.error(err);
      if (out) console.error(out);
      console.error(`remote spawn failed (ssh status ${r.status})`);
      process.exit(r.status ?? 1);
    }
    // Last non-empty line is session id from orchestrate
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const sessionId = lines[lines.length - 1] || "";
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            host: "imac",
            sessionId,
            model,
            sandbox: !!sandbox,
            hero: hero || gate.activeHeroId || null,
            remoteHost: cfg.host,
            synced: sync.synced,
            gate,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(sessionId);
      console.error(
        `spawned ${sessionId} on imac (${cfg.host}) model=${model} hero=${hero || gate.activeHeroId || "roster"}${sandbox ? " sandbox" : ""}`,
      );
    }
    const hid = hero || gate.activeHeroId || "";
    if (hid && sessionId) {
      spawnSync(
        process.execPath,
        [
          `${ROOT}/scripts/hero-agent-state.mjs`,
          "set",
          hid,
          looksStandingTask(prompt) ? "assigned" : "working",
          "--session",
          sessionId,
          "--task",
          String(prompt || "").slice(0, 200),
          "--host",
          "imac",
        ],
        { stdio: "ignore" },
      );
    }
    spawnSync("bash", [`${ROOT}/scripts/poke-avatar.sh`], { stdio: "ignore" });
  } finally {
    key.dispose();
  }
}

async function withRemote(fn) {
  const cfg = assertRemoteReady();
  const key = materializeKey(cfg.key);
  try {
    return await fn(cfg, key.path);
  } finally {
    key.dispose();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "output") {
    const id = rest[0];
    if (!id) usage();
    await withRemote((cfg, keyPath) => {
      const r = sshCatState(cfg, keyPath, id, "output.md");
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    });
    return;
  }

  if (cmd === "status") {
    const id = rest[0];
    if (!id) usage();
    await withRemote((cfg, keyPath) => {
      const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "");
      const r = runSsh(cfg, keyPath, `sed 's/^/  /' sessions/${safeId}/state.env`, { stdio: "pipe" });
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    });
    return;
  }

  if (cmd === "wait") {
    const ids = rest.filter(Boolean);
    if (!ids.length) usage();
    await withRemote(async (cfg, keyPath) => {
      for (const id of ids) {
        process.stderr.write(`waiting imac:${id}…\n`);
        for (;;) {
          const st = sshField(cfg, keyPath, id, "status");
          if (st === "done" || st === "failed") {
            console.error(`imac:${id} → ${st}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    });
    return;
  }

  // Default: spawn (optional leading "spawn" verb)
  const argv = cmd === "spawn" ? rest : process.argv.slice(2);
  await cmdSpawn(argv);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
