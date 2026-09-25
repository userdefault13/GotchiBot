#!/usr/bin/env node
/**
 * Aarcade Host Network desk CLI — provider host agent + renter slots.
 *
 *   gotchibot host register|run|status
 *   gotchibot slots submit|status <jobId>
 *
 * Bodies never go to Arcade — only hashes + artifact URLs.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  createWriteStream,
  createReadStream,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { isMainModule } from "./is-main.mjs";
import { infraHeaders, soloApiBase, hasInstallToken } from "./infra-client.mjs";
import { PORTS } from "./lib/ports.mjs";
import { cpus, totalmem, freemem } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const PROVIDER_PIN = join(SESSIONS, ".host-provider.json");
const ARTIFACT_ROOT = join(SESSIONS, "host-artifacts");
const JOBS_ROOT = join(SESSIONS, "host-jobs");
const INSTALL_ID_PATH = join(SESSIONS, ".install-id");

function readInstallId() {
  if (!existsSync(INSTALL_ID_PATH)) {
    throw new Error("no install id — run: gotchibot infra register");
  }
  return readFileSync(INSTALL_ID_PATH, "utf8").trim();
}

function readProviderPin() {
  try {
    return JSON.parse(readFileSync(PROVIDER_PIN, "utf8"));
  } catch {
    return null;
  }
}

function writeProviderPin(provider) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(
    PROVIDER_PIN,
    `${JSON.stringify({ ...provider, writtenAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function api(method, path, { body } = {}) {
  if (!hasInstallToken()) {
    throw new Error("GOTCHIBOT_INFRA_TOKEN required — run gotchibot infra register / onboard");
  }
  const base = soloApiBase();
  const headers = { ...infraHeaders(), "Content-Type": "application/json" };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function sha256Hex(buf) {
  return `0x${createHash("sha256").update(buf).digest("hex")}`;
}

function parseAds(argv) {
  const ads = { slots: true, hubCapable: false, cpu: cpus().length, ramMb: Math.round(totalmem() / 1024 / 1024), diskGb: 20 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cpu" && argv[i + 1]) ads.cpu = Number(argv[++i]);
    if (argv[i] === "--ram-mb" && argv[i + 1]) ads.ramMb = Number(argv[++i]);
    if (argv[i] === "--disk-gb" && argv[i + 1]) ads.diskGb = Number(argv[++i]);
    if (argv[i] === "--label" && argv[i + 1]) ads._label = argv[++i];
  }
  return ads;
}

async function cmdHostRegister(argv) {
  const ads = parseAds(argv);
  const label = ads._label;
  delete ads._label;
  const out = await api("POST", "/api/gotchibot/host/register", {
    body: { label, ads },
  });
  writeProviderPin(out.provider);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdHostStatus() {
  const pin = readProviderPin();
  const me = await api("GET", "/api/gotchibot/host/me");
  console.log(JSON.stringify({ pin, me }, null, 2));
}

/**
 * Local artifact HTTP for SIM / same-machine dogfood.
 * GET/PUT /a/:token
 */
function ensureLocalArtifactServer() {
  const port = Number(process.env.GOTCHIBOT_HOST_ARTIFACT_PORT || PORTS.HOST_ARTIFACT);
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const server = createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const m = u.pathname.match(/^\/a\/([a-zA-Z0-9_-]+)$/);
    if (!m) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const file = join(ARTIFACT_ROOT, m[1]);
    if (req.method === "PUT") {
      await pipeline(req, createWriteStream(file));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET") {
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      resolvePromise({
        port,
        putUrl: (token) => `http://127.0.0.1:${port}/a/${token}`,
        getUrl: (token) => `http://127.0.0.1:${port}/a/${token}`,
        close: () => server.close(),
      });
    });
  });
}

async function fetchArtifact(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`artifact GET ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function putArtifact(url, buf) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
  if (!res.ok && res.status !== 204) throw new Error(`artifact PUT ${res.status}`);
}

async function runOneJob(job) {
  mkdirSync(JOBS_ROOT, { recursive: true });
  const dir = join(JOBS_ROOT, job.jobId);
  mkdirSync(dir, { recursive: true });
  try {
    const promptBuf = await fetchArtifact(job.artifactGetUrl);
    writeFileSync(join(dir, "prompt.bin"), promptBuf);
    // Supervisor stub: echo hash + acknowledgment (work tools plug in later)
    const result = Buffer.from(
      JSON.stringify({
        ok: true,
        jobId: job.jobId,
        promptHash: job.promptHash,
        note: "host-agent stub — replace with work-tool spawn",
        at: new Date().toISOString(),
      }),
      "utf8",
    );
    writeFileSync(join(dir, "result.json"), result);
    await putArtifact(job.artifactPutUrl, result);
    const resultHash = sha256Hex(result);
    return { status: "done", resultHash };
  } catch (err) {
    return { status: "failed", error: err.message || String(err) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* wipe best-effort */
    }
  }
}

async function cmdHostRun(argv) {
  let pin = readProviderPin();
  if (!pin?.providerId) {
    await cmdHostRegister(argv);
    pin = readProviderPin();
  }
  const once = argv.includes("--once");
  const intervalMs = Number(process.env.GOTCHIBOT_HOST_POLL_MS || 5000);
  console.log(`host run providerId=${pin.providerId} once=${once}`);

  async function tick() {
    const load = Math.round((1 - freemem() / totalmem()) * 100);
    await api("POST", "/api/gotchibot/host/heartbeat", {
      body: { providerId: pin.providerId, load },
    });
    const claimed = await api("POST", "/api/gotchibot/slots/claim", {
      body: { providerId: pin.providerId },
    });
    if (!claimed.job) {
      console.log(`[${new Date().toISOString()}] idle`);
      return false;
    }
    console.log(`[${new Date().toISOString()}] claimed ${claimed.job.jobId}`);
    const outcome = await runOneJob(claimed.job);
    const done = await api("POST", "/api/gotchibot/slots/complete", {
      body: {
        providerId: pin.providerId,
        jobId: claimed.job.jobId,
        status: outcome.status,
        resultHash: outcome.resultHash,
        error: outcome.error,
      },
    });
    console.log(JSON.stringify(done, null, 2));
    return true;
  }

  if (once) {
    await tick();
    return;
  }
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("host tick error:", err.message || err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function cmdSlotsSubmit(argv) {
  const prompt = argv.filter((a) => !a.startsWith("--")).join(" ") || "ping";
  const sim = argv.includes("--sim") || process.env.GOTCHIBOT_HOST_NETWORK_SIM === "1";
  const promptBuf = Buffer.from(prompt, "utf8");
  const promptHash = sha256Hex(promptBuf);

  let artifactPutUrl;
  let artifactGetUrl;
  let server;
  const putIdx = argv.indexOf("--artifact-put");
  const getIdx = argv.indexOf("--artifact-get");
  if (putIdx >= 0 && getIdx >= 0) {
    artifactPutUrl = argv[putIdx + 1];
    artifactGetUrl = argv[getIdx + 1];
  } else {
    server = await ensureLocalArtifactServer();
    const token = `t_${randomBytes(8).toString("hex")}`;
    artifactPutUrl = server.putUrl(token);
    artifactGetUrl = server.getUrl(token);
    // Seed GET body (same URL for local SIM)
    await putArtifact(artifactGetUrl, promptBuf);
  }

  const body = {
    artifactPutUrl,
    artifactGetUrl,
    promptHash,
    maxCoreMinutes: 30,
    priceGhstWei: "0",
    sim: true,
  };
  if (argv.includes("--escrow-tx")) {
    const i = argv.indexOf("--escrow-tx");
    body.escrowTx = argv[i + 1];
    body.sim = false;
  } else if (!sim && process.env.GOTCHIBOT_HOST_NETWORK_SIM !== "1") {
    body.sim = Boolean(sim);
  }

  const out = await api("POST", "/api/gotchibot/slots/enqueue", { body });
  console.log(JSON.stringify(out, null, 2));
  if (server && argv.includes("--keep-artifact-server")) {
    console.log(`artifact server on :${server.port} (Ctrl+C to stop)`);
    await new Promise(() => {});
  } else if (server) {
    // keep briefly so host can fetch
    setTimeout(() => server.close(), 60_000);
  }
}

async function cmdSlotsStatus(jobId) {
  if (!jobId) throw new Error("usage: gotchibot slots status <jobId>");
  const out = await api("GET", `/api/gotchibot/slots/${encodeURIComponent(jobId)}`);
  console.log(JSON.stringify(out, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const [group, cmd, ...rest] = argv;
  if (group === "host") {
    if (cmd === "register") return cmdHostRegister(rest);
    if (cmd === "status") return cmdHostStatus();
    if (cmd === "run") return cmdHostRun(rest);
    throw new Error("usage: gotchibot host register|run|status");
  }
  if (group === "slots") {
    if (cmd === "submit") return cmdSlotsSubmit(rest);
    if (cmd === "status") return cmdSlotsStatus(rest[0]);
    throw new Error("usage: gotchibot slots submit|status <jobId>");
  }
  throw new Error("usage: gotchibot host … | gotchibot slots …");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { main, sha256Hex };
