#!/usr/bin/env node
/**
 * Goball GotchiBot teammate — poll invites, accept, LLM-play, release.
 *
 *   ./scripts/goball-teammate.mjs poll [--json]
 *   ./scripts/goball-teammate.mjs accept <inviteId> [--hero <id>]
 *   ./scripts/goball-teammate.mjs play [--poll-ms 1500] [--hero <id>]
 *   ./scripts/goball-teammate.mjs release [--hero <id>] [--seat-token <token>]
 *
 * Env: AARCADE_API_BASE, GOBALL_AGENT_SECRET (or COMM_AUTOMATION_SECRET), ABRA_KEY
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chatViaHttp } from "./openclaw-fleet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = (process.env.AARCADE_API_BASE || "https://aarcadeghst.com").replace(/\/+$/, "");
const POLL_MS = Number(process.env.GOBALL_POLL_MS || 1500);

async function loadSecret() {
  if (process.env.GOBALL_AGENT_SECRET) return process.env.GOBALL_AGENT_SECRET;
  if (process.env.COMM_AUTOMATION_SECRET) return process.env.COMM_AUTOMATION_SECRET;
  const key = process.env.ABRA_KEY;
  const project = process.env.ABRA_PROJECT || "gotchibot";
  if (key) {
    try {
      const r = await fetch("http://127.0.0.1:7331/secret", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ project, keys: ["GOBALL_AGENT_SECRET", "COMM_AUTOMATION_SECRET"] }),
      });
      if (r.ok) {
        const data = await r.json();
        return data?.GOBALL_AGENT_SECRET || data?.COMM_AUTOMATION_SECRET || null;
      }
    } catch (e) {
      console.error("abra secret fetch failed:", e.message);
    }
  }
  throw new Error("GOBALL_AGENT_SECRET not available (set env or ABRA_KEY)");
}

function authHeaders(secret) {
  return { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
}

async function apiGet(path, secret) {
  const r = await fetch(`${API_BASE}${path}`, { headers: authHeaders(secret) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${data.error || ""}`);
  return data;
}

async function apiPost(path, body, secret) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(secret),
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${data.error || ""}`);
  return data;
}

function listAvailableHeroes() {
  const ps = spawnSync("node", ["./scripts/agent-focus.mjs", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (ps.status !== 0) return [];
  try {
    const data = JSON.parse(ps.stdout || "{}");
    const rows = data.numbered || data.entries || [];
    return rows.filter((r) => {
      const st = String(r.status || r.agentStatus || "available").toLowerCase();
      return (st === "available" || st === "idle") && r.kind !== "session";
    });
  } catch {
    return [];
  }
}

function pickHero(explicit) {
  if (explicit) return explicit;
  const heroes = listAvailableHeroes();
  return heroes[0]?.id || heroes[0]?.heroId || null;
}

function setHeroWorking(heroId, task = "goball teammate") {
  spawnSync("node", ["./scripts/hero-agent-state.mjs", "set", heroId, "working", "--task", task], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function setHeroAvailable(heroId) {
  spawnSync("node", ["./scripts/hero-agent-state.mjs", "set", heroId, "available"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeAction(action) {
  if (!action || typeof action !== "object") return { hold: true };
  const out = {};
  if (Array.isArray(action.moveTo) && action.moveTo.length >= 2) {
    out.moveTo = [Number(action.moveTo[0]), Number(action.moveTo[1])];
  }
  if (Array.isArray(action.face) && action.face.length >= 2) {
    out.face = [Number(action.face[0]), Number(action.face[1])];
  }
  if (typeof action.passTo === "string" && action.passTo.trim()) out.passTo = action.passTo.trim();
  if (action.shoot === true) out.shoot = true;
  if (action.punch === true) out.punch = true;
  if (action.dive === true) out.dive = true;
  if (action.hold === true) out.hold = true;
  if (!Object.keys(out).length) out.hold = true;
  return out;
}

async function decideAction(heroId, observation) {
  const prompt = [
    "You are a GotchiBot teammate in GoBall arcade soccer (team Home).",
    "Reply with JSON only — no prose. Schema:",
    '{"moveTo":[x,y]?,"face":[x,y]?,"passTo":"playerId"?,"shoot":bool?,"punch":bool?,"dive":bool?,"hold":bool?}',
    "Goals: support the human, move toward ball when loose, pass when open, shoot near goal, tackle with punch/dive.",
    "Observation:",
    JSON.stringify(observation),
  ].join("\n");

  const chat = await chatViaHttp(heroId, prompt, { timeoutMs: 45_000 });
  if (!chat.ok) {
    console.warn(`[goball] LLM failed (${chat.reason}) — hold`);
    return { hold: true };
  }
  const parsed = extractJsonObject(chat.stdout);
  return sanitizeAction(parsed);
}

async function cmdPoll(secret, json) {
  const data = await apiGet("/api/goball-agent/invites", secret);
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const invites = data.invites || [];
  if (!invites.length) {
    console.log("No pending goball invites.");
    return;
  }
  for (const inv of invites) {
    console.log(`${inv.inviteId} session=${inv.sessionId} seat=${inv.seat} hero=${inv.heroId || "any"}`);
  }
}

async function cmdAccept(secret, inviteId, heroArg) {
  const heroId = pickHero(heroArg);
  if (!heroId) throw new Error("No available hero to accept invite");
  const result = await apiPost("/api/goball-agent/accept", { inviteId, heroId }, secret);
  setHeroWorking(heroId);
  console.log(`Accepted ${inviteId} as ${heroId}. seatToken=${result.seatToken}`);
  return result;
}

async function cmdPlay(secret, { heroArg, pollMs, inviteId, seatToken }) {
  let heroId = heroArg || null;
  let token = seatToken || null;

  if (!token) {
    if (!inviteId) {
      const pending = await apiGet("/api/goball-agent/invites", secret);
      const first = (pending.invites || [])[0];
      if (!first) throw new Error("No pending invites — run poll or wait for player invite");
      inviteId = first.inviteId;
      if (!heroId && first.heroId) heroId = first.heroId;
    }
    if (!heroId) heroId = pickHero(null);
    if (!heroId) throw new Error("No available hero");
    const accepted = await cmdAccept(secret, inviteId, heroId);
    token = accepted.seatToken;
  } else if (heroId) {
    setHeroWorking(heroId);
  }

  console.log(`[goball] playing as ${heroId} (poll ${pollMs || POLL_MS}ms). Ctrl+C to stop.`);

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });

  while (running) {
    try {
      const obsRes = await apiGet(
        `/api/goball-agent/observation?seatToken=${encodeURIComponent(token)}`,
        secret,
      );
      const observation = obsRes.observation;
      if (!observation) {
        await sleep(pollMs || POLL_MS);
        continue;
      }
      if (observation.phase === "Ended") {
        console.log("[goball] match ended");
        break;
      }
      const action = await decideAction(heroId, observation);
      await apiPost("/api/goball-agent/action", { seatToken: token, action }, secret);
    } catch (e) {
      console.warn("[goball] play tick:", e.message);
    }
    await sleep(pollMs || POLL_MS);
  }

  await cmdRelease(secret, { heroId, seatToken: token });
}

async function cmdRelease(secret, { heroId, seatToken }) {
  if (seatToken) {
    await apiPost("/api/goball-agent/end", { seatToken, reason: "bot_release" }, secret);
  }
  if (heroId) setHeroAvailable(heroId);
  console.log(`Released ${heroId || "seat"}.`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { cmd: argv[0], rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hero" && argv[i + 1]) {
      out.hero = argv[++i];
    } else if (a === "--poll-ms" && argv[i + 1]) {
      out.pollMs = Number(argv[++i]);
    } else if (a === "--seat-token" && argv[i + 1]) {
      out.seatToken = argv[++i];
    } else if (a === "--json") {
      out.json = true;
    } else if (!a.startsWith("--")) {
      out.rest.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.cmd || "poll";
  const secret = await loadSecret();

  switch (cmd) {
    case "poll":
      await cmdPoll(secret, args.json);
      break;
    case "accept":
      await cmdAccept(secret, args.rest[0], args.hero);
      break;
    case "play":
      await cmdPlay(secret, {
        heroArg: args.hero,
        pollMs: args.pollMs,
        inviteId: args.rest[0],
        seatToken: args.seatToken,
      });
      break;
    case "release":
      await cmdRelease(secret, { heroId: args.hero || args.rest[0], seatToken: args.seatToken });
      break;
    default:
      console.log("Usage: goball-teammate.mjs poll|accept|play|release …");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
