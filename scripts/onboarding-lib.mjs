#!/usr/bin/env node
/**
 * Shared onboarding state + cartridge/wallet helpers for the tmux welcome gate.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta, saveMeta, GAME_ID } from "./identity.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SESSIONS = `${ROOT}/sessions`;
export const ONBOARDING_PATH = `${SESSIONS}/.onboarding.json`;
export const WALLET_PATH = `${SESSIONS}/.wallet.json`;
export const PIN_PATH = `${SESSIONS}/.pin`;
export const ART_PATH = `${ROOT}/assets/gotchi-framed.ascii`;

/** Classic 16 Haunt-1 collaterals (plus wbtc/matic as H2 spirits). */
export const COLLATERALS_16 = [
  "usdc", "dai", "weth", "aave", "link", "usdt", "wbtc", "matic",
  "sushi", "yfi", "uni", "tusd", "usdp", "frax", "lusd", "rai",
];

const endpoints = JSON.parse(
  readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"),
);
const CORE =
  process.env.GOTCHIBOT_SUBGRAPH_CORE_URL?.trim() ||
  process.env.AAVEGOTCHI_SUBGRAPH_UPSTREAM_AAVEGOTCHI_CORE_BASE?.trim() ||
  endpoints.subgraphs["aavegotchi-core-base"].url;

const USERS_GOTCHIS_QUERY = `query GotchisOwnedByUser($owner: String!, $first: Int!, $skip: Int!) {
  users(where: { id: $owner }) {
    gotchisOwned(first: $first, skip: $skip, orderBy: id) {
      id
      gotchiId
      name
      collateral
      hauntId
    }
  }
}`;

function subgraphHeaders() {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const key = (process.env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || process.env.SUBGRAPH_PROXY_SECRET || "").trim();
  if (key) {
    headers[endpoints.auth?.header || "X-Subgraph-Proxy-Key"] = key;
  }
  return headers;
}

async function postSubgraph(query, variables) {
  const res = await fetch(CORE, {
    method: "POST",
    headers: subgraphHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "subgraph error");
  return body.data;
}

function normalizeGotchi(g) {
  return {
    gotchiId: String(g.gotchiId ?? g.id),
    name: g.name ?? null,
    collateral: g.collateral ?? null,
    hauntId: g.hauntId ?? null,
  };
}

/** Wallet gotchis via home Envio subgraph (users.gotchisOwned, paginated). */
export async function fetchWalletGotchis(address, { pageSize = 1000, max = 10_000 } = {}) {
  const owner = address.toLowerCase();
  const list = [];
  let skip = 0;

  try {
    while (list.length < max) {
      const data = await postSubgraph(USERS_GOTCHIS_QUERY, { owner, first: pageSize, skip });
      const page = data?.users?.[0]?.gotchisOwned ?? [];
      if (!page.length) break;
      for (const g of page) list.push(normalizeGotchi(g));
      if (page.length < pageSize) break;
      skip += pageSize;
    }
    return list;
  } catch {
    return [];
  }
}

/** Lookup one gotchi by token id for the connected wallet. */
export async function fetchWalletGotchiById(address, gotchiId) {
  const id = String(gotchiId).replace(/^#/, "").trim();
  if (!/^\d+$/.test(id)) return null;
  const owner = address.toLowerCase();

  try {
    const data = await postSubgraph(
      `query GotchiById($owner: String!, $id: String!) {
        aavegotchis(first: 1, where: { id: $id, owner: { id: $owner } }) {
          id gotchiId name collateral hauntId
        }
      }`,
      { owner, id },
    );
    const hit = data?.aavegotchis?.[0];
    if (hit) return normalizeGotchi(hit);
  } catch {}

  const owned = await fetchWalletGotchis(owner);
  return owned.find((g) => String(g.gotchiId) === id) ?? null;
}

export function commandExists(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}

export function readWalletFile() {
  try {
    const w = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    return w.address?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function saveWalletFile(address, source = "metamask") {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(
    WALLET_PATH,
    JSON.stringify({ address: address.toLowerCase(), source, verifiedAt: new Date().toISOString() }, null, 2),
  );
}

export function loadOnboarding() {
  try {
    return JSON.parse(readFileSync(ONBOARDING_PATH, "utf8"));
  } catch {
    return { complete: false };
  }
}

export function saveOnboarding(patch) {
  mkdirSync(SESSIONS, { recursive: true });
  const prev = loadOnboarding();
  writeFileSync(ONBOARDING_PATH, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2));
}

export function clearOnboarding() {
  if (existsSync(ONBOARDING_PATH)) {
    try { writeFileSync(ONBOARDING_PATH, JSON.stringify({ complete: false }, null, 2)); } catch {}
  }
}

export function hasServiceKey() {
  return Boolean(process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET);
}

export function runAbraNode(scriptRel, args = []) {
  const script = `${ROOT}/${scriptRel}`;
  if (hasServiceKey()) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
  }
  if (!commandExists("abra")) {
    return { status: 1, stderr: "abra not found — run: abra run gotchibot -- ./scripts/gotchibot tmux\n" };
  }
  return spawnSync("abra", ["run", "gotchibot", "--", process.execPath, script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
}

export async function fetchCartridgeHeroes(cartridgeId) {
  const r = await call(`/cartridges/${cartridgeId}`);
  if (!r.ok) return [];
  const c = r.data.cartridge ?? r.data;
  return c.cAavegotchis ?? [];
}

export async function ensureCartridgeForOwner(address) {
  const r = await call("/cartridges/ensure", {
    method: "POST",
    body: { owner: address, gameId: GAME_ID, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const cartridgeId = c.id ?? c.cartridgeId;
  saveMeta({ cartridgeId, owner: address });
  saveOnboarding({ wallet: address, cartridgeId });
  return cartridgeId;
}

export async function bindStarterHero(cartridgeId, collateral) {
  const r = await call(`/cartridges/${cartridgeId}/bind-starter`, {
    method: "POST",
    body: { gameId: GAME_ID, collateral, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const heroes = c.cAavegotchis ?? [];
  return heroes[heroes.length - 1]?.id ?? null;
}

export async function bindOwnedGotchi(cartridgeId, sourceTokenId) {
  const r = await call(`/cartridges/${cartridgeId}/bind-owned`, {
    method: "POST",
    body: { sourceTokenId: String(sourceTokenId), simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const hero = c.cAavegotchi ?? (c.cAavegotchis ?? []).find((h) => h.sourceTokenId === String(sourceTokenId));
  return hero?.id ?? null;
}

export async function mintSubAgentHero(cartridgeId, collateral) {
  const r = await call(`/cartridges/${cartridgeId}/subagents/mint`, {
    method: "POST",
    body: { collateral, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const heroes = c.cAavegotchis ?? [];
  return heroes[heroes.length - 1]?.id ?? null;
}

export async function selectOrchestratorHero(cartridgeId, heroId) {
  const r = await call(`/cartridges/${cartridgeId}/select-hero`, {
    method: "POST",
    body: { cAavegotchiId: heroId },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
}

export function pinAvatar(heroId, { asOrchestrator = true } = {}) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(PIN_PATH, `${heroId}\n`);
  saveMeta({ activeHeroId: heroId });
  if (asOrchestrator) {
    saveOnboarding({ orchestratorHeroId: heroId });
  }
  // Refresh official SVG in background (subgraph → sessions/.avatars/<id>.svg)
  try {
    const child = spawn(process.execPath, [`${ROOT}/scripts/gotchi-svg.mjs`, "--force", heroId], {
      cwd: ROOT,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {}
}

export async function isOnboarded() {
  const ob = loadOnboarding();
  if (!ob.complete || !ob.orchestratorHeroId) return false;
  const wallet = readWalletFile();
  if (!wallet) return false;
  const meta = loadMeta();
  if (!meta?.cartridgeId) return false;
  const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
  return heroes.some((h) => h.id === ob.orchestratorHeroId);
}

export function readWelcomeArt(maxLines = 18) {
  try {
    return readFileSync(ART_PATH, "utf8").split("\n").slice(0, maxLines).join("\n");
  } catch {
    return "  GotchiBot — Aavegotchi orchestrator";
  }
}

export function resolveOwner() {
  return readWalletFile();
}

function isDirectCheck() {
  return process.argv[1]?.endsWith("onboarding-lib.mjs") && process.argv[2] === "check";
}

if (isDirectCheck()) {
  isOnboarded().then((ok) => process.exit(ok ? 0 : 1));
}
