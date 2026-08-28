#!/usr/bin/env node
/**
 * Push GotchiBot + OpenClaw fleet config to iMac and restart openclaw-gateway.
 *
 *   abra run gotchibot -- node scripts/remote-openclaw-deploy.mjs
 *   node scripts/remote-openclaw-deploy.mjs --no-push   # skip rsync
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLAW_REPO = `${ROOT}/../openclaw`;
const OPENROUTER_DEFAULT_MODEL =
  process.env.GOTCHIBOT_OPENCLAW_MODEL?.trim() ||
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
const CF_FALLBACK_MODEL = "cloudflare-wai/@cf/zai-org/glm-4.7-flash";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function readLocalOpenclawEnv() {
  try {
    return readFileSync(`${OPENCLAW_REPO}/.env`, "utf8");
  } catch {
    return "";
  }
}

function envMatch(envText, key) {
  const m = envText.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

function resolveProviderSecrets(localEnv = readLocalOpenclawEnv()) {
  let gatewayToken = envMatch(localEnv, "OPENCLAW_GATEWAY_TOKEN");
  let cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID || envMatch(localEnv, "CLOUDFLARE_ACCOUNT_ID");
  let cloudflareToken = process.env.CLOUDFLARE_API_TOKEN || envMatch(localEnv, "CLOUDFLARE_API_TOKEN");
  let openrouterKey = process.env.OPENROUTER_API_KEY || envMatch(localEnv, "OPENROUTER_API_KEY");
  if (!gatewayToken) {
    gatewayToken = spawnSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).stdout.trim();
  }
  const explicitModel = process.env.GOTCHIBOT_OPENCLAW_MODEL?.trim();
  let primaryModel = CF_FALLBACK_MODEL;
  if (explicitModel) {
    primaryModel = explicitModel;
  } else if (openrouterKey) {
    primaryModel = OPENROUTER_DEFAULT_MODEL;
  } else if (cloudflareToken && cloudflareAccount) {
    primaryModel = CF_FALLBACK_MODEL;
  }
  return { gatewayToken, cloudflareAccount, cloudflareToken, openrouterKey, primaryModel };
}

function buildOpenclawEnvBody({ openrouterKey, cloudflareAccount, cloudflareToken }) {
  const lines = ["# GotchiBot — provider credentials for OpenClaw gateway"];
  if (openrouterKey) lines.push(`OPENROUTER_API_KEY=${openrouterKey}`);
  if (cloudflareAccount) lines.push(`CLOUDFLARE_ACCOUNT_ID=${cloudflareAccount}`);
  if (cloudflareToken) lines.push(`CLOUDFLARE_API_TOKEN=${cloudflareToken}`);
  lines.push("");
  return lines.join("\n");
}

function runLocal(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
}

async function main() {
  const noPush = process.argv.includes("--no-push");
  const cfg = assertRemoteReady();
  const keyMat = materializeKey(cfg.key);
  const home = `/Users/${cfg.user}`;
  const gotchiDir = cfg.dir;
  const openclawDir = `${home}/Dev/openclaw`;
  const openclawHome = `${home}/.openclaw`;

  try {
    if (!noPush) {
      console.log("→ remote-push (GotchiBot tree)…");
      const push = runLocal("node", [`${ROOT}/scripts/remote-push.mjs`], { stdio: "inherit" });
      if (push.status !== 0) process.exit(push.status ?? 1);
    }

    // Fleet sync on iMac (cartridge heroes → ~/.openclaw/gotchibot-fleet.list.json5).
    console.log("→ openclaw-fleet sync on iMac…");
    const syncCmd = `export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.openclaw/bin:$PATH"; export GOTCHIBOT_OPENCLAW_WORKSPACE="/Users/juliuswong/Dev/GotchiBot"; cd ${shellQuote(gotchiDir)} && node scripts/openclaw-fleet.mjs sync`;
    let r = runSsh(cfg, keyMat.path, syncCmd, { stdio: "pipe" });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      console.error("openclaw-fleet sync failed on iMac (continuing with merge)…");
    }

    // Merge GotchiBot fleet into iMac ~/.openclaw/openclaw.json (preserve gateway/models).
    const secrets = resolveProviderSecrets();
    const { gatewayToken, cloudflareAccount, cloudflareToken, openrouterKey, primaryModel } = secrets;
    if (openrouterKey) {
      console.log(`→ OpenClaw primary model: ${primaryModel} (OpenRouter)`);
    } else {
      console.warn(
        `⚠ OPENROUTER_API_KEY missing — gateway stays on ${CF_FALLBACK_MODEL}. Run: abra set gotchibot OPENROUTER_API_KEY`,
      );
    }

    console.log("→ merge ~/.openclaw/openclaw.json on iMac…");
    const mergeScript = `
set -euo pipefail
OC=${shellQuote(openclawHome)}
GB=${shellQuote(gotchiDir)}
GOTCHIBOT_OPENCLAW_PRIMARY=${shellQuote(primaryModel)}
mkdir -p "$OC"
cp "$OC/openclaw.json" "$OC/openclaw.json.bak-gotchibot-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cat > "$OC/gotchibot.defaults.json5" <<DEF
{
  workspace: "${gotchiDir}",
  thinkingDefault: "off",
}
DEF
export OC GB GOTCHIBOT_OPENCLAW_PRIMARY
node -e "
const fs=require('fs');
const oc=process.env.OC;
const gb=process.env.GB;
const primary=process.env.GOTCHIBOT_OPENCLAW_PRIMARY;
const cfgPath=oc+'/openclaw.json';
let cfg={};
try { cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8')); } catch { cfg={ gateway:{ mode:'local', bind:'lan' } }; }
cfg.agents=cfg.agents||{};
const inc='\\x24include';
cfg.agents.defaults={ ...(cfg.agents.defaults||{}), [inc]:'./gotchibot.defaults.json5', sandbox:{ mode:'off' }, model:{ primary } };
cfg.agents.list={ [inc]:'./gotchibot-fleet.list.json5' };
cfg.messages={ messagePrefix:'[Gotchi] ' };
const modelsPath=gb+'/config/openclaw.gotchibot.models.json';
try {
  const models=JSON.parse(fs.readFileSync(modelsPath,'utf8'));
  cfg.models={ ...(cfg.models||{}), ...models };
} catch (e) {
  console.warn('models merge skipped:', modelsPath, e.message);
}
cfg.meta={ ...(cfg.meta||{}), lastTouchedAt:new Date().toISOString() };
fs.writeFileSync(cfgPath, JSON.stringify(cfg,null,2)+'\\n');
console.log('merged', cfgPath, 'primary='+primary);
"
`.trim();
    r = runSsh(cfg, keyMat.path, `bash -lc ${shellQuote(mergeScript)}`, { stdio: "pipe" });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      console.error("config merge failed");
      process.exit(r.status ?? 1);
    }

    const envBody = buildOpenclawEnvBody({ openrouterKey, cloudflareAccount, cloudflareToken });
    if (envBody.trim()) {
      console.log("→ write ~/.openclaw/.env (provider credentials)…");
      const envScript = `
set -euo pipefail
OC=${shellQuote(openclawHome)}
umask 077
cat > "$OC/.env" <<'GOTCHIENV'
${envBody}GOTCHIENV
chmod 600 "$OC/.env"
echo wrote "$OC/.env"
`.trim();
      r = runSsh(cfg, keyMat.path, `bash -lc ${shellQuote(envScript)}`, { stdio: "pipe" });
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    } else {
      console.warn("⚠ No provider credentials — set OPENROUTER_API_KEY and/or Cloudflare vars in abra");
    }

    // Docker extra mount + bootstrap openclaw repo if needed, then restart gateway.
    console.log("→ openclaw docker on iMac (bootstrap if needed) + restart gateway…");

    const dockerScript = `
set -euo pipefail
OC_DIR=${shellQuote(openclawDir)}
GB=${shellQuote(gotchiDir)}
OC_HOME=${shellQuote(openclawHome)}
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/bin/docker:$PATH"

if [ ! -d "$OC_DIR" ]; then
  echo "cloning openclaw → $OC_DIR"
  mkdir -p "$(dirname "$OC_DIR")"
  git clone --depth 1 https://github.com/openclaw/openclaw.git "$OC_DIR"
fi

mkdir -p "$OC_HOME/workspace" "\${OC_HOME}-auth-profile-secrets"

cat > "$OC_DIR/.env" <<ENV
OPENCLAW_CONFIG_DIR=$OC_HOME
OPENCLAW_WORKSPACE_DIR=$OC_HOME/workspace
OPENCLAW_AUTH_PROFILE_SECRET_DIR=\${OC_HOME}-auth-profile-secrets
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=${gatewayToken}
OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
OPENCLAW_EXTRA_MOUNTS=${gotchiDir}:${gotchiDir}:rw
OPENCLAW_SKIP_ONBOARDING=1
OPENROUTER_API_KEY=${openrouterKey}
CLOUDFLARE_ACCOUNT_ID=${cloudflareAccount}
CLOUDFLARE_API_TOKEN=${cloudflareToken}
ENV

cat > "$OC_DIR/docker-compose.extra.yml" <<YAML
services:
  openclaw-gateway:
    volumes:
      - ${gotchiDir}:${gotchiDir}:rw
  openclaw-cli:
    volumes:
      - ${gotchiDir}:${gotchiDir}:rw
YAML
cd "$OC_DIR"
docker compose -f docker-compose.yml -f docker-compose.extra.yml pull openclaw-gateway 2>/dev/null || true
docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d --force-recreate openclaw-gateway
sleep 15
curl -sf --max-time 8 http://127.0.0.1:18789/healthz && echo " gateway healthy"
docker compose -f docker-compose.yml -f docker-compose.extra.yml ps openclaw-gateway
`.trim();
    r = runSsh(cfg, keyMat.path, `bash -lc ${shellQuote(dockerScript)}`, { stdio: "pipe" });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      console.error("gateway restart failed");
      process.exit(r.status ?? 1);
    }

    console.log("");
    console.log(`iMac OpenClaw deploy complete (${cfg.host}).`);
    console.log(`  GotchiBot: ${gotchiDir}`);
    console.log(`  Gateway:   http://${cfg.host}:18789/healthz`);
    console.log(`  Model:     ${primaryModel}`);
    console.log("");
    console.log("Point MBP at iMac gateway (optional):");
    console.log(`  export GOTCHIBOT_OPENCLAW_URL=http://${cfg.host}:18789`);
  } finally {
    keyMat.dispose();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
