#!/usr/bin/env node
/**
 * Probe subgraph.aarcadeghst.com (Cloudflare tunnel → iMac :8787).
 *
 *   node scripts/tunnel-health.mjs
 *   node scripts/tunnel-health.mjs --json
 *   node scripts/tunnel-health.mjs --remote   # also check iMac localhost :8787 via SSH
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const json = process.argv.includes("--json");
const remote = process.argv.includes("--remote");

const proxyKey = (process.env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || process.env.SUBGRAPH_PROXY_SECRET || "").trim();

function headers() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (proxyKey) h[cfg.auth?.header || "X-Subgraph-Proxy-Key"] = proxyKey;
  return h;
}

async function probeUrl(label, url) {
  const started = Date.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12_000);
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
      signal: ac.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        label,
        url,
        ok: false,
        status: res.status,
        latencyMs: Date.now() - started,
        error: text.includes("Cloudflare Tunnel error")
          ? "Cloudflare tunnel down (HTTP 530)"
          : `non-JSON HTTP ${res.status}`,
      };
    }
    const block = body?.data?._meta?.block?.number;
    // A JSON 401/403 is the iMac proxy answering through the tunnel: the tunnel is up,
    // the data just needs a key. Keyless is expected off-abra; a rejected key is a real failure.
    const authRequired = res.status === 401 || res.status === 403;
    return {
      label,
      url,
      ok: Boolean(res.ok && body?.data?._meta),
      tunnelUp: true,
      authRequired,
      keySent: Boolean(proxyKey),
      status: res.status,
      latencyMs: Date.now() - started,
      block: block ?? null,
      indexingErrors: body?.data?._meta?.hasIndexingErrors ?? null,
      error: body.errors?.[0]?.message ?? null,
    };
  } catch (e) {
    return {
      label,
      url,
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      error: e?.name === "AbortError" ? "timeout" : String(e.message || e),
    };
  }
}

function probeRemoteLocal() {
  const r = spawnSync(
    process.execPath,
    [`${ROOT}/scripts/remote-ssh.mjs`, "--", "curl", "-sS", "-m", "8", "-X", "POST",
      "http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base",
      "-H", "Content-Type: application/json",
      "-d", '{"query":"{ _meta { block { number } } }"}'],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "ssh failed").trim().slice(0, 200) };
  }
  try {
    const body = JSON.parse(r.stdout.trim());
    return {
      ok: Boolean(body?.data?._meta),
      block: body?.data?._meta?.block?.number ?? null,
      raw: r.stdout.trim().slice(0, 120),
    };
  } catch {
    return { ok: false, error: r.stdout.trim().slice(0, 200) };
  }
}

/** The home tunnel itself: a plain health URL it serves (default: the Mongo proxy). */
function homeTunnelUrl(c = cfg) {
  if (c?.tunnelHealth) return String(c.tunnelHealth);
  const mongo = c?.identityLayer?.mongoProxy;
  return mongo ? `${String(mongo).replace(/\/+$/, "")}/health` : null;
}

async function probeHome(url) {
  if (!url) return { ok: false, url: null, status: null, error: "no tunnelHealth / identityLayer.mongoProxy in config" };
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, url, status: res.status, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, url, status: null, latencyMs: Date.now() - t0, error: String(e?.cause?.code || e?.message || e).slice(0, 120) };
  }
}

async function main() {
  // "tun" is the home Cloudflare tunnel. It used to be judged by the mainnet
  // core subgraph, which is retired (Base Sepolia only) — its 502 marked a
  // healthy tunnel down. The subgraph probe stays as information only.
  const home = await probeHome(homeTunnelUrl());
  const coreUrl = cfg.subgraphs?.["aavegotchi-core-base"]?.url;
  const publicProbe = coreUrl ? await probeUrl("aavegotchi-core-base", coreUrl) : null;
  const tunnelOk = home.ok;
  const out = {
    checkedAt: new Date().toISOString(),
    gateway: cfg.gateway,
    ok: Boolean(tunnelOk),
    home,
    public: publicProbe,
    subgraphNote: "mainnet subgraph (retired) — informational",
    localImac: null,
  };

  if (remote) {
    out.localImac = probeRemoteLocal();
    if (!tunnelOk && out.localImac.ok) {
      out.diagnosis = "iMac subgraph proxy is up but Cloudflare tunnel is down — restart cloudflared on iMac";
    } else if (!tunnelOk && !out.localImac.ok) {
      out.diagnosis = "iMac subgraph proxy and tunnel both failing — check Docker monolith on iMac";
    }
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`home tunnel: ${home.ok ? "ok" : "DOWN"}  HTTP ${home.status ?? "?"}  ${home.latencyMs ?? "?"}ms  ${home.url || ""}`);
    if (home.error) console.log(`  error: ${home.error}`);
    if (publicProbe) {
      const tag = publicProbe.ok ? "ok" : publicProbe.authRequired && !publicProbe.keySent ? "up (auth required)" : "down";
      console.log(`mainnet subgraph (retired, info only): ${tag}  HTTP ${publicProbe.status ?? "?"}`);
    }
    if (out.localImac) {
      console.log(`iMac localhost:8787: ${out.localImac.ok ? "ok" : "DOWN"}`);
      if (out.localImac.error) console.log(`  error: ${out.localImac.error}`);
    }
    if (out.diagnosis) console.log(`\n${out.diagnosis}`);
    if (!tunnelOk) {
      console.log("\nfix: abra run gotchibot -- ./scripts/gotchibot tunnel restart");
    }
  }

  process.exit(tunnelOk ? 0 : 1);
}

main();
