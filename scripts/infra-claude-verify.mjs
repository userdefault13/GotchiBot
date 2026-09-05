#!/usr/bin/env node
/**
 * infra-claude-verify.mjs
 *
 * Independent second opinion on home-stack health, via the Claude CLI.
 *
 * The node probes in infra-monitor-cron.mjs only see what they were told to
 * look at — that is exactly how the "docker FAIL / subgraph Unauthorized" false
 * alarm survived 501 consecutive runs without anyone noticing the stack was
 * fine. This runs `claude -p` in a terminal with a tiny read-only Bash
 * allowlist so a real agent looks at the machine and says whether the stack is
 * actually up, in its own words.
 *
 *   node scripts/infra-claude-verify.mjs            # human output
 *   node scripts/infra-claude-verify.mjs --json     # machine output
 *   node scripts/infra-claude-verify.mjs --context '<what the probes claim>'
 *
 * Env:
 *   INFRA_CLAUDE_BIN       path to the claude CLI
 *                          (default ~/.local/bin/claude — it is NOT on the
 *                          non-interactive PATH on this iMac)
 *   INFRA_CLAUDE_TIMEOUT   ms before the verification is abandoned (default 180000)
 *   INFRA_CLAUDE_MODEL     optional --model override
 *
 * Read-only by construction: the allowlist is `docker ps`, `docker info` and
 * `curl` at localhost / *.aarcadeghst.com. No writes, no restarts, no Blockscout.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || "/Users/juliuswong";

// The claude CLI lives in ~/.local/bin, which login shells have and cron,
// LaunchAgents and `ssh host 'cmd'` do not. Always resolve it absolutely.
const CLAUDE_BIN =
  process.env.INFRA_CLAUDE_BIN ||
  [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(
    (p) => existsSync(p),
  ) ||
  "claude";

const TIMEOUT_MS = Number(process.env.INFRA_CLAUDE_TIMEOUT || 180000);

const ALLOWED_TOOLS = [
  "Bash(docker ps:*)",
  "Bash(docker info:*)",
  "Bash(curl:*)",
].join(",");

const PROMPT = `You are verifying that the AarcadeGh$t home stack on this iMac is actually running right now. Use only the Bash commands you are allowed.

Check these and judge for yourself:
1. \`docker ps --format '{{.Names}}|{{.Status}}'\` — are these containers Up?
   aarcade-mongo, aarcade-cartridge-sim, aarcade-subgraph-api
   (Other containers on this machine belong to unrelated projects. Stopped ones are NOT a stack failure — do not report them as one.)
2. \`curl -sS -m 20 https://mongo-api.aarcadeghst.com/health\` — expect {"ok":true,...,"mongo":"up"}. This call takes ~5.5s when mongod is down, so never use a timeout under 20s.
3. \`curl -s -o /dev/null -w '%{http_code}' -m 20 https://cartridge.aarcadeghst.com/health\` — expect 200.
4. \`curl -s -o /dev/null -w '%{http_code}' -m 20 https://subgraph.aarcadeghst.com/health\` — expect 200.
5. \`curl -sS -m 20 http://127.0.0.1:8787/health\` — expect ok:true. Note: an unauthenticated GraphQL POST to :8787 returns 401 Unauthorized by design; that is NOT an outage.

Then reply in exactly this shape and nothing else:

VERDICT: UP | DEGRADED | DOWN
SUMMARY: <one sentence>
DETAIL: <one short line per check, name and result>

Use DOWN only if the public endpoints are unreachable, DEGRADED if some part is genuinely broken, UP if the stack is serving.`;

export function verifyWithClaude({ context = null, timeoutMs = TIMEOUT_MS } = {}) {
  const startedAt = new Date().toISOString();
  if (!existsSync(CLAUDE_BIN) && !CLAUDE_BIN.includes("/")) {
    return { ok: false, available: false, verdict: null, error: `claude CLI not found (${CLAUDE_BIN})`, startedAt };
  }

  const prompt = context ? `${PROMPT}\n\nThe automated probes currently claim:\n${context}\nSay plainly if you disagree with them.` : PROMPT;

  const args = ["-p", prompt, "--output-format", "json", "--allowedTools", ALLOWED_TOOLS, "--add-dir", ROOT];
  if (process.env.INFRA_CLAUDE_MODEL) args.push("--model", process.env.INFRA_CLAUDE_MODEL);

  const r = spawnSync(CLAUDE_BIN, args, {
    encoding: "utf8",
    cwd: ROOT,
    timeout: timeoutMs,
    env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${process.env.PATH || ""}`,
    },
  });

  if (r.error) {
    const timedOut = r.error.code === "ETIMEDOUT" || /timed?.?out/i.test(String(r.error.message));
    return {
      ok: false,
      available: true,
      verdict: null,
      error: timedOut ? `claude verification timed out after ${timeoutMs}ms` : String(r.error.message || r.error),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  let text = (r.stdout || "").trim();
  let costUsd = null;
  let sessionId = null;
  try {
    const parsed = JSON.parse(text);
    // --output-format json wraps the answer in a result envelope.
    if (parsed && typeof parsed === "object") {
      text = String(parsed.result ?? parsed.text ?? text).trim();
      costUsd = parsed.total_cost_usd ?? null;
      sessionId = parsed.session_id ?? null;
      if (parsed.is_error) {
        return { ok: false, available: true, verdict: null, error: text || "claude returned is_error", raw: text, startedAt, finishedAt: new Date().toISOString(), costUsd, sessionId };
      }
    }
  } catch {
    // Non-JSON stdout (older CLI, or an auth prompt) — fall back to raw text.
  }

  if (r.status !== 0 && !text) {
    return { ok: false, available: true, verdict: null, error: (r.stderr || `claude exited ${r.status}`).slice(0, 500), startedAt, finishedAt: new Date().toISOString() };
  }

  const verdictMatch = text.match(/VERDICT:\s*(UP|DEGRADED|DOWN)/i);
  const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;

  return {
    ok: verdict === "UP",
    available: true,
    verdict,
    summary: summaryMatch ? summaryMatch[1].trim() : null,
    text,
    costUsd,
    sessionId,
    error: verdict ? null : "claude did not return a parseable VERDICT",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function main() {
  const asJson = process.argv.includes("--json");
  const ctxIdx = process.argv.indexOf("--context");
  const context = ctxIdx !== -1 ? process.argv[ctxIdx + 1] : null;

  const result = verifyWithClaude({ context });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[claude-verify] bin: ${CLAUDE_BIN}`);
    console.log(result.text || result.error || "(no output)");
    console.error(`[claude-verify] verdict: ${result.verdict || "NONE"}`);
  }
  process.exit(result.verdict === "UP" ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
