#!/usr/bin/env node
/**
 * Model ref of the OpenCode session the chat pane is actually attached to.
 * Hub desk: sessions/.project-current → Hub desk session → OpenCode /session.
 * Prints nothing when no live session model is known (status bar keeps its pins).
 *
 *   node scripts/live-chat-model.mjs
 *   GOTCHIBOT_STATUS_ROOT=/tmp/tree node scripts/live-chat-model.mjs
 *   GOTCHIBOT_LIVE_MODEL_JSON='{"providerID":"p","id":"m"}' node scripts/live-chat-model.mjs
 *   node scripts/live-chat-model.mjs --last-known   # last model the Hub's session reported (any age)
 *
 * The chat pane records what it actually launched in sessions/.chat-backend
 * ("hub <slug>" or "local"). In a local chat the Hub session's model is not the
 * chat's model, so nothing is printed and the status bar shows the local pin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;
const OPENCODE_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;
const SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const CACHE_TTL_MS = 15_000;
const CACHE_STALE_OK_MS = 45_000;

export function formatSessionModel(model) {
  if (model == null) return "";
  if (typeof model === "string") {
    const text = model.trim();
    if (!text) return "";
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return formatSessionModel(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  }
  if (typeof model !== "object") return "";
  const provider = String(model.providerID || model.provider || "").trim();
  const id = String(model.id || model.modelID || "").trim();
  if (!id) return provider;
  if (!provider || id.startsWith(`${provider}/`)) return id;
  return `${provider}/${id}`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function curlSession(url) {
  const result = spawnSync("curl", ["-sf", "--max-time", "2", url], {
    encoding: "utf8",
    timeout: 4000,
  });
  if (result.status !== 0) return null;
  return result.stdout || "";
}

/** Fetch an OpenCode session's model. Local curl, or ssh when the desk repo is remote. */
export function defaultReadSession({ sessionId, opencodeUrl, repoDir, ssh, root }) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return null;
  const base = String(opencodeUrl || "").replace(/\/$/, "");
  if (!OPENCODE_URL_RE.test(base)) return null;
  const url = `${base}/session/${sessionId}`;
  const stdout =
    repoDir && root && sameDir(repoDir, root)
      ? curlSession(url)
      : SSH_RE.test(String(ssh || ""))
        ? sshCurl(ssh, url)
        : null;
  if (!stdout) return null;
  try {
    const body = JSON.parse(stdout);
    return body?.model ?? null;
  } catch {
    return null;
  }
}

function sshCurl(ssh, url) {
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", ssh, `curl -sf --max-time 2 ${shellQuote(url)}`],
    { encoding: "utf8", timeout: 8000 },
  );
  if (result.status !== 0) return null;
  return result.stdout || "";
}

function cachePath(root) {
  return resolve(root, "sessions/.live-chat-model.json");
}

/** What the chat pane launched: { mode: "hub" | "local", slug } or null (unknown/older pane). */
export function chatBackend(root = SCRIPT_ROOT) {
  try {
    const [mode, slug = ""] = readFileSync(resolve(root, "sessions/.chat-backend"), "utf8").trim().split(/\s+/);
    return mode === "hub" || mode === "local" ? { mode, slug } : null;
  } catch {
    return null;
  }
}

/**
 * The model the Hub's desk session last reported, however old — the Hub is the
 * source of truth for the model, so a local fallback chat starts on it.
 */
export function lastKnownHubModel(root = SCRIPT_ROOT) {
  const cache = readJson(cachePath(root));
  const model = cache?.model ? formatSessionModel(cache.model) : "";
  // A /local reroute (desk/<tool>, @claudemode) is not the Hub's model.
  return /^(desk|claudemode)\//.test(model) ? "" : model;
}

function cachedModel(cache, sessionId, maxAge) {
  if (!cache?.model) return "";
  if (sessionId && cache.sessionId !== sessionId) return "";
  const age = Date.now() - Number(cache.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age >= maxAge) return "";
  return formatSessionModel(cache.model);
}

function writeCache(root, sessionId, model) {
  try {
    mkdirSync(resolve(root, "sessions"), { recursive: true });
    writeFileSync(
      cachePath(root),
      `${JSON.stringify({ model, sessionId, fetchedAt: Date.now() }, null, 2)}\n`,
    );
  } catch {
    /* status bar still prints the model this pass */
  }
}

async function defaultHubRequest() {
  const { hubRequest } = await import("./chat-hub-client.mjs");
  return hubRequest;
}

/**
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, hubRequest?: Function, readSession?: Function }} [opts]
 * @returns {Promise<string>} provider/id, or "" when no live session model exists
 */
export async function resolveLiveChatModel({
  root = SCRIPT_ROOT,
  env = process.env,
  hubRequest,
  readSession,
} = {}) {
  const override = env.GOTCHIBOT_LIVE_MODEL_JSON;
  if (override != null && String(override).trim() !== "") {
    const raw = String(override);
    if (existsSync(raw)) return formatSessionModel(readFileSync(raw, "utf8"));
    return formatSessionModel(raw);
  }

  if (chatBackend(root)?.mode === "local") return "";

  let slug = "";
  try {
    slug = readFileSync(resolve(root, "sessions/.project-current"), "utf8").trim();
  } catch {
    return "";
  }
  if (!slug) return "";

  const cache = readJson(cachePath(root));
  let desk;
  try {
    const request = hubRequest || (await defaultHubRequest());
    desk = await request("GET", `/api/gotchibot/projects/${encodeURIComponent(slug)}/desk`);
  } catch {
    return cachedModel(cache, "", CACHE_STALE_OK_MS);
  }

  const sessionId = String(desk?.sessionId || "");
  const opencodeUrl = String(desk?.opencodeUrl || "");
  if (!sessionId || !opencodeUrl) return "";

  const fresh = cachedModel(cache, sessionId, CACHE_TTL_MS);
  if (fresh) return fresh;

  const ssh = readJson(resolve(root, "sessions/.hub-desk.json"))?.ssh || "";
  const reader = readSession || ((opts) => defaultReadSession({ ...opts, root }));
  let model = null;
  try {
    model = await reader({
      sessionId,
      opencodeUrl,
      repoDir: desk.repoDir,
      ssh,
      root,
    });
  } catch {
    model = null;
  }
  const formatted = formatSessionModel(model);
  if (formatted) {
    writeCache(root, sessionId, formatted);
    return formatted;
  }
  return cachedModel(cache, sessionId, CACHE_STALE_OK_MS);
}

function rootFromEnv(env = process.env) {
  return env.GOTCHIBOT_STATUS_ROOT ? resolve(env.GOTCHIBOT_STATUS_ROOT) : SCRIPT_ROOT;
}

if (isMainModule(import.meta.url)) {
  const model = process.argv.includes("--last-known")
    ? lastKnownHubModel(rootFromEnv())
    : await resolveLiveChatModel({ root: rootFromEnv() });
  if (model) process.stdout.write(model);
}
