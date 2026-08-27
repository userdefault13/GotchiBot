#!/usr/bin/env node
/**
 * One-shot: mint-pin LINK hero Discord sub-agent on iMac (skip abra Keychain).
 *   abra run gotchibot -- node scripts/remote-spawn-discord.mjs
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey } from "./remote-lib.mjs";

const cfg = assertRemoteReady();
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const FORWARD = [
  "AARCADE_GOTCHIBOT_SERVICE_SECRET",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GOTCHIBOT_OWNER",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
];

const prompt = `You are GotchiBot sub-agent bound to cAavegotchi starter-link-h1-1 (LINK collateral).

GOAL: Make GotchiBot reachable from iPhone via Discord. User DMs or @mentions a Discord bot; OpenClaw (or a thin bridge) on the iMac routes prompts to the gotchi orchestrator / opencode serve and posts replies back.

CONTEXT (already true on this machine):
- Host: Juliuss-iMac-2, Tailscale 100.68.95.90
- Repo: /Users/juliuswong/Dev/GotchiBot
- Wallet logged in; cartridge sim-0677e437f12f1955; heroes owned-954 + starter-link-h1-1
- opencode serve is running Tailscale-only on http://100.68.95.90:4096 (health OK)
- OpenClaw Discord is the preferred path (config/openclaw.gotchi.json5 already defines gotchi agent + gotchi-orchestrate.mjs spawn)
- doza62 OpenCode Mobile iOS app is buggy — do NOT rely on it
- NEVER install packages autonomously. If you need a skill/tool not in skills/registry.json, append to skill-requests.jsonl and continue with docs/config only.
- NEVER invent or print Discord bot tokens. If DISCORD_BOT_TOKEN is missing from env, write exact abra set commands for the user and stop before needing the secret.
- Secrets via abracadabra / orchestrator only.

DEFINITION OF DONE (write all of this to output.md):
1. Confirm env: is DISCORD_BOT_TOKEN set? (yes/no — do not print value). Is OpenClaw installed/running on this iMac? (probe docker/cli/ports 18789).
2. Concrete setup steps completed OR blocked with exact next human actions:
   - Discord Developer Portal: bot + Message Content Intent + invite URL
   - abra set gotchibot DISCORD_BOT_TOKEN (and APPLICATION_ID if needed)
   - OpenClaw channels.discord config patch using config/openclaw.gotchi.json5
   - gateway start + pairing approve
3. If OpenClaw is available and token is present: apply config (no plaintext token in files — use env SecretRef), restart gateway, verify Discord channel status, document DM/pairing steps for the user.
4. If OpenClaw is missing: produce a minimal design for a Discord→opencode bridge using \`opencode run --attach http://127.0.0.1:4096 --agent gotchi\` (or Tailscale URL), list skill-requests needed, do not npm-install.
5. End with: how the user tests from iPhone Discord (DM text + expected reply), and any files you changed under GotchiBot (paths only).

Constraints: stay in GotchiBot tree; no autonomous installs; no secret values in output.md.`;

const lines = [
  `export GOTCHIBOT_HERO_ID=starter-link-h1-1`,
  `export GOTCHIBOT_SKIP_ABRA=1`,
  `export GOTCHIBOT_AUTO_APPROVE=1`,
  `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`,
];
for (const k of FORWARD) {
  if (process.env[k]) lines.push(`export ${k}=${q(process.env[k])}`);
}

const localEnv = join(tmpdir(), `gotchibot-spawn-env-${process.pid}`);
const promptFile = join(tmpdir(), `gotchibot-discord-prompt-${process.pid}.txt`);
writeFileSync(localEnv, lines.join("\n") + "\n", { mode: 0o600 });
writeFileSync(promptFile, prompt);

const key = materializeKey(cfg.key);
try {
  let r = spawnSync(
    "scp",
    [
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      key.path,
      "scripts/opencode-dispatch.sh",
      localEnv,
      promptFile,
      `${cfg.user}@${cfg.host}:/tmp/`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stderr || "scp failed");
    process.exit(r.status ?? 1);
  }

  const remoteEnv = `/tmp/${localEnv.split("/").pop()}`;
  const remotePrompt = `/tmp/${promptFile.split("/").pop()}`;
  const script = [
    `cp /tmp/opencode-dispatch.sh /Users/juliuswong/Dev/GotchiBot/scripts/opencode-dispatch.sh`,
    `chmod +x /Users/juliuswong/Dev/GotchiBot/scripts/opencode-dispatch.sh`,
    `set -a; source ${q(remoteEnv)}; set +a`,
    `cd /Users/juliuswong/Dev/GotchiBot`,
    `PROMPT=$(cat ${q(remotePrompt)})`,
    `test -n "$PROMPT" || { echo empty_prompt; exit 2; }`,
    `./scripts/opencode-dispatch.sh new --model nim "$PROMPT"`,
    `./scripts/opencode-dispatch.sh list | head -12`,
  ].join("\n");

  r = spawnSync(
    "ssh",
    [
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      key.path,
      `${cfg.user}@${cfg.host}`,
      `bash -lc ${q(script)}`,
    ],
    { encoding: "utf8", timeout: 90000 },
  );
  const scrub = (s) =>
    (s || "")
      .replace(/DISCORD_BOT_TOKEN='[^']*'/g, "DISCORD_BOT_TOKEN='***'")
      .replace(/AARCADE_GOTCHIBOT_SERVICE_SECRET='[^']*'/g, "AARCADE_GOTCHIBOT_SERVICE_SECRET='***'")
      .replace(/NVIDIA_API_KEY='[^']*'/g, "NVIDIA_API_KEY='***'");
  process.stdout.write(scrub(r.stdout));
  process.stderr.write(scrub(r.stderr));
  process.exit(r.status ?? 1);
} finally {
  key.dispose();
  try {
    unlinkSync(localEnv);
  } catch {}
  try {
    unlinkSync(promptFile);
  } catch {}
}
