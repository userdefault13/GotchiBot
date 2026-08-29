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

function headers() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  const key = (process.env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || process.env.SUBGRAPH_PROXY_SECRET || "").trim();
  if (key) h[cfg.auth?.header || "X-Subgraph-Proxy-Key"] = key;
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
    return {
      label,
      url,
      ok: res.ok && body?.data?._meta,
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

async function main() {
  const coreUrl = cfg.subgraphs["aavegotchi-core-base"].url;
  const publicProbe = await probeUrl("aavegotchi-core-base", coreUrl);
  const out = {
    checkedAt: new Date().toISOString(),
    gateway: cfg.gateway,
    public: publicProbe,
    localImac: null,
  };

  if (remote) {
    out.localImac = probeRemoteLocal();
    if (!publicProbe.ok && out.localImac.ok) {
      out.diagnosis = "iMac subgraph proxy is up but Cloudflare tunnel is down — restart cloudflared on iMac";
    } else if (!publicProbe.ok && !out.localImac.ok) {
      out.diagnosis = "iMac subgraph proxy and tunnel both failing — check Docker monolith on iMac";
    }
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const tag = publicProbe.ok ? "ok" : "DOWN";
    console.log(`subgraph tunnel: ${tag}  HTTP ${publicProbe.status ?? "?"}  ${publicProbe.latencyMs}ms`);
    if (publicProbe.block != null) console.log(`  core block: ${publicProbe.block}`);
    if (publicProbe.error) console.log(`  error: ${publicProbe.error}`);
    if (out.localImac) {
      console.log(`iMac localhost:8787: ${out.localImac.ok ? "ok" : "DOWN"}`);
      if (out.localImac.error) console.log(`  error: ${out.localImac.error}`);
    }
    if (out.diagnosis) console.log(`\n${out.diagnosis}`);
    if (!publicProbe.ok) {
      console.log("\nfix: abra run gotchibot -- ./scripts/gotchibot tunnel restart");
    }
  }

  process.exit(publicProbe.ok ? 0 : 1);
}

main();
