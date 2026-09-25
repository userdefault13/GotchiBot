/**
 * Hub-side phone reply runner — claims pending phone messages and writes
 * assistant replies via the same OpenCode CLI path the desk uses.
 *
 * Secrets: never read vault files. Run under `abra run gotchibot -- …` so
 * provider keys are injected into the env. Presence-only key checks; never
 * log values.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "../../scripts/chat-canonical.mjs";
import { isModelLimitError } from "../../scripts/model-fallback.mjs";
import { completeWithPolicy } from "../../scripts/model-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Same presence list as scripts/colabo.mjs hasKeys. */
export const PROVIDER_KEY_NAMES = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
];

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Gotchi, GotchiBot's assistant, replying to UserDefault from their phone.",
  "Be concise and use mobile-friendly markdown.",
  "Plain chat only — no tools, no shell, no file edits.",
].join(" ");

/** Verified against https://opencode.ai/config.json (AgentConfig.permission / PermissionConfig) for 1.18.x. */
export const HUB_REPLY_OPENCODE_JSON = {
  $schema: "https://opencode.ai/config.json",
  default_agent: "hub-reply",
  agent: {
    "hub-reply": {
      description: "Plain phone chat reply — no tools",
      mode: "primary",
      steps: 1,
      permission: {
        read: "deny",
        edit: "deny",
        glob: "deny",
        grep: "deny",
        list: "deny",
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "deny",
        skill: "deny",
        doom_loop: "deny",
      },
    },
  },
  permission: {
    read: "deny",
    edit: "deny",
    glob: "deny",
    grep: "deny",
    list: "deny",
    bash: "deny",
    task: "deny",
    external_directory: "deny",
    todowrite: "deny",
    question: "deny",
    webfetch: "deny",
    websearch: "deny",
    lsp: "deny",
    skill: "deny",
    doom_loop: "deny",
  },
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\/g;
const HEADER_RE = /^\s*>\s+.+\s+[·•]\s+.+\s*$/;

/**
 * Parse `export GOTCHIBOT_OPENCODE_MODEL=…` from sessions/.gotchi-model.env.
 * Does not source the file; only that one export line.
 * @param {string} contents
 * @returns {string|null}
 */
export function parseGotchiModelEnv(contents) {
  const m = String(contents || "").match(
    /^export\s+GOTCHIBOT_OPENCODE_MODEL=(.+)$/m,
  );
  if (!m?.[1]) return null;
  let v = m[1].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  v = v.trim();
  return v || null;
}

/**
 * Read pinned desk model from env or sessions/.gotchi-model.env.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [root]
 */
export function resolvePinnedChatModel(env = process.env, root = ROOT) {
  const fromEnv = String(env.GOTCHIBOT_OPENCODE_MODEL || "").trim();
  if (fromEnv) return fromEnv;
  const pinPath = join(root, "sessions", ".gotchi-model.env");
  try {
    if (!existsSync(pinPath)) return null;
    return parseGotchiModelEnv(readFileSync(pinPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Strip ANSI + opencode default-format headers; prefer --format json NDJSON.
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {string}
 */
export function parseOpencodeOutput(stdout, stderr = "") {
  const raw = String(stdout || "");
  const texts = [];
  let sawJson = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
      sawJson = true;
      if (ev.type === "text") {
        const part = ev.part;
        const text =
          (part && typeof part.text === "string" && part.text) ||
          (typeof ev.text === "string" && ev.text) ||
          "";
        if (text.trim()) texts.push(text.trim());
      }
    } catch {
      /* not NDJSON */
    }
  }
  if (sawJson) return texts.join("\n\n").trim();

  const cleaned = raw
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, ""))
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (HEADER_RE.test(t)) return false;
      if (/^build\s*[·•]/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
  if (cleaned) return cleaned;

  // Last resort: stderr sometimes holds the reply when stdout is empty
  const errClean = String(stderr || "")
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !HEADER_RE.test(l))
    .join("\n")
    .trim();
  return errClean;
}

/**
 * @param {string} [value]
 * @param {number} [max]
 */
export function sanitizeRunnerError(value, max = 180) {
  let s = String(value ?? "")
    .replace(ANSI_RE, "")
    .replace(/gbd_[A-Za-z0-9_-]+/gi, "gbd_***")
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(
      /(NVIDIA_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY|OPENCODE_API_KEY|OPENCODE_ZEN_API_KEY)\s*=\s*\S+/gi,
      "$1=***",
    );
  s = s.replace(/\s+/g, " ").trim().slice(0, max);
  return s || "error";
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hasProviderKey(env = process.env) {
  if (String(env.GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY || "") === "1") return true;
  return PROVIDER_KEY_NAMES.some((k) => Boolean(env[k] && String(env[k]).trim()));
}

/**
 * @returns {{ ok: boolean, opencode: boolean, keys: boolean, detail: string|null }}
 */
export function preflightChecks(env = process.env) {
  const probe = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  let opencode = probe.error?.code !== "ENOENT";
  if (!opencode) {
    const w = spawnSync("which", ["opencode"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    opencode = w.status === 0 && Boolean(String(w.stdout || "").trim());
  }

  const keys = hasProviderKey(env);
  if (!opencode) {
    return {
      ok: false,
      opencode: false,
      keys,
      detail: "opencode CLI not found on PATH",
    };
  }
  if (!keys) {
    return {
      ok: false,
      opencode: true,
      keys: false,
      detail:
        "no provider key in env — run under: abra run gotchibot -- node scripts/hub-runner.mjs",
    };
  }
  return { ok: true, opencode: true, keys: true, detail: null };
}

/**
 * Ensure isolated scratch dir with no-tools opencode.json (not the repo root).
 * @param {string} [workDir]
 */
export function ensureHubReplyWorkDir(workDir) {
  const dir =
    workDir || join(ROOT, "sessions", "hub-runner", "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "opencode.json"),
    `${JSON.stringify(HUB_REPLY_OPENCODE_JSON, null, 2)}\n`,
  );
  return dir;
}

function mapContextMessages(messages) {
  return (messages || []).map((m) => {
    const role = String(m.role || "").toLowerCase();
    const text = String(m.text || "");
    if (role === "user" || role === "assistant") {
      return { role, text };
    }
    const label = role || "other";
    return { role: "user", text: `[${label}] ${text}` };
  });
}

/**
 * Build a single prompt string for `opencode run` (no tools).
 */
export function buildOpencodePrompt({ messages, systemPrompt } = {}) {
  const sys = String(systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
  const mapped = mapContextMessages(messages);
  const lines = [`System: ${sys}`, "", "Conversation:"];
  for (const m of mapped) {
    const who = m.role === "assistant" ? "Gotchi" : "User";
    lines.push(`${who}: ${m.text}`);
  }
  lines.push("", "Gotchi:");
  return lines.join("\n");
}

/**
 * Pull the message from the first NDJSON `type:"error"` event, if any.
 * @param {string} stdout
 * @returns {string|null}
 */
export function extractOpencodeJsonError(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (ev?.type === "error") {
        return String(
          ev.error?.data?.message ||
            ev.error?.message ||
            ev.error?.name ||
            "opencode error",
        );
      }
    } catch {
      /* not NDJSON */
    }
  }
  return null;
}

/**
 * Lines from stdout that are not parseable JSON objects — plain-text failure
 * noise only. Never returns NDJSON event lines (timestamps/ids can contain
 * digit sequences like 402/429 that must not trigger limit heuristics).
 * @param {string} stdout
 * @returns {string}
 */
export function nonJsonStdoutText(stdout) {
  const kept = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      try {
        JSON.parse(t);
        continue;
      } catch {
        /* keep non-JSON */
      }
    }
    kept.push(t);
  }
  return kept.join("\n");
}

/**
 * Contextual HTTP 402/429 — never a bare digit substring.
 * Pair with isModelLimitError on scoped failure text only (error messages /
 * stderr / non-JSON stdout), never whole NDJSON event streams.
 */
const MODEL_LIMIT_HTTP_RE =
  /(?:\b(?:HTTP|status|code)\b[^\n]{0,48}\b(?:402|429)\b|\b(?:402|429)\b[^\n]{0,48}\b(?:Payment Required|Too Many Requests|rate[\s-]?limit|quota)\b)/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeModelLimitFailure(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  // Shared semantic phrases (rate limit, payment required, \b402\b, …) —
  // caller must already have scoped away successful JSON event lines.
  if (isModelLimitError(s)) return true;
  return MODEL_LIMIT_HTTP_RE.test(s);
}

/**
 * Spawn one opencode run. stdin ignored (must be closed or opencode hangs).
 * @returns {{ ok: boolean, text?: string, reason?: string, stdout?: string, status?: number|null }}
 */
export function runOpencodeOnce({
  model,
  prompt,
  workDir,
  timeoutMs = 120_000,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const dir = ensureHubReplyWorkDir(workDir);
  const args = [
    "run",
    "-m",
    model,
    "--agent",
    "hub-reply",
    "--dir",
    dir,
    "--format",
    "json",
    "--pure",
    String(prompt),
  ];
  const r = spawn("opencode", args, {
    cwd: dir,
    env: { ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  const blob = `${stdout}\n${stderr}`;
  if (r.error?.code === "ENOENT") {
    return { ok: false, reason: "opencode-not-found", stdout: blob.slice(0, 400) };
  }
  if (r.signal === "SIGTERM" || r.error?.code === "ETIMEDOUT" || /ETIMEDOUT/i.test(String(r.error || ""))) {
    return { ok: false, reason: "timeout", stdout: blob.slice(0, 400), status: r.status };
  }

  const jsonError = extractOpencodeJsonError(stdout);
  const text = parseOpencodeOutput(stdout, stderr);

  // Successful JSON run: never apply limit heuristics to timestamps / ids.
  if (r.status === 0 && text && !jsonError) {
    return { ok: true, text, status: r.status };
  }

  // Limit detection only on (a) JSON error messages and (b) stderr / non-JSON
  // failure output — never the whole NDJSON event stream.
  if (jsonError) {
    if (looksLikeModelLimitFailure(jsonError)) {
      return {
        ok: false,
        reason: "model-limit",
        stdout: jsonError.slice(0, 400),
        status: r.status,
      };
    }
    return {
      ok: false,
      reason: "opencode-error",
      stdout: jsonError.slice(0, 400),
      status: r.status,
    };
  }

  const failureProbe = [stderr, nonJsonStdoutText(stdout)].filter(Boolean).join("\n");
  if (looksLikeModelLimitFailure(failureProbe)) {
    return {
      ok: false,
      reason: "model-limit",
      stdout: failureProbe.slice(0, 400),
      status: r.status,
    };
  }

  if (!text) {
    return {
      ok: false,
      reason: r.status === 0 ? "empty-output" : "opencode-failed",
      stdout: blob.slice(0, 400),
      status: r.status,
    };
  }
  return { ok: false, reason: "opencode-failed", stdout: blob.slice(0, 400), status: r.status };
}

/**
 * Default `complete` — desk's OpenCode cloud path (no direct provider HTTP).
 * Model order: HUB_RUNNER_MODEL → OPENCODE_MODEL / .gotchi-model.env → policy chat chain.
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function opencodeComplete({
  messages,
  threadId,
  systemPrompt,
  env = process.env,
  root = ROOT,
  workDir,
  timeoutMs,
  spawn = spawnSync,
} = {}) {
  const tMs =
    Number(
      timeoutMs ??
        env.GOTCHIBOT_HUB_RUNNER_TIMEOUT_MS ??
        120_000,
    ) || 120_000;
  const prompt = buildOpencodePrompt({ messages, systemPrompt });
  void threadId;

  const pinned = [];
  const hubModel = String(env.GOTCHIBOT_HUB_RUNNER_MODEL || "").trim();
  if (hubModel) pinned.push(hubModel);
  const deskModel = resolvePinnedChatModel(env, root);
  if (deskModel && !pinned.includes(deskModel)) pinned.push(deskModel);

  const tried = new Set();
  let lastErr = "models-exhausted";

  for (const model of pinned) {
    tried.add(model);
    const r = runOpencodeOnce({
      model,
      prompt,
      workDir,
      timeoutMs: tMs,
      env,
      spawn,
    });
    if (r.ok && r.text?.trim()) {
      return { text: r.text.trim(), model };
    }
    lastErr = r.reason || "opencode-failed";
    if (r.reason === "model-limit") {
      try {
        const { markModelCooldown } = await import("../../scripts/model-auto.mjs");
        markModelCooldown(model, { reason: "hub-runner-limit" });
      } catch {
        /* optional */
      }
      continue;
    }
    // Non-limit: still try remaining pinned, then policy
  }

  const policyHit = await completeWithPolicy(
    "chat",
    async (model, opts) => {
      if (tried.has(model)) {
        return { ok: false, reason: "already-tried" };
      }
      tried.add(model);
      return runOpencodeOnce({
        model,
        prompt,
        workDir,
        timeoutMs: opts?.timeoutMs || tMs,
        env,
        spawn,
      });
    },
    { timeoutMs: tMs },
  );

  if (policyHit.ok && String(policyHit.text || "").trim()) {
    return {
      text: String(policyHit.text).trim(),
      model: policyHit.model,
    };
  }
  const err = new Error(
    sanitizeRunnerError(policyHit.reason || lastErr || "models-exhausted"),
  );
  err.code = "HUB_RUNNER_COMPLETE_FAILED";
  throw err;
}

/**
 * @param {{
 *   store: object,
 *   complete?: Function,
 *   runnerId?: string,
 *   pollMs?: number,
 *   heartbeatMs?: number,
 *   contextLimit?: number,
 *   staleMs?: number,
 *   logger?: { info?: Function, error?: Function },
 *   env?: NodeJS.ProcessEnv,
 *   systemPrompt?: string,
 * }} opts
 */
export function createHubRunner({
  store,
  complete = opencodeComplete,
  runnerId = "hub-runner",
  pollMs = 2_000,
  heartbeatMs = 15_000,
  contextLimit = 20,
  staleMs = 5 * 60 * 1000,
  logger = console,
  env = process.env,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
} = {}) {
  if (!store) throw new Error("createHubRunner: store required");

  let stopping = false;
  let running = false;
  let tickBusy = false;
  let loopTimer = null;
  let lastPreflightDetail = null;
  let lastHeartbeatAt = 0;
  let lastModelHint = null;

  function log(event, fields = {}) {
    const parts = [`[hub-runner] ${event}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === "") continue;
      parts.push(`${k}=${v}`);
    }
    (logger.info || logger.log || console.log).call(logger, parts.join(" "));
  }

  async function heartbeat(status, detail, model) {
    lastHeartbeatAt = Date.now();
    if (model) lastModelHint = model;
    await store.writeRunnerHeartbeat({
      runnerId,
      status,
      detail: detail != null ? sanitizeRunnerError(detail, 200) : null,
      model: model ?? lastModelHint,
    });
  }

  async function maybeHeartbeatOk() {
    if (Date.now() - lastHeartbeatAt < heartbeatMs) return;
    await heartbeat("ok", "idle", lastModelHint);
  }

  /**
   * @returns {Promise<boolean>} true if a message was claimed/processed
   */
  async function tick() {
    if (tickBusy) return false;
    tickBusy = true;
    const t0 = Date.now();
    try {
      const pre = preflightChecks(env);
      if (!pre.ok) {
        await heartbeat("error", pre.detail, lastModelHint);
        if (pre.detail !== lastPreflightDetail) {
          log("preflight-error", { detail: pre.detail });
          lastPreflightDetail = pre.detail;
        }
        return false;
      }
      if (lastPreflightDetail) {
        log("preflight-ok");
        lastPreflightDetail = null;
      }

      const claimed = await store.claimNextPendingReply({
        runnerId,
        staleMs,
      });
      if (!claimed) {
        await maybeHeartbeatOk();
        return false;
      }

      const threadId = claimed.threadId;
      const messageId = claimed.messageId;
      log("claimed", { threadId, messageId });

      try {
        const ctx = await store.getThreadMessagesForContext(threadId, {
          limit: contextLimit,
        });
        const result = await complete({
          messages: ctx,
          threadId,
          systemPrompt,
          env,
        });
        const text = String(result?.text || "").trim();
        const model = String(result?.model || "").trim() || "unknown";
        if (!text) {
          throw new Error("empty model output");
        }

        const replyMessageId = ulid();
        const ts = new Date().toISOString();
        await store.pushMessages({
          threadId,
          deskId: store.HUB_RUNNER_DESK_ID || "hub-runner",
          messages: [
            {
              messageId: replyMessageId,
              role: "assistant",
              text,
              op: "message",
              ts,
            },
          ],
        });
        await store.completeReply({
          threadId,
          messageId,
          replyMessageId,
          model,
        });
        lastModelHint = model;
        await heartbeat("ok", "replied", model);
        log("replied", {
          threadId,
          messageId,
          model,
          duration: `${Date.now() - t0}ms`,
        });
        return true;
      } catch (e) {
        const err = sanitizeRunnerError(e?.message || e);
        await store.failReply({ threadId, messageId, error: err });
        await heartbeat("ok", "reply-error", lastModelHint);
        log("reply-error", {
          threadId,
          messageId,
          error: err,
          duration: `${Date.now() - t0}ms`,
        });
        return true;
      }
    } finally {
      tickBusy = false;
    }
  }

  async function loopOnce() {
    if (stopping) return;
    let worked = false;
    try {
      worked = await tick();
    } catch (e) {
      log("tick-threw", { error: sanitizeRunnerError(e?.message || e) });
      try {
        await heartbeat("error", sanitizeRunnerError(e?.message || e));
      } catch {
        /* ignore */
      }
    }
    if (stopping) return;
    const delay = worked ? Math.min(pollMs, 250) : pollMs;
    loopTimer = setTimeout(() => {
      loopOnce().catch(() => {});
    }, delay);
    if (typeof loopTimer.unref === "function") loopTimer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    stopping = false;
    log("start", { runnerId, pollMs, heartbeatMs });
    loopOnce().catch(() => {});
  }

  async function stop() {
    stopping = true;
    running = false;
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    // Wait briefly for in-flight tick (stale claim reclaimable after 5 min)
    const deadline = Date.now() + 10_000;
    while (tickBusy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    log("stop", { runnerId });
  }

  return { tick, start, stop };
}
