/**
 * Pure / injectable helpers for Sepolia mint readback.
 * No live RPC unless the caller injects getReceipt / readHeroIds that do I/O.
 *
 * Readback order after a mined successful receipt:
 *   1. CAavegotchiBound log on cartridgeDiamond (heroId = topics[2])
 *   2. last element of heroIds(cartridgeId)
 *   3. deterministic formula (owned- / starter-)
 *
 * Never record a hero without a successful receipt.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const CAVEGOTCHI_BOUND_TOPIC0 =
  "0x1827e5bd6f1d1f8b1db16accce3f4eaa3a7db62d925e97e9eb749276c400baa9";

const BIND_TYPE = Object.freeze({
  None: 0,
  Owned: 1,
  Rented: 2,
  Starter: 3,
});

export { CAVEGOTCHI_BOUND_TOPIC0, BIND_TYPE };

function sessionsDir(override) {
  if (override) return resolve(override);
  const o = process.env.GOTCHIBOT_SESSIONS_DIR;
  return o ? resolve(o) : join(ROOT, "sessions");
}

export function onchainHeroIdsPath(sessionsOverride) {
  return join(sessionsDir(sessionsOverride), ".onchain-hero-ids.json");
}

/**
 * Confirmed by Aarcadeghst CoS from ChainCartridgeProvider.ts bindStarter:
 * templateId = keccak256(toUtf8Bytes(name)) where name = lowercase collateral id
 * (dai, weth, wbtc, aave, usdc, tesla, …). Contract does not validate templateId;
 * it only feeds the starter hero-id hash.
 * 0x-prefixed 32-byte hex → return unchanged.
 */
export function encodeTemplateId(id, ethersLib) {
  if (!ethersLib) throw new Error("encodeTemplateId requires ethers");
  const s = String(id ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  return ethersLib.keccak256(ethersLib.toUtf8Bytes(s.toLowerCase()));
}

/** On-chain owned heroId = keccak256(abi.encodePacked("owned-", uint256 sourceTokenId)) */
export function ownedHeroIdBytes32(sourceTokenId, ethersLib) {
  if (!ethersLib?.solidityPackedKeccak256) throw new Error("ownedHeroIdBytes32 requires ethers.solidityPackedKeccak256");
  return ethersLib.solidityPackedKeccak256(
    ["string", "uint256"],
    ["owned-", BigInt(sourceTokenId)],
  );
}

/**
 * On-chain starter heroId = keccak256(abi.encodePacked("starter-", bytes32 templateId, "-", uint256 n))
 * where n = heroIds.length BEFORE the bind.
 */
export function starterHeroIdBytes32(templateIdBytes32, n, ethersLib) {
  if (!ethersLib?.solidityPackedKeccak256) throw new Error("starterHeroIdBytes32 requires ethers.solidityPackedKeccak256");
  return ethersLib.solidityPackedKeccak256(
    ["string", "bytes32", "string", "uint256"],
    ["starter-", templateIdBytes32, "-", BigInt(n)],
  );
}

/**
 * Next desk label for a Sepolia starter bind.
 * `starter-<collateralId>-h<haunt>-<k>` where k = 1 + max existing k among knownIds
 * matching that prefix (ignores non-matching and bytes32 entries).
 *
 * @param {string} collateralId
 * @param {number|string} hauntId
 * @param {Iterable<string>|string[]} knownIds
 * @returns {string}
 */
export function nextStarterDeskLabel(collateralId, hauntId, knownIds = []) {
  const coll = String(collateralId ?? "").trim();
  const haunt = Number(hauntId);
  const hauntPart = Number.isFinite(haunt) ? String(haunt) : String(hauntId ?? "1");
  const prefix = `starter-${coll}-h${hauntPart}-`;
  let maxK = 0;
  for (const raw of knownIds || []) {
    const id = String(raw ?? "");
    if (!id || BYTES32_RE.test(id)) continue;
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const k = Number(rest);
    if (k > maxK) maxK = k;
  }
  return `${prefix}${maxK + 1}`;
}

/**
 * Deterministic desk id after a successful Sepolia bind readback.
 * Owned always uses `owned-<tokenId>` (records actual on-chain bytes32 separately).
 * Starter uses {@link nextStarterDeskLabel}.
 *
 * @returns {{ deskId: string, warning: string|null }}
 */
export function deskIdForBind({
  kind,
  tokenId = null,
  collateralId = null,
  hauntId = 1,
  knownIds = [],
  heroIdBytes32 = null,
  ethersLib = null,
} = {}) {
  const k = String(kind || "").toLowerCase();
  if (k === "owned") {
    const tid = String(tokenId ?? "").trim();
    const deskId = `owned-${tid}`;
    let warning = null;
    if (heroIdBytes32 != null && ethersLib?.solidityPackedKeccak256) {
      const expected = ownedHeroIdBytes32(tid, ethersLib);
      if (String(heroIdBytes32).toLowerCase() !== String(expected).toLowerCase()) {
        warning =
          `owned heroIdBytes32 mismatch: on-chain ${heroIdBytes32} ≠ formula ${expected} — still using ${deskId}`;
      }
    }
    return { deskId, warning };
  }
  if (k === "starter") {
    return {
      deskId: nextStarterDeskLabel(collateralId, hauntId, knownIds),
      warning: null,
    };
  }
  throw new Error(`deskIdForBind: unknown kind "${kind}"`);
}

/**
 * Collect desk ids that already occupy starter/owned labels (pure when sources injected).
 * Union of: onchain map keys ∪ plain-string nest ids ∪ hero-agent-state keys ∪ workspace dirs.
 *
 * @param {{
 *   onchainHeroIds?: Record<string, unknown>,
 *   nestIds?: string[],
 *   heroAgentState?: Record<string, unknown>|null,
 *   workspaceNames?: string[],
 *   sessionsDir?: string,
 *   workspacesDir?: string,
 *   readFile?: (path: string) => string,
 *   readdir?: (path: string) => string[],
 *   loadOnchain?: () => Record<string, unknown>,
 * }} [opts]
 * @returns {string[]}
 */
export function collectKnownDeskIds(opts = {}) {
  const ids = new Set();

  let onchain = opts.onchainHeroIds;
  if (onchain == null && typeof opts.loadOnchain === "function") {
    try {
      onchain = opts.loadOnchain();
    } catch {
      onchain = {};
    }
  }
  if (onchain == null) {
    try {
      onchain = loadOnchainHeroIds(opts);
    } catch {
      onchain = {};
    }
  }
  for (const key of Object.keys(onchain || {})) {
    if (key) ids.add(String(key));
  }

  for (const raw of opts.nestIds || []) {
    const id = String(raw ?? "");
    if (!id || BYTES32_RE.test(id)) continue;
    ids.add(id);
  }

  let agentState = opts.heroAgentState;
  if (agentState === undefined) {
    const statePath = join(
      opts.sessionsDir ? resolve(opts.sessionsDir) : sessionsDir(),
      ".hero-agent-state.json",
    );
    try {
      const body =
        typeof opts.readFile === "function"
          ? opts.readFile(statePath)
          : readFileSync(statePath, "utf8");
      agentState = JSON.parse(body || "{}");
    } catch {
      agentState = null;
    }
  }
  if (agentState && typeof agentState === "object") {
    for (const key of Object.keys(agentState)) {
      if (key) ids.add(String(key));
    }
  }

  let workspaceNames = opts.workspaceNames;
  if (workspaceNames == null) {
    const wsDir =
      opts.workspacesDir ||
      join(ROOT, "config", "openclaw", "workspaces");
    try {
      const names =
        typeof opts.readdir === "function"
          ? opts.readdir(wsDir)
          : readdirSync(wsDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name);
      workspaceNames = names;
    } catch {
      workspaceNames = [];
    }
  }
  for (const name of workspaceNames || []) {
    if (name) ids.add(String(name));
  }

  return [...ids];
}

/**
 * Pick the new hero id after a successful bind (desk-label diff helper).
 * Kept for SIM callers/tests — Sepolia bind path uses {@link deskIdForBind} instead.
 *
 * @param {{
 *   beforeIds: string[],
 *   afterIds: string[],
 *   hintIncludes?: string|null,
 *   preferredId?: string|null,
 * }} opts
 * @returns {{ id: string|null, source: "confirmed"|"readback"|"guess"|"none", note: string|null, candidates?: string[] }}
 */
export function pickNewHeroFromDiff({
  beforeIds = [],
  afterIds = [],
  hintIncludes = null,
  preferredId = null,
} = {}) {
  const before = new Set((beforeIds || []).map(String));
  const after = (afterIds || []).map(String);
  const preferred = preferredId != null ? String(preferredId) : null;
  const hint = hintIncludes != null ? String(hintIncludes) : null;

  if (preferred && after.includes(preferred)) {
    return { id: preferred, source: "confirmed", note: null };
  }

  const added = after.filter((id) => !before.has(id));

  if (hint) {
    const hits = added.filter((id) => id.includes(hint));
    if (preferred && hits.includes(preferred)) {
      return { id: preferred, source: "readback", note: null };
    }
    if (hits.length === 1) {
      return { id: hits[0], source: "readback", note: null };
    }
    if (hits.length > 1) {
      return {
        id: hits[0],
        source: "readback",
        note: `multiple new ids matched hint "${hint}"; picked ${hits[0]}`,
        candidates: hits,
      };
    }
  }

  if (added.length === 1) {
    return { id: added[0], source: "readback", note: null };
  }

  if (preferred) {
    return {
      id: preferred,
      source: "guess",
      note: "readback failed — using computed id",
      candidates: added,
    };
  }

  return {
    id: null,
    source: "none",
    note: "no new hero id found",
    candidates: added,
  };
}

/**
 * Interpret a bindOwned/bindStarter result object (never throws).
 */
export function interpretBindResult(bound) {
  if (!bound || typeof bound !== "object") {
    return { ok: false, code: "NO_RESULT", error: "no bind result", txHash: null };
  }
  if (bound.ok) {
    return {
      ok: true,
      code: null,
      error: null,
      txHash: bound.txHash ? String(bound.txHash) : null,
    };
  }
  const code = bound.code ? String(bound.code) : "BIND_FAILED";
  const error = bound.error ? String(bound.error) : "bind failed";
  return {
    ok: false,
    code,
    error,
    txHash: bound.txHash ? String(bound.txHash) : null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll eth_getTransactionReceipt until mined or timeout.
 * @returns {{ ok:true, receipt } | { ok:false, code:"RECEIPT_TIMEOUT"|"TX_REVERTED", txHash, receipt?:object }}
 */
export async function waitForBindReceipt(txHash, opts = {}) {
  const hash = String(txHash || "");
  if (!hash) {
    return { ok: false, code: "RECEIPT_TIMEOUT", txHash: null, error: "missing txHash" };
  }
  const getReceipt = opts.getReceipt;
  if (typeof getReceipt !== "function") {
    throw new Error("waitForBindReceipt requires injectable getReceipt");
  }
  const intervalMs = Number(opts.intervalMs ?? 2000);
  const timeoutMs = Number(opts.timeoutMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await getReceipt(hash);
    if (last) {
      const status = last.status;
      const ok =
        status === 1 ||
        status === "0x1" ||
        status === true ||
        Number(status) === 1;
      const bad =
        status === 0 ||
        status === "0x0" ||
        status === false ||
        Number(status) === 0;
      if (ok) return { ok: true, receipt: last, txHash: hash };
      if (bad) {
        return { ok: false, code: "TX_REVERTED", txHash: hash, receipt: last };
      }
    }
    await sleep(intervalMs);
  }
  return { ok: false, code: "RECEIPT_TIMEOUT", txHash: hash, receipt: last };
}

/**
 * Parse CAavegotchiBound from a receipt (cartridgeDiamond + topic0).
 */
export function parseCAavegotchiBoundLog(receipt, opts = {}) {
  const diamond = String(opts.cartridgeDiamond || "").toLowerCase();
  const topic0 = String(opts.topic0 || CAVEGOTCHI_BOUND_TOPIC0).toLowerCase();
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const ethersLib = opts.ethersLib || null;
  const eventFrag = opts.eventFragment || null;

  for (const log of logs) {
    const addr = String(log.address || "").toLowerCase();
    if (diamond && addr && addr !== diamond) continue;
    const topics = (log.topics || []).map(String);
    if (!topics.length || topics[0].toLowerCase() !== topic0) continue;
    const heroId = topics[2] || null;
    let bindType = null;
    let sourceTokenId = null;
    if (ethersLib && eventFrag) {
      try {
        const iface = new ethersLib.Interface([eventFrag]);
        const decoded = iface.parseLog({ topics, data: log.data || "0x" });
        bindType = decoded?.args?.bindType != null ? Number(decoded.args.bindType) : null;
        sourceTokenId =
          decoded?.args?.sourceTokenId != null ? String(decoded.args.sourceTokenId) : null;
      } catch {
        /* fall through with topics only */
      }
    }
    return {
      heroIdBytes32: heroId,
      bindType,
      sourceTokenId,
      cartridgeIdTopic: topics[1] || null,
      source: "event",
    };
  }
  return null;
}

/**
 * Resolve on-chain heroId bytes32 after a successful receipt.
 * Order: event log → last heroIds → deterministic.
 */
export async function resolveHeroIdAfterReceipt(opts = {}) {
  const {
    receipt,
    cartridgeDiamond,
    topic0 = CAVEGOTCHI_BOUND_TOPIC0,
    eventFragment = null,
    cartridgeId,
    bindKind, // "owned" | "starter"
    sourceTokenId = null,
    templateId = null,
    heroIdsBefore = null,
    readHeroIds = null,
    ethersLib = null,
  } = opts;

  const fromLog = parseCAavegotchiBoundLog(receipt, {
    cartridgeDiamond,
    topic0,
    ethersLib,
    eventFragment,
  });
  if (fromLog?.heroIdBytes32) {
    return {
      ok: true,
      heroIdBytes32: fromLog.heroIdBytes32,
      bindType: fromLog.bindType,
      sourceTokenId: fromLog.sourceTokenId ?? sourceTokenId,
      source: "event",
    };
  }

  let heroIds = null;
  if (typeof readHeroIds === "function" && cartridgeId != null) {
    heroIds = await readHeroIds(cartridgeId);
  }
  if (Array.isArray(heroIds) && heroIds.length) {
    const last = String(heroIds[heroIds.length - 1]);
    return {
      ok: true,
      heroIdBytes32: last,
      bindType: bindKind === "starter" ? BIND_TYPE.Starter : BIND_TYPE.Owned,
      sourceTokenId,
      source: "heroIds",
    };
  }

  if (!ethersLib) {
    return { ok: false, code: "NO_HERO", error: "no event/heroIds and no ethers for deterministic id" };
  }

  if (bindKind === "owned" && sourceTokenId != null) {
    return {
      ok: true,
      heroIdBytes32: ownedHeroIdBytes32(sourceTokenId, ethersLib),
      bindType: BIND_TYPE.Owned,
      sourceTokenId: String(sourceTokenId),
      source: "deterministic",
    };
  }

  if (bindKind === "starter" && templateId != null) {
    const tid = encodeTemplateId(templateId, ethersLib);
    const n = Array.isArray(heroIdsBefore)
      ? heroIdsBefore.length
      : Array.isArray(heroIds)
        ? Math.max(0, heroIds.length - 1)
        : 0;
    return {
      ok: true,
      heroIdBytes32: starterHeroIdBytes32(tid, n, ethersLib),
      bindType: BIND_TYPE.Starter,
      sourceTokenId: null,
      source: "deterministic",
      templateIdBytes32: tid,
      n,
    };
  }

  return { ok: false, code: "NO_HERO", error: "could not resolve heroId" };
}

export function loadOnchainHeroIds(opts = {}) {
  const path = opts.path || onchainHeroIdsPath(opts.sessionsDir);
  try {
    if (typeof opts.readFile === "function") {
      return JSON.parse(opts.readFile(path) || "{}");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Persist deskId → on-chain bytes32 mapping (source of truth for starter matcher).
 */
export function recordOnchainHeroId(deskId, record, opts = {}) {
  const path = opts.path || onchainHeroIdsPath(opts.sessionsDir);
  const map = loadOnchainHeroIds({ ...opts, path });
  map[String(deskId)] = {
    heroIdBytes32: String(record.heroIdBytes32),
    chainId: record.chainId != null ? Number(record.chainId) : null,
    txHash: record.txHash ? String(record.txHash) : null,
    bindType: record.bindType != null ? Number(record.bindType) : null,
    source: record.source ? String(record.source) : null,
    sourceTokenId: record.sourceTokenId != null ? String(record.sourceTokenId) : null,
    recordedAt: new Date().toISOString(),
  };
  if (typeof opts.writeFile === "function") {
    opts.writeFile(path, `${JSON.stringify(map, null, 2)}\n`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
  }
  return map[String(deskId)];
}

/**
 * Full post-submit path: wait receipt → resolve hero → optionally record.
 * Does NOT record on timeout/revert.
 */
export async function readbackAfterBind(opts = {}) {
  const txHash = opts.txHash;
  const waited = await waitForBindReceipt(txHash, {
    getReceipt: opts.getReceipt,
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
  });
  if (!waited.ok) {
    return {
      ok: false,
      code: waited.code,
      txHash: waited.txHash || txHash,
      error:
        waited.code === "TX_REVERTED"
          ? "bind tx reverted — no hero recorded"
          : "receipt timed out — retry readback later",
    };
  }

  const resolved = await resolveHeroIdAfterReceipt({
    receipt: waited.receipt,
    cartridgeDiamond: opts.cartridgeDiamond,
    topic0: opts.topic0,
    eventFragment: opts.eventFragment,
    cartridgeId: opts.cartridgeId,
    bindKind: opts.bindKind,
    sourceTokenId: opts.sourceTokenId,
    templateId: opts.templateId,
    heroIdsBefore: opts.heroIdsBefore,
    readHeroIds: opts.readHeroIds,
    ethersLib: opts.ethersLib,
  });

  if (!resolved.ok) {
    return { ok: false, code: resolved.code || "NO_HERO", txHash, error: resolved.error };
  }

  const deskId = opts.deskId || null;
  if (deskId && opts.record !== false) {
    recordOnchainHeroId(
      deskId,
      {
        heroIdBytes32: resolved.heroIdBytes32,
        chainId: opts.chainId,
        txHash,
        bindType: resolved.bindType,
        source: resolved.source,
        sourceTokenId: resolved.sourceTokenId,
      },
      { sessionsDir: opts.sessionsDir, path: opts.onchainPath, writeFile: opts.writeFile, readFile: opts.readFile },
    );
  }

  return {
    ok: true,
    txHash,
    heroIdBytes32: resolved.heroIdBytes32,
    bindType: resolved.bindType,
    source: resolved.source,
    deskId,
  };
}
