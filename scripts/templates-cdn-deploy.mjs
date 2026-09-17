#!/usr/bin/env node
/**
 * Deploy the bot-template marketplace CDN origin on the Hub iMac and print
 * (or attempt) Cloudflare Public Hostname wiring for templates.aarcadeghst.com.
 *
 *   abra run gotchibot -- node scripts/templates-cdn-deploy.mjs deploy [--yes]
 *   abra run gotchibot -- node scripts/templates-cdn-deploy.mjs status
 *   abra run gotchibot -- node scripts/templates-cdn-deploy.mjs undeploy [--yes]
 *
 * Origin: http://127.0.0.1:8793 → templates/marketplace/
 * Public: https://templates.aarcadeghst.com  (Cloudflare Zero Trust tunnel hostname)
 *
 * The Hub cloudflared runs with a remotely-managed --token (not local config.yml
 * ingress). DNS for templates.* currently hits Vercel (404 DEPLOYMENT_NOT_FOUND).
 * After the origin is up, add a Public Hostname in Zero Trust (or CF API with a
 * token that can edit tunnels + DNS) pointing at http://localhost:8793.
 *
 * Never prints secrets. No npm install.
 */
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTNAME = "templates.aarcadeghst.com";
const PORT = 8793;
const LABEL = "com.gotchibot.templates-cdn";
const PLIST = `~/Library/LaunchAgents/${LABEL}.plist`;

function usage() {
  console.log(`templates-cdn-deploy — marketplace CDN on home infra

  deploy [--yes]     sync packs, install LaunchAgent on iMac :${PORT}, print CF steps
  status             local origin + public HTTPS probe
  undeploy [--yes]   unload LaunchAgent (origin only; does not touch Cloudflare DNS)

Public hostname: https://${HOSTNAME}
Origin:          http://127.0.0.1:${PORT}  →  templates/marketplace/
`);
}

function runLocal(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
}

function rsyncMarketplace(cfg, keyPath) {
  const remote = `${cfg.user}@${cfg.host}:${cfg.dir.replace(/\/$/, "")}/`;
  const r = spawnSync(
    "rsync",
    [
      "-az",
      "--delete",
      "-e",
      `ssh -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${keyPath}`,
      "templates/marketplace/",
      `${remote}templates/marketplace/`,
      "scripts/templates-cdn-serve.mjs",
      `${remote}scripts/`,
    ],
    { encoding: "utf8" },
  );
  // rsync with mixed file+dir dest is awkward — do two calls
  return r;
}

function rsyncPaths(cfg, keyPath) {
  const remoteRoot = `${cfg.user}@${cfg.host}:${cfg.dir.replace(/\/$/, "")}`;
  const ssh = `ssh -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${keyPath}`;
  const steps = [
    ["templates/marketplace/", `${remoteRoot}/templates/marketplace/`],
    ["scripts/templates-cdn-serve.mjs", `${remoteRoot}/scripts/templates-cdn-serve.mjs`],
  ];
  for (const [src, dest] of steps) {
    const r = spawnSync("rsync", ["-az", "--delete", "-e", ssh, src, dest], {
      encoding: "utf8",
      cwd: ROOT,
    });
    if (r.status !== 0) {
      console.error(`rsync failed ${src}:`, r.stderr || r.stdout);
      return false;
    }
    console.log(`synced ${src}`);
  }
  return true;
}

function plistBody(cfg) {
  const dir = cfg.dir.replace(/\/$/, "");
  const node = "/usr/local/bin/node";
  const script = `${dir}/scripts/templates-cdn-serve.mjs`;
  const logDir = `${dir}/sessions/templates-cdn-logs`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>--root</string>
    <string>${dir}/templates/marketplace</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${dir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/out.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function printCloudflareSteps() {
  console.log(`
=== Cloudflare Zero Trust (required once) ===
${HOSTNAME} currently resolves to Vercel (x-vercel-error: DEPLOYMENT_NOT_FOUND).
Point it at the home tunnel:

1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels
   → the Hub tunnel (UserDefaultTunnel / token-managed cloudflared on the iMac)
2. Public Hostname → Add:
     Subdomain:  templates
     Domain:     aarcadeghst.com
     Path:       (empty)
     Service:    http://localhost:${PORT}
3. Save. Cloudflare should create/update DNS for ${HOSTNAME}
   away from Vercel toward the tunnel.
4. Verify:
     curl -sS https://${HOSTNAME}/catalog.json | head
     curl -sS -o /dev/null -w '%{http_code}\\n' https://${HOSTNAME}/web/

Cache: Cloudflare edge will CDN-cache GETs (origin sends Cache-Control: public, max-age=60).
`);
}

async function tryCloudflareHint() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  if (!account || !token) {
    console.log("CF API: no CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in env (abra). Skipping API attempt.");
    return;
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const tunnels = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel?is_deleted=false`,
      { headers },
    ).then((r) => r.json());
    const n = tunnels.result?.length ?? 0;
    console.log(`CF API tunnels visible to this token: ${n}${tunnels.success ? "" : " (call failed)"}`);
    if (!n) {
      console.log(
        "This abra CLOUDFLARE_API_TOKEN cannot list tunnels/zones — add the Public Hostname in the dashboard (steps above), or mint a token with Account Cloudflare Tunnel Edit + Zone DNS Edit for aarcadeghst.com.",
      );
    }
  } catch (e) {
    console.log(`CF API probe failed: ${e.message}`);
  }
}

function cmdDeploy({ yes }) {
  if (!yes && process.env.GOTCHIBOT_AUTO_APPROVE !== "1") {
    console.error("deploy: pass --yes (writes LaunchAgent + restarts origin on the iMac)");
    process.exit(2);
  }
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);

  if (!existsSync(join(ROOT, "templates/marketplace/catalog.json"))) {
    console.error("missing templates/marketplace/catalog.json — run gotchibot templates pack first");
    key.dispose();
    process.exit(1);
  }

  console.log(`deploy → ${cfg.user}@${cfg.host}:${cfg.dir}`);
  if (!rsyncPaths(cfg, key.path)) {
    key.dispose();
    process.exit(1);
  }

  const plist = plistBody(cfg);
  const remote = `
set -e
mkdir -p "${cfg.dir.replace(/\/$/, "")}/sessions/templates-cdn-logs"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/${LABEL}.plist" << 'PLIST_EOF'
${plist}
PLIST_EOF
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl kickstart "gui/$(id -u)/${LABEL}"
sleep 1
curl -sS -m 3 -o /dev/null -w "origin_catalog:%{http_code}\\n" http://127.0.0.1:${PORT}/catalog.json || echo "origin_catalog:fail"
curl -sS -m 3 -o /dev/null -w "origin_web:%{http_code}\\n" http://127.0.0.1:${PORT}/web/ || echo "origin_web:fail"
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | head -20 || true
`;

  console.log("installing LaunchAgent on iMac…");
  const r = runSsh(cfg, key.path, remote, { stdio: "pipe" });
  console.log(r.stdout || "");
  if (r.status !== 0) {
    console.error(r.stderr || "ssh failed");
    key.dispose();
    process.exit(r.status || 1);
  }
  key.dispose();

  printCloudflareSteps();
  return tryCloudflareHint();
}

function cmdUndeploy({ yes }) {
  if (!yes && process.env.GOTCHIBOT_AUTO_APPROVE !== "1") {
    console.error("undeploy: pass --yes");
    process.exit(2);
  }
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  const remote = `
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"
echo "origin LaunchAgent removed (${LABEL})"
echo "Cloudflare Public Hostname / DNS for ${HOSTNAME} left untouched — remove in Zero Trust if desired."
`;
  const r = runSsh(cfg, key.path, remote, { stdio: "pipe" });
  console.log(r.stdout || "");
  key.dispose();
}

async function cmdStatus() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  const remote = `
echo "=== LaunchAgent ==="
launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | head -15 || echo "not loaded"
echo "=== origin ==="
curl -sS -m 3 -o /dev/null -w "catalog:%{http_code}\\n" http://127.0.0.1:${PORT}/catalog.json || echo "catalog:down"
curl -sS -m 3 http://127.0.0.1:${PORT}/catalog.json 2>/dev/null | head -c 200; echo
`;
  const r = runSsh(cfg, key.path, remote, { stdio: "pipe" });
  console.log(r.stdout || "");
  key.dispose();

  console.log("=== public ===");
  try {
    const res = await fetch(`https://${HOSTNAME}/catalog.json`, {
      signal: AbortSignal.timeout(8000),
    });
    const ct = res.headers.get("content-type") || "";
    const vercel = res.headers.get("x-vercel-error") || "";
    console.log(`https://${HOSTNAME}/catalog.json → ${res.status} (${ct})${vercel ? ` vercel=${vercel}` : ""}`);
    if (res.ok) {
      const j = await res.json();
      console.log(`packs: ${(j.packs || []).map((p) => p.id).join(", ") || "(none)"}`);
    } else {
      const text = await res.text();
      console.log(text.slice(0, 160).replace(/\s+/g, " "));
      if (vercel || /DEPLOYMENT_NOT_FOUND|Vercel/i.test(text)) {
        console.log("Still on Vercel — finish Zero Trust Public Hostname steps from deploy.");
      }
    }
  } catch (e) {
    console.log(`public probe failed: ${e.message}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const yes = rest.includes("--yes");
  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd ? 0 : 2);
  }
  switch (cmd) {
    case "deploy":
      await cmdDeploy({ yes });
      break;
    case "status":
      await cmdStatus();
      break;
    case "undeploy":
      cmdUndeploy({ yes });
      break;
    default:
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
