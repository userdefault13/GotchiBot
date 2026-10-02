/**
 * Desk cockpit snapshot — the phone's read-only mirror of the terminal
 * cockpit (header, roster, kanban, inbox, Hub network).
 *
 * The desk collects it (scripts/hub-projects-push.mjs) and pushes to the Hub;
 * the Hub stores only what validateCockpitSnapshot allows. Phones read it via
 * GET /api/gotchibot/cockpit.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOwnerWallet } from "./wallet.mjs";

export const COCKPIT_MAX_BYTES = 256 * 1024;
const MAX_AGENTS = 200;
const MAX_CARDS_PER_COLUMN = 60;
const MAX_COLUMNS = 12;
const MAX_MESSAGES = 50;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function cockpitError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Trimmed string capped at max chars, or null. */
function str(v, max = 80) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  return v === true;
}

function iso(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function list(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function header(h) {
  const o = h && typeof h === "object" ? h : {};
  const orch = o.orchestrator && typeof o.orchestrator === "object" ? o.orchestrator : {};
  const wallet = typeof o.wallet === "string" && ADDRESS_RE.test(o.wallet) ? o.wallet.toLowerCase() : null;
  return {
    wallet,
    cartridgeId: str(o.cartridgeId, 40),
    cartridgeChain: str(o.cartridgeChain, 40),
    orchestrator: orch.id ? { id: str(orch.id, 64), name: str(orch.name, 64), collateral: str(orch.collateral, 16) } : null,
    rosterCount: num(o.rosterCount),
    project: str(o.project, 64),
    deskName: str(o.deskName, 64),
  };
}

function agent(a) {
  return {
    id: str(a?.id, 64),
    name: str(a?.name, 64),
    host: str(a?.host, 24),
    kind: str(a?.kind, 24),
    status: str(a?.status, 24),
    collateral: str(a?.collateral, 16),
    task: str(a?.task, 200),
  };
}

function roster(r) {
  const o = r && typeof r === "object" ? r : {};
  return {
    heroes: num(o.heroes),
    local: num(o.local),
    remoteOk: bool(o.remoteOk),
    remoteReason: str(o.remoteReason, 120),
    agents: list(o.agents, MAX_AGENTS).map(agent).filter((a) => a.id),
  };
}

function card(c) {
  return {
    id: str(c?.id, 64),
    name: str(c?.name, 64),
    status: str(c?.status, 24),
    collateral: str(c?.collateral, 16),
    host: str(c?.host, 24),
    role: str(c?.role, 48),
    task: str(c?.task, 200),
    age: str(c?.age, 24),
    chief: bool(c?.chief),
    stale: bool(c?.stale),
  };
}

function kanban(k) {
  const o = k && typeof k === "object" ? k : {};
  return {
    seatsTotal: num(o.seatsTotal),
    seatsUsed: num(o.seatsUsed),
    seatsFree: num(o.seatsFree),
    columns: list(o.columns, MAX_COLUMNS)
      .map((col) => ({
        key: str(col?.key, 24),
        title: str(col?.title, 40),
        cards: list(col?.cards, MAX_CARDS_PER_COLUMN).map(card).filter((c) => c.id),
      }))
      .filter((col) => col.key),
  };
}

function message(m) {
  return {
    id: str(m?.id, 64),
    from: str(m?.from, 64),
    to: str(m?.to, 64),
    kind: str(m?.kind, 16),
    subject: str(m?.subject, 120),
    body: str(m?.body, 500),
    ts: iso(m?.ts),
    read: bool(m?.read),
  };
}

function inbox(i) {
  const o = i && typeof i === "object" ? i : {};
  return {
    project: str(o.project, 64),
    unread: num(o.unread) ?? 0,
    messages: list(o.messages, MAX_MESSAGES).map(message).filter((m) => m.id),
  };
}

function hub(h) {
  const o = h && typeof h === "object" ? h : {};
  return {
    deskPaired: bool(o.deskPaired),
    hubInstalled: bool(o.hubInstalled),
    hubHost: str(o.hubHost, 120),
    deskName: str(o.deskName, 64),
  };
}

/**
 * Keep only the allow-listed cockpit fields; unknown keys are dropped.
 * @returns {{ collectedAt: string|null, header: object, roster: object, kanban: object, inbox: object, hub: object }}
 */
export function validateCockpitSnapshot(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw cockpitError("cockpit object required");
  const out = {
    collectedAt: iso(body.collectedAt),
    header: header(body.header),
    roster: roster(body.roster),
    kanban: kanban(body.kanban),
    inbox: inbox(body.inbox),
    hub: hub(body.hub),
  };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > COCKPIT_MAX_BYTES) throw cockpitError("cockpit snapshot too large");
  return out;
}

function hostOf(base) {
  return String(base || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "") || null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** node scripts/<name> …args → parsed JSON stdout, or null. */
function runJson(root, script, args) {
  const r = spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const text = String(r.stdout || "");
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

async function optionalImport(root, script) {
  try {
    return await import(join(root, "scripts", script));
  } catch {
    return null;
  }
}

/**
 * Desk side: gather the cockpit from the same sources the terminal cockpit
 * uses (no abra, no SSH beyond what `agent-focus list` already caches).
 * @param {{ root: string, sources?: Partial<Record<"roster"|"kanban"|"inbox"|"hub"|"onboarding"|"project"|"heroName", Function>> }} opts
 */
export async function collectCockpitSnapshot({ root, sources = {} } = {}) {
  const [fleet, inboxMod, hubMod, projectMod] = await Promise.all([
    sources.heroName ? null : optionalImport(root, "openclaw-fleet.mjs"),
    sources.inbox ? null : optionalImport(root, "bot-inbox.mjs"),
    sources.hub ? null : optionalImport(root, "hub-network.mjs"),
    sources.project ? null : optionalImport(root, "project-context.mjs"),
  ]);
  const heroName = sources.heroName || fleet?.heroDisplayName || (() => null);
  const nameOf = (id, raw) => {
    if (typeof raw === "string" && raw.trim()) return raw;
    try {
      return heroName(id) || null;
    } catch {
      return null;
    }
  };
  const safe = (fn, fallback) => {
    try {
      return fn() ?? fallback;
    } catch {
      return fallback;
    }
  };

  const rosterRaw = safe(sources.roster || (() => runJson(root, "agent-focus.mjs", ["list", "--json"])), null);
  const kanbanRaw = safe(sources.kanban || (() => runJson(root, "gotchi-kanban.mjs", ["--json"])), null);
  const onboarding = safe(sources.onboarding || (() => readJson(join(root, "sessions/.onboarding.json"))), {}) || {};
  const project = safe(sources.project || (() => projectMod?.currentProjectSlug?.() ?? null), null);
  const net = safe(sources.hub || (() => hubMod?.hubNetworkSummary?.() ?? null), null) || {};
  const inboxRaw = safe(
    sources.inbox ||
      (() => ({
        digest: inboxMod?.digest?.() ?? null,
        messages: inboxMod?.listMessages?.({ to: "userdefault" }) ?? [],
      })),
    { digest: null, messages: [] },
  );

  const numbered = Array.isArray(rosterRaw?.numbered) ? rosterRaw.numbered : [];
  const agents = numbered.map((a) => ({
    id: a.id,
    name: nameOf(a.id, a.name),
    host: a.host,
    kind: a.kind,
    status: a.status,
    collateral: a.collateral,
    task: typeof a.agentTask === "string" ? a.agentTask : a.agentTask?.prompt || a.agentTask?.title || null,
  }));
  const orchId = onboarding.orchestratorHeroId || kanbanRaw?.orchId || null;
  const orchRow = numbered.find((a) => a.id === orchId);

  const columns = (Array.isArray(kanbanRaw?.categories) ? kanbanRaw.categories : []).map((cat) => ({
    key: cat.key,
    title: cat.title,
    cards: (Array.isArray(cat.items) ? cat.items : []).map((c) => ({
      id: c.id,
      name: nameOf(c.id, c.name),
      status: c.status,
      collateral: c.collateral,
      host: c.host,
      role: c.roleTitle || c.role,
      task: typeof c.task === "string" ? c.task : c.task?.prompt || c.task?.title || null,
      age: c.ageLabel,
      chief: c.isChief,
      stale: c.stale,
    })),
  }));

  const messages = (Array.isArray(inboxRaw.messages) ? inboxRaw.messages : []).map((m) => ({
    id: m.id,
    from: m.from,
    to: m.to,
    kind: m.kind,
    subject: m.subject,
    body: m.body,
    ts: m.ts,
    read: Boolean(m.readAt),
  }));

  return validateCockpitSnapshot({
    collectedAt: new Date().toISOString(),
    header: {
      wallet: resolveOwnerWallet({}, root),
      cartridgeId: onboarding.cartridgeId ?? null,
      cartridgeChain: onboarding.cartridgeId ? "Base" : null,
      orchestrator: orchId ? { id: orchId, name: nameOf(orchId, orchRow?.name), collateral: orchRow?.collateral } : null,
      rosterCount: rosterRaw?.heroes ?? numbered.length,
      project,
      deskName: net.deskName,
    },
    roster: {
      heroes: rosterRaw?.heroes,
      local: rosterRaw?.local,
      remoteOk: Boolean(rosterRaw?.remote?.ok),
      remoteReason: rosterRaw?.remote?.ok ? null : rosterRaw?.remote?.reason,
      agents,
    },
    kanban: {
      seatsTotal: kanbanRaw?.seatsTotal,
      seatsUsed: kanbanRaw?.seatsUsed,
      seatsFree: kanbanRaw?.seatsFree,
      columns,
    },
    inbox: {
      project: inboxRaw.digest?.project,
      unread: messages.filter((m) => !m.read).length,
      messages,
    },
    hub: {
      deskPaired: net.deskPaired,
      hubInstalled: net.hubInstalled,
      hubHost: hostOf(net.deskApiBase) || (typeof net.hubTailscaleHost === "string" ? net.hubTailscaleHost : null),
      deskName: net.deskName,
    },
  });
}
