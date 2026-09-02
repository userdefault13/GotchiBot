#!/usr/bin/env node
/**
 * Fetch gotchi SVG for terminal avatars.
 *
 * Primary: Envio core subgraph `aavegotchis { svg }` (indexed preview).
 * Fallback: diamond previewAavegotchi(hauntId, collateral, traits, wearables).
 *
 * usage:
 *   node scripts/gotchi-svg.mjs [heroId|tokenId]
 *   node scripts/gotchi-svg.mjs --render [heroId|tokenId]
 *   node scripts/gotchi-svg.mjs --refresh   # pin / active hero
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta } from "./identity.mjs";
import { resolveSubgraphUrl, infraHeaders } from "./infra-client.mjs";
import { resolveCastBin, commandExists } from "./platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const AVATARS = `${SESSIONS}/.avatars`;
const PIN = `${SESSIONS}/.pin`;

const endpoints = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
function coreSubgraphUrl() {
  return process.env.GOTCHIBOT_SUBGRAPH_CORE_URL?.trim() || resolveSubgraphUrl("aavegotchi-core-base");
}
const DIAMOND = "0xA99c4B08201F2913Db8D28e71d020c4298F29dBF";

const CAST_BIN = resolveCastBin();
const BASE_RPC = process.env.GOTCHIBOT_BASE_RPC ?? "https://mainnet.base.org";

function subgraphHeaders() {
  return { "Content-Type": "application/json", ...infraHeaders() };
}

async function postSubgraph(query, variables) {
  const res = await fetch(coreSubgraphUrl(), {
    method: "POST",
    headers: subgraphHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "subgraph error");
  return body.data;
}

function tokenIdFromHeroId(heroId) {
  const m = /^owned-(\d+)$/i.exec(String(heroId || ""));
  return m ? m[1] : null;
}

function readPin() {
  try {
    return readFileSync(PIN, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function resolveHero(arg) {
  const meta = loadMeta();
  const pin = readPin();
  let heroId = arg && !/^\d+$/.test(arg) ? arg : (pin || meta?.activeHeroId || null);
  let tokenId = arg && /^\d+$/.test(arg) ? arg : tokenIdFromHeroId(heroId);

  let hero = null;
  if (meta?.cartridgeId) {
    const r = await call(`/cartridges/${meta.cartridgeId}`);
    if (r.ok) {
      const c = r.data.cartridge ?? r.data;
      const roster = c.cAavegotchis ?? [];
      hero =
        roster.find((h) => h.id === heroId) ||
        roster.find((h) => String(h.sourceTokenId) === String(tokenId)) ||
        roster.find((h) => h.id === meta.activeHeroId) ||
        c.activeCAavegotchi ||
        roster[0] ||
        null;
      if (hero) {
        heroId = hero.id;
        tokenId = tokenId || hero.sourceTokenId || tokenIdFromHeroId(hero.id);
      }
    }
  }

  return { heroId: heroId || (tokenId ? `owned-${tokenId}` : null), tokenId: tokenId ? String(tokenId) : null, hero };
}

async function fetchSvgFromSubgraph(tokenId) {
  const data = await postSubgraph(
    `query GotchiSvg($id: String!) {
      aavegotchis(first: 1, where: { id: $id }) {
        id name svg hauntId collateral numericTraits equippedWearables
      }
    }`,
    { id: String(tokenId) },
  );
  const g = data?.aavegotchis?.[0];
  if (!g?.svg) return null;
  return { svg: g.svg, source: "subgraph", gotchi: g };
}

function castExists() {
  try {
    return existsSync(CAST_BIN) || spawnSync("command", ["-v", "cast"], { shell: true, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function previewAavegotchiRpc({ hauntId, collateral, traits, equipped }) {
  if (!castExists()) return null;
  const bin = existsSync(CAST_BIN) ? CAST_BIN : "cast";
  const haunt = String(hauntId ?? 1);
  const coll = String(collateral);
  const traitsArg = `[${(traits || []).slice(0, 6).map((t) => String(Math.round(Number(t) || 0))).join(",")}]`;
  const equip = Array.isArray(equipped) ? equipped.map((n) => Number(n) || 0) : [];
  while (equip.length < 16) equip.push(0);
  const equipArg = `[${equip.slice(0, 16).join(",")}]`;

  const data = execFileSync(
    bin,
    [
      "calldata",
      "previewAavegotchi(uint256,address,int16[6],uint16[16])(string)",
      haunt,
      coll,
      traitsArg,
      equipArg,
    ],
    { encoding: "utf8" },
  ).trim();

  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: DIAMOND, data }, "latest"],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "previewAavegotchi eth_call failed");
  const decoded = execFileSync(
    bin,
    ["abi-decode", "previewAavegotchi(uint256,address,int16[6],uint16[16])(string)", json.result],
    { encoding: "utf8" },
  ).trim();
  // cast abi-decode may wrap string in quotes
  const svg = decoded.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
  if (!svg.includes("<svg")) return null;
  return svg;
}

async function fetchSvgPreviewFallback(hero, tokenId) {
  let hauntId = hero?.hauntId ?? 1;
  let collateral = hero?.collateralAddress || hero?.collateral;
  let traits = hero?.modifiedTraits || hero?.traits;
  let equipped = hero?.l1EquippedWearables || hero?.equippedWearables;

  if ((!collateral || !traits?.length) && tokenId) {
    const data = await postSubgraph(
      `query GotchiPreview($id: String!) {
        aavegotchis(first: 1, where: { id: $id }) {
          hauntId collateral numericTraits equippedWearables
        }
      }`,
      { id: String(tokenId) },
    );
    const g = data?.aavegotchis?.[0];
    if (g) {
      hauntId = g.hauntId ?? hauntId;
      collateral = g.collateral || collateral;
      traits = g.numericTraits || traits;
      equipped = g.equippedWearables || equipped;
    }
  }

  if (!collateral || !traits?.length) return null;
  const svg = await previewAavegotchiRpc({ hauntId, collateral, traits, equipped });
  return svg ? { svg, source: "previewAavegotchi" } : null;
}

function saveSvg(heroId, svg) {
  mkdirSync(AVATARS, { recursive: true });
  const path = `${AVATARS}/${heroId}.svg`;
  writeFileSync(path, svg);
  return path;
}

function renderChafa(svgPath) {
  const cols = Number(process.env.GOTCHIBOT_AVATAR_COLS || 40);
  const rows = Number(process.env.GOTCHIBOT_AVATAR_ROWS || 26);
  const r = spawnSync(
    "chafa",
    ["--size", `${cols}x${rows}`, "--symbols", "block", svgPath],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error((r.stderr || "chafa failed").trim());
  return r.stdout;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const render = process.argv.includes("--render");
  const refresh = process.argv.includes("--refresh");
  const arg = args[0];

  const { heroId, tokenId, hero } = await resolveHero(refresh ? null : arg);
  if (!heroId) {
    console.error("no hero pinned — run onboarding or: gotchibot avatar <heroId>");
    process.exit(1);
  }

  const outPath = `${AVATARS}/${heroId}.svg`;
  if (!refresh && !process.argv.includes("--force") && existsSync(outPath) && !arg) {
    if (render) process.stdout.write(renderChafa(outPath));
    else console.log(outPath);
    return;
  }

  let result = null;
  if (tokenId) {
    try {
      result = await fetchSvgFromSubgraph(tokenId);
    } catch (e) {
      console.error(`subgraph svg failed: ${e.message}`);
    }
  }
  if (!result?.svg) {
    try {
      result = await fetchSvgPreviewFallback(hero, tokenId);
    } catch (e) {
      console.error(`previewAavegotchi failed: ${e.message}`);
    }
  }
  if (!result?.svg) {
    console.error(`no SVG for ${heroId}${tokenId ? ` (#${tokenId})` : ""}`);
    process.exit(1);
  }

  const path = saveSvg(heroId, result.svg);
  if (render) {
    process.stdout.write(renderChafa(path));
  } else {
    console.log(`${path}  (${result.source}${tokenId ? ` #${tokenId}` : ""})`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
