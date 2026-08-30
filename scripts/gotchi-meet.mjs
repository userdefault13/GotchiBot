#!/usr/bin/env node
/**
 * Shared meeting room — Julius + orchestrator (chair) + invited cAavegotchis.
 *
 *   ./scripts/gotchi-meet.mjs start ["topic"]
 *   ./scripts/gotchi-meet.mjs invite <n|id|name>
 *   ./scripts/gotchi-meet.mjs status [--json]
 *   ./scripts/gotchi-meet.mjs say "user message"
 *   ./scripts/gotchi-meet.mjs end
 *
 * Stay in OpenCode. Chair-led turn-taking. One open meeting (v1).
 */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta } from "./identity.mjs";
import {
  ROOT,
  SESSIONS,
  loadOnboarding,
  fetchCartridgeHeroes,
} from "./onboarding-lib.mjs";
import {
  orchestratorHeroId,
  loadAgentMap,
  runAgentTurn,
  gatewayReachable,
  findOpenclawBin,
  heroToAgentId,
  gatewayUrl,
  loadGatewayConfig,
} from "./openclaw-fleet.mjs";

const MEETINGS = `${SESSIONS}/meetings`;
const CURRENT = `${MEETINGS}/.current`;
const LIST_CACHE = `${SESSIONS}/.focus-list.json`;
const TURN_TIMEOUT_S = 90;
const CHAIR_TIMEOUT_S = 60;

function ensureMeetings() {
  mkdirSync(MEETINGS, { recursive: true });
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function pokeAvatar() {
  spawnSync("bash", [`${ROOT}/scripts/poke-avatar.sh`], { stdio: "ignore" });
}

function userParticipant() {
  let name = "Julius";
  try {
    const md = readFileSync(`${ROOT}/USER.md`, "utf8");
    const call = md.match(/\*\*What to call them:\*\*\s*(.+)/i);
    if (call) name = call[1].trim().split(/\s+/)[0];
    else {
      const nm = md.match(/\*\*Name:\*\*\s*(.+)/i);
      if (nm) name = nm[1].trim().split(/\s+/)[0];
    }
  } catch {
    /* default */
  }
  const id = name.toLowerCase() || "user";
  return { id, role: "user", name };
}

function displayNameFor(hero) {
  if (hero?.name) return hero.name;
  const coll = String(hero?.collateral || "").trim();
  if (coll) return coll.split(/[\/:]/).pop().toUpperCase();
  if (hero?.isOrchestrator) return "Gotchi";
  return hero?.id || "gotchi";
}

function meetingDir(id) {
  return `${MEETINGS}/${id}`;
}

function meetingPath(id) {
  return `${meetingDir(id)}/meeting.json`;
}

function transcriptPath(id) {
  return `${meetingDir(id)}/transcript.jsonl`;
}

export function currentMeetingId() {
  try {
    const raw = readFileSync(CURRENT, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function loadMeeting(id) {
  if (!id) return null;
  return readJson(meetingPath(id), null);
}

export function loadCurrentMeeting() {
  const id = currentMeetingId();
  if (!id) return null;
  const m = loadMeeting(id);
  if (!m || m.status !== "open") {
    try {
      unlinkSync(CURRENT);
    } catch {}
    return null;
  }
  return m;
}

function requireOpenMeeting() {
  const m = loadCurrentMeeting();
  if (!m) {
    throw new Error(
      'no open meeting — start one: ./scripts/gotchi-meet.mjs start "topic"',
    );
  }
  return m;
}

function saveMeeting(meeting) {
  ensureMeetings();
  mkdirSync(meetingDir(meeting.id), { recursive: true });
  writeJson(meetingPath(meeting.id), meeting);
}

function setCurrent(id) {
  ensureMeetings();
  writeFileSync(CURRENT, `${id}\n`);
}

function clearCurrent() {
  try {
    unlinkSync(CURRENT);
  } catch {}
}

function newMeetingId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `m${stamp}-${process.pid}`;
}

function readTranscript(id) {
  try {
    return readFileSync(transcriptPath(id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendTranscript(id, rec) {
  ensureMeetings();
  mkdirSync(meetingDir(id), { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    speaker: rec.speaker,
    role: rec.role,
    text: String(rec.text ?? ""),
  };
  appendFileSync(transcriptPath(id), `${JSON.stringify(row)}\n`);
  return row;
}

function participantLabel(meeting, id) {
  const p = (meeting.participants || []).find((x) => x.id === id);
  const name = p?.name || id;
  const role = p?.role || "agent";
  return `${name} (${role})`;
}

function formatTranscript(turns) {
  return (turns || [])
    .map((t) => `[${t.role || "?"}] ${t.speaker}: ${t.text}`)
    .join("\n");
}

function refreshFocusList() {
  spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function loadInviteRoster({ refresh = false } = {}) {
  if (refresh) refreshFocusList();
  const entries = [];
  const seen = new Set();
  const push = (e) => {
    if (!e?.id) return;
    const key = `${e.index ?? ""}:${e.id}`;
    if (seen.has(e.id) && e.index == null) return;
    seen.add(e.id);
    seen.add(key);
    entries.push(e);
  };

  const cache = readJson(LIST_CACHE, null);
  for (const e of cache?.entries || []) push({ ...e });

  const map = loadAgentMap();
  if (map?.agents) {
    for (const [agentId, m] of Object.entries(map.agents)) {
      if (m?.aliasOf) continue;
      const id = m.heroId || agentId;
      push({
        kind: "hero",
        host: "openclaw",
        id,
        hero: id,
        name: m.name || null,
        collateral: m.collateral || null,
        bindType: m.bindType || null,
        status: m.status || "available",
        isOrchestrator: !!m.isOrchestrator,
      });
    }
  }

  const meta = loadMeta();
  if (meta?.cartridgeId) {
    try {
      const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
      for (const h of heroes) {
        push({
          kind: "hero",
          host: "cartridge",
          id: h.id,
          hero: h.id,
          name: h.name || null,
          collateral: h.collateral || h.collateralAddress || null,
          bindType: h.bindType || null,
          status: h.agentStatus || "available",
        });
      }
    } catch {
      /* offline cartridge */
    }
  }
  return entries;
}

function heroFromEntry(e) {
  const id = e.kind === "session" ? e.hero : e.hero || e.id;
  if (!id) {
    throw new Error(
      `${e.id} is not a cAavegotchi (session with no hero) — invite an OpenClaw / cartridge id`,
    );
  }
  const map = loadAgentMap();
  const mapped = map?.agents?.[id] || Object.values(map?.agents || {}).find((m) => m.heroId === id);
  return {
    id,
    name: e.name || mapped?.name || null,
    collateral: e.collateral || mapped?.collateral || null,
    bindType: e.bindType || mapped?.bindType || null,
    isOrchestrator: !!(e.isOrchestrator || mapped?.isOrchestrator),
    kind: "hero",
  };
}

export async function resolveInviteTarget(query, { refresh = false } = {}) {
  const q = String(query || "").trim().replace(/^@/, "");
  if (!q) throw new Error("invite needs <n|id|name> — same roster as /switch");

  let entries = await loadInviteRoster({ refresh: refresh || /^\d+$/.test(q) });
  if (!entries.length) {
    entries = await loadInviteRoster({ refresh: true });
  }

  if (/^\d+$/.test(q)) {
    const n = Number(q);
    const hit = entries.find((e) => e.index === n);
    if (!hit) {
      throw new Error(`no roster entry #${n} — run /switch to list, then invite that n/id`);
    }
    return heroFromEntry(hit);
  }

  const lower = q.toLowerCase();
  const exact = entries.find(
    (e) =>
      String(e.id).toLowerCase() === lower ||
      String(e.hero || "").toLowerCase() === lower,
  );
  if (exact) return heroFromEntry(exact);

  const hits = [];
  const seen = new Set();
  for (const e of entries) {
    const id = e.kind === "session" ? e.hero : e.hero || e.id;
    if (!id || seen.has(id)) continue;
    const hay = [e.id, e.hero, e.name, e.collateral]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(lower)) continue;
    seen.add(id);
    hits.push(e);
  }
  if (hits.length === 1) return heroFromEntry(hits[0]);
  if (hits.length > 1) {
    const ids = [...new Set(hits.map((e) => e.hero || e.id))].join(", ");
    throw new Error(`ambiguous "${q}" — matches ${ids}. Use a full id.`);
  }
  throw new Error(
    `unknown agent "${q}" — not on the cartridge / OpenClaw roster. Do not invent agents. List: /switch`,
  );
}

function chairHero() {
  const id = orchestratorHeroId();
  const map = loadAgentMap();
  const mapped = map?.agents?.[id];
  return {
    id,
    name: mapped?.name || (mapped?.isOrchestrator ? "Gotchi" : null) || "Gotchi",
    collateral: mapped?.collateral || null,
    bindType: mapped?.bindType || "owned",
    isOrchestrator: true,
  };
}

export async function startMeeting(topic = "Untitled meeting") {
  const open = loadCurrentMeeting();
  if (open) {
    throw new Error(
      `meeting ${open.id} is already open (topic: ${open.topic || "—"})\nend it first: ./scripts/gotchi-meet.mjs end`,
    );
  }
  const chair = chairHero();
  const user = userParticipant();
  const id = newMeetingId();
  const meeting = {
    id,
    topic: String(topic || "Untitled meeting").trim() || "Untitled meeting",
    createdAt: new Date().toISOString(),
    status: "open",
    chairId: chair.id,
    current: true,
    participants: [
      { id: user.id, role: "user", name: user.name },
      {
        id: chair.id,
        role: "chair",
        name: displayNameFor(chair),
      },
    ],
  };
  saveMeeting(meeting);
  setCurrent(id);
  pokeAvatar();
  return meeting;
}

export async function inviteParticipant(query) {
  const meeting = requireOpenMeeting();
  const hero = await resolveInviteTarget(query);
  const already = meeting.participants.find((p) => p.id === hero.id);
  if (already) {
    throw new Error(`${hero.id} is already in the meeting (${already.role})`);
  }
  const user = userParticipant();
  if (hero.id === user.id) {
    throw new Error("the user is already in the meeting");
  }
  const role = hero.id === meeting.chairId || hero.isOrchestrator ? "chair" : "agent";
  if (role === "chair" && meeting.participants.some((p) => p.role === "chair")) {
    throw new Error(`${hero.id} is the chair and already in the room`);
  }
  const p = {
    id: hero.id,
    role,
    name: displayNameFor(hero),
  };
  meeting.participants.push(p);
  meeting.updatedAt = new Date().toISOString();
  saveMeeting(meeting);
  pokeAvatar();
  return { meeting, participant: p };
}

function extractJsonObject(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : s;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractReplyText(result) {
  const raw = String(result?.stdout || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    const openai = j?.choices?.[0]?.message?.content;
    const t =
      (typeof openai === "string" ? openai : null) ||
      j.text ||
      j.message ||
      j.output ||
      j.result ||
      j.content ||
      j.reply ||
      (typeof j.payloads?.[0]?.text === "string" ? j.payloads[0].text : null);
    if (typeof t === "string" && t.trim()) return t.trim();
  } catch {
    /* not json */
  }
  const obj = extractJsonObject(raw);
  if (obj) {
    const t = obj.text || obj.message || obj.output || obj.result || obj.reply;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return raw;
}

function mentionsFromText(text) {
  const out = [];
  const re = /@([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1]);
  return out;
}

function matchParticipant(meeting, token) {
  const t = String(token || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!t) return null;
  const parts = meeting.participants.filter((p) => p.role !== "user");
  const exact = parts.find(
    (p) =>
      p.id.toLowerCase() === t ||
      String(p.name || "").toLowerCase() === t,
  );
  if (exact) return exact;
  const hits = parts.filter((p) => {
    const hay = `${p.id} ${p.name || ""}`.toLowerCase();
    return hay.includes(t);
  });
  return hits.length === 1 ? hits[0] : null;
}

function fallbackSpeakers(meeting, userText) {
  const mentioned = [];
  for (const tok of mentionsFromText(userText)) {
    const hit = matchParticipant(meeting, tok);
    if (hit && !mentioned.includes(hit.id)) mentioned.push(hit.id);
  }
  if (mentioned.length) return mentioned.slice(0, 2);
  const invited = meeting.participants.filter((p) => p.role === "agent");
  return invited.slice(0, 1).map((p) => p.id);
}

function normalizeSpeakers(meeting, speakers) {
  const out = [];
  for (const raw of speakers || []) {
    const hit = matchParticipant(meeting, raw);
    if (hit && hit.role !== "user" && !out.includes(hit.id)) out.push(hit.id);
    if (out.length >= 2) break;
  }
  return out;
}

function meetSessionKey(meetingId, agentId) {
  return `agent:${heroToAgentId(agentId)}:meet-${meetingId}`;
}

function gatewayToken() {
  const file = loadGatewayConfig();
  return (
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_TOKEN?.trim() ||
    file?.token?.trim() ||
    ""
  );
}

function openaiContent(data) {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === "string" ? p : p?.text || "")).filter(Boolean).join("\n").trim();
  }
  return "";
}

async function chatViaHttp(agentId, message, { timeoutMs = TURN_TIMEOUT_S * 1000, sessionKey } = {}) {
  const gateway = gatewayUrl().replace(/\/$/, "");
  const token = gatewayToken();
  const key = sessionKey || tuiish(agentId);
  try {
    const r = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "x-openclaw-session-key": key,
        "x-openclaw-agent-id": heroToAgentId(agentId),
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: message }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text();
    if (r.status === 429) return { ok: false, reason: "rate-limited", stdout: raw };
    if (r.status === 404 || r.status === 405) return { ok: false, reason: "http-endpoint-disabled", stdout: raw };
    if (!r.ok) return { ok: false, reason: `gateway-http-${r.status}`, stdout: raw.slice(0, 800) };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "http-bad-json", stdout: raw.slice(0, 400) };
    }
    const text = openaiContent(data);
    if (!text) return { ok: false, reason: "http-empty", stdout: raw.slice(0, 400) };
    return { ok: true, stdout: text, reason: null };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/timeout|abort/i.test(msg)) return { ok: false, reason: "http-timeout" };
    return { ok: false, reason: "http-failed" };
  }
}

function tuiish(agentId) {
  return `agent:${heroToAgentId(agentId)}:main`;
}

async function runMeetingTurn(agentId, message, { timeoutS, sessionKey }) {
  const bin = findOpenclawBin();
  const reachable = await gatewayReachable();
  if (bin && reachable) {
    const r = runAgentTurn(heroToAgentId(agentId), message, {
      timeout: timeoutS,
      sessionKey,
    });
    if (r.ok) return r;
  }
  const http = await chatViaHttp(agentId, message, {
    timeoutMs: timeoutS * 1000,
    sessionKey,
  });
  if (http.ok) return http;
  return {
    ok: false,
    reason: http.reason || (reachable ? "openclaw-agent-failed" : "gateway-unreachable"),
    stdout: http.stdout || "",
  };
}

async function chairPickSpeakers(meeting, userText) {
  const turns = readTranscript(meeting.id);
  const roster = meeting.participants
    .filter((p) => p.role !== "user")
    .map((p) => `- ${p.id} (${p.role}${p.name ? ` · ${p.name}` : ""})`)
    .join("\n");
  const prompt = [
    "You are chairing a GotchiBot meeting. Pick who should respond to the latest user line.",
    "Return ONLY JSON: {\"speakers\": [\"id\", ...], \"note\": \"optional short reason\"}",
    "speakers: 0, 1, or 2 participant ids. Never the user. Empty array if the line is just ack/thanks.",
    "Prefer @mentions in the user text (e.g. @LINK → that hero's id).",
    `Meeting: ${meeting.id}`,
    `Topic: ${meeting.topic}`,
    `Chair id: ${meeting.chairId}`,
    "Participants (eligible speakers):",
    roster || "(none)",
    "",
    "Transcript:",
    formatTranscript(turns) || "(empty)",
    "",
    `Latest user line: ${userText}`,
  ].join("\n");

  const r = await runMeetingTurn(meeting.chairId, prompt, {
    timeoutS: CHAIR_TIMEOUT_S,
    sessionKey: meetSessionKey(meeting.id, meeting.chairId),
  });
  if (!r.ok) {
    return {
      speakers: fallbackSpeakers(meeting, userText),
      note: r.reason || "chair-failed",
      fallback: true,
    };
  }
  const parsed = extractJsonObject(extractReplyText(r) || r.stdout);
  if (!parsed || !Array.isArray(parsed.speakers)) {
    return {
      speakers: fallbackSpeakers(meeting, userText),
      note: "chair-json-parse-failed",
      fallback: true,
    };
  }
  return {
    speakers: normalizeSpeakers(meeting, parsed.speakers),
    note: typeof parsed.note === "string" ? parsed.note : undefined,
    fallback: false,
  };
}

async function agentReply(meeting, speakerId) {
  const p = meeting.participants.find((x) => x.id === speakerId);
  const turns = readTranscript(meeting.id);
  const prompt = [
    "You are in a GotchiBot meeting. Reply in 3–8 sentences as this gotchi. Don't chair unless you are the chair. Don't repeat others.",
    `Your id: ${speakerId}`,
    `Your name: ${p?.name || speakerId}`,
    `Your role: ${p?.role || "agent"}`,
    `Topic: ${meeting.topic}`,
    `Participants: ${(meeting.participants || []).map((x) => `${x.name || x.id} (${x.role})`).join(", ")}`,
    "",
    "Transcript so far:",
    formatTranscript(turns) || "(empty)",
    "",
    "Speak now. Plain text only — no JSON, no tools, no spawning sub-agents.",
  ].join("\n");

  const r = await runMeetingTurn(speakerId, prompt, {
    timeoutS: TURN_TIMEOUT_S,
    sessionKey: meetSessionKey(meeting.id, speakerId),
  });
  if (!r.ok) {
    const why = r.reason || "agent-failed";
    return { ok: false, text: `(unreachable: ${why})`, reason: why };
  }
  const text = extractReplyText(r) || "(no reply)";
  return { ok: true, text };
}

function printMeetingBlock(meeting, turns, { pick } = {}) {
  const w = 56;
  const bar = "─".repeat(w);
  console.log(bar);
  console.log(`GotchiBot meeting  ${meeting.id}  [${meeting.status}]`);
  console.log(`topic   ${meeting.topic}`);
  const names = meeting.participants
    .map((p) => `${p.name || p.id} (${p.role})`)
    .join(" · ");
  console.log(`room    ${names}`);
  if (pick?.fallback) {
    console.log(`chair   fallback (${pick.note || "chair call failed"})`);
  } else if (pick?.note) {
    console.log(`chair   ${pick.note}`);
  }
  console.log(bar);
  if (!turns?.length) {
    console.log("(no new lines this turn)");
  }
  for (const t of turns || []) {
    console.log("");
    console.log(`${participantLabel(meeting, t.speaker)}`);
    for (const line of String(t.text || "").split("\n")) {
      console.log(`  ${line}`);
    }
  }
  console.log("");
  console.log(bar);
  if (meeting.status === "open") {
    console.log('next  ./scripts/gotchi-meet.mjs say "…"');
    console.log("end   ./scripts/gotchi-meet.mjs end");
  }
}

export async function sayTurn(userText) {
  const text = String(userText || "").trim();
  if (!text) throw new Error('usage: gotchi-meet.mjs say "user message"');
  const meeting = requireOpenMeeting();
  const user = meeting.participants.find((p) => p.role === "user") || userParticipant();
  const printed = [];

  printed.push(
    appendTranscript(meeting.id, { speaker: user.id, role: "user", text }),
  );

  const pick = await chairPickSpeakers(meeting, text);
  const speakerTurns = [];
  for (const sid of pick.speakers || []) {
    const p = meeting.participants.find((x) => x.id === sid);
    const reply = await agentReply(meeting, sid);
    const row = appendTranscript(meeting.id, {
      speaker: sid,
      role: p?.role || "agent",
      text: reply.text,
    });
    speakerTurns.push(row);
    printed.push(row);
  }

  meeting.updatedAt = new Date().toISOString();
  meeting.lastSayAt = meeting.updatedAt;
  saveMeeting(meeting);
  pokeAvatar();
  printMeetingBlock(meeting, printed, { pick });
  if (!(pick.speakers || []).length) {
    console.log("(chair: no speakers this turn)");
  }
  return { meeting, pick, turns: printed, speakerTurns };
}

function firstLine(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "";
}

function writeMinutes(meeting) {
  const turns = readTranscript(meeting.id);
  const endedAt = new Date().toISOString();
  const parts = (meeting.participants || [])
    .map((p) => `${p.name || p.id} (${p.role})`)
    .join(", ");

  const seen = new Set();
  const summary = [];
  for (const t of turns) {
    if (seen.has(t.speaker)) continue;
    seen.add(t.speaker);
    const line = firstLine(t.text);
    if (line) summary.push(`- ${t.speaker}: ${line}`);
  }

  const last = turns.slice(-20);
  const lastBlock = last
    .map((t) => {
      const when = t.ts ? t.ts.replace("T", " ").replace(/\.\d+Z$/, "Z") : "";
      return `**${t.speaker}** (${t.role})${when ? ` · ${when}` : ""}\n${t.text}\n`;
    })
    .join("\n");

  const md = [
    `# Meeting minutes`,
    "",
    `- **id:** ${meeting.id}`,
    `- **topic:** ${meeting.topic}`,
    `- **created:** ${meeting.createdAt}`,
    `- **ended:** ${endedAt}`,
    `- **participants:** ${parts || "—"}`,
    "",
    "## Summary",
    summary.length ? summary.join("\n") : "- (no turns)",
    "",
    "## Last 20 turns",
    lastBlock.trim() || "(none)",
    "",
  ].join("\n");

  writeFileSync(`${meetingDir(meeting.id)}/minutes.md`, md);
  return { path: `${meetingDir(meeting.id)}/minutes.md`, endedAt, md };
}

export async function endMeeting() {
  const meeting = requireOpenMeeting();
  const { path, endedAt } = writeMinutes(meeting);
  meeting.status = "ended";
  meeting.current = false;
  meeting.endedAt = endedAt;
  meeting.minutesPath = path;
  saveMeeting(meeting);
  clearCurrent();
  pokeAvatar();
  return { meeting, minutesPath: path };
}

function printStatus(meeting, { json } = {}) {
  const turns = meeting ? readTranscript(meeting.id) : [];
  if (json) {
    console.log(
      JSON.stringify(
        {
          current: meeting?.id || null,
          meeting,
          turns: turns.length,
          transcript: turns,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!meeting) {
    console.log("no open meeting");
    console.log('start: ./scripts/gotchi-meet.mjs start "topic"');
    return;
  }
  console.log(`meeting ${meeting.id}  [${meeting.status}]`);
  console.log(`topic  ${meeting.topic}`);
  console.log(`chair  ${meeting.chairId}`);
  for (const p of meeting.participants || []) {
    console.log(`  · ${p.id}  ${p.role}${p.name ? `  (${p.name})` : ""}`);
  }
  console.log(`turns  ${turns.length}`);
  if (turns.length) {
    const last = turns[turns.length - 1];
    console.log(`last   ${last.speaker}: ${firstLine(last.text).slice(0, 120)}`);
  }
  console.log("");
  console.log('say    ./scripts/gotchi-meet.mjs say "…"');
  console.log("invite ./scripts/gotchi-meet.mjs invite <n|id|name>");
  console.log("end    ./scripts/gotchi-meet.mjs end");
}

function usage() {
  console.error(`usage:
  gotchi-meet.mjs start ["topic"]
  gotchi-meet.mjs invite <n|id|name>
  gotchi-meet.mjs status [--json]
  gotchi-meet.mjs say "user message"
  gotchi-meet.mjs end`);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const cmd = (args[0] || "status").toLowerCase();
  const rest = args.slice(1);

  if (cmd === "start") {
    const topic = rest.join(" ").trim() || "Untitled meeting";
    const m = await startMeeting(topic);
    console.log(`meeting started  ${m.id}`);
    console.log(`topic   ${m.topic}`);
    console.log(`chair   ${m.chairId}`);
    console.log(`you     ${m.participants.find((p) => p.role === "user")?.id}`);
    console.log("");
    console.log("invite  ./scripts/gotchi-meet.mjs invite <n|id|name>");
    console.log('say     ./scripts/gotchi-meet.mjs say "…"');
    return;
  }

  if (cmd === "invite") {
    const query = rest.join(" ").trim();
    if (!query) {
      console.error("usage: gotchi-meet.mjs invite <n|id|name>");
      process.exit(2);
    }
    const { meeting, participant } = await inviteParticipant(query);
    console.log(`invited ${participant.id}  (${participant.name || participant.role})`);
    console.log(
      `room    ${meeting.participants.map((p) => `${p.name || p.id} (${p.role})`).join(" · ")}`,
    );
    return;
  }

  if (cmd === "status" || cmd === "show") {
    printStatus(loadCurrentMeeting(), { json });
    return;
  }

  if (cmd === "say") {
    await sayTurn(rest.join(" ").trim());
    return;
  }

  if (cmd === "end") {
    const { meeting, minutesPath } = await endMeeting();
    console.log(`meeting ended  ${meeting.id}`);
    console.log(`minutes  ${minutesPath}`);
    return;
  }

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith("gotchi-meet.mjs")) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
