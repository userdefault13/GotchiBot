#!/usr/bin/env node
/**
 * Desk identity: sessions/.identity.json + the Base Sepolia cartridge.
 *
 *   node scripts/identity.mjs roster                         heroes on the desk cartridge
 *   node scripts/identity.mjs bind --session <id> [--hero <id>]   pin a cartridge hero to a session
 *   node scripts/identity.mjs checkpoint                     local snapshot for checkpointSave
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { isMainModule } from "./is-main.mjs";
import { isSepoliaCartridgeId, readSepoliaHeroes } from "./cartridge-sepolia.mjs";
import crypto from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function owner() {
  // Headless/service only (abra run gotchibot -- …). Interactive flows use sessions/.wallet.json.
  if (process.env.GOTCHIBOT_OWNER) return process.env.GOTCHIBOT_OWNER;
  try {
    const w = JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8"));
    if (w.address) return w.address;
  } catch {}
  console.error("no wallet. Connect once:\n" +
    "  ./scripts/gotchibot connect   # MetaMask popup in browser");
  process.exit(1);
}

function requireSepoliaCart(meta) {
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: ./scripts/gotchibot connect");
    process.exit(1);
  }
  if (!isSepoliaCartridgeId(meta.cartridgeId)) {
    console.error(`not a Base Sepolia cartridge id: ${meta.cartridgeId} — run: ./scripts/gotchibot connect`);
    process.exit(1);
  }
  return String(meta.cartridgeId);
}

async function roster() {
  const cartridgeId = requireSepoliaCart(loadMeta());
  const { activeHeroId, heroes } = await readSepoliaHeroes(cartridgeId);
  console.log(JSON.stringify({ cartridgeId, activeHeroId, heroes }, null, 2));
}

async function checkpoint() {
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: ./scripts/gotchibot connect");
    process.exit(1);
  }

  const sessionId = process.env.GOTCHIBOT_CHECKPOINT_SESSION;
  const label = process.env.GOTCHIBOT_CHECKPOINT_LABEL ?? "milestone";
  let gameState = { schemaVersion: 1 };
  if (sessionId) {
    const dir = resolve(ROOT, "sessions", sessionId);
    try {
      gameState.agents = {
        orchestrator: { cAavegotchiId: "orchestrator", status: "active" },
        "sub-agents": [
          {
            id: `sub-${sessionId}`,
            cAavegotchiId: sessionId,
            runtime: "opencode",
            model: process.env.GOTCHIBOT_CHECKPOINT_MODEL ?? "",
            status: "completed",
            task: label,
            startedAt: null,
          },
        ],
      };
      gameState.handoff = {
        knowledgeFiles: [],
        prompt: readFileSync(`${dir}/prompt.txt`, "utf8").slice(0, 2000),
        output: readFileSync(`${dir}/output.md`, "utf8").slice(0, 8000),
      };
    } catch {
      gameState.note = "session files unavailable";
    }
  } else {
    gameState.agents = { orchestrator: { status: "idle" }, "sub-agents": [] };
    gameState.handoff = { note: label, at: new Date().toISOString() };
  }

  try {
    const { projectCheckpointSlice, emptyProjectCheckpointSlice, clearCurrentProject } =
      await import("./project-context.mjs");
    if (process.env.GOTCHIBOT_CHECKPOINT_CLEAR_PROJECTS === "1") {
      clearCurrentProject();
      gameState.projects = emptyProjectCheckpointSlice(
        process.env.GOTCHIBOT_CHECKPOINT_CLEAR_REASON || "transfer",
      );
    } else {
      gameState.projects = projectCheckpointSlice();
    }
  } catch {
    gameState.projects = { current: null, slugs: [], updatedAt: new Date().toISOString() };
  }

  try {
    const { packWearableCheckpointSlice, clearAllPackWearables } = await import("./pack-wearable.mjs");
    if (process.env.GOTCHIBOT_CHECKPOINT_CLEAR_PROJECTS === "1") {
      clearAllPackWearables(process.env.GOTCHIBOT_CHECKPOINT_CLEAR_REASON || "transfer");
      gameState.equippedPacks = {
        assignmentSlot: 15,
        nested: [],
        byHero: {},
        updatedAt: new Date().toISOString(),
        clearedReason: process.env.GOTCHIBOT_CHECKPOINT_CLEAR_REASON || "transfer",
      };
    } else {
      gameState.equippedPacks = packWearableCheckpointSlice();
    }
  } catch {
    gameState.equippedPacks = { assignmentSlot: 15, nested: [], byHero: {}, updatedAt: new Date().toISOString() };
  }

  // Opt-in chat-sync slice (Arcade snapshot URI + content hash from chats checkpoint-prompt).
  let chatPin = null;
  try {
    const pinPath = `${ROOT}/sessions/.chat-sync-checkpoint.json`;
    if (
      process.env.GOTCHIBOT_CHECKPOINT_CHAT_SYNC === "1" ||
      String(label).startsWith("chat-sync:")
    ) {
      chatPin = JSON.parse(readFileSync(pinPath, "utf8"));
      gameState.chatSync = {
        snapshotId: chatPin.snapshotId || null,
        stateUri: chatPin.stateUri || process.env.GOTCHIBOT_CHECKPOINT_STATE_URI || null,
        contentHash: chatPin.contentHash || null,
        gitCommit: chatPin.gitCommit || null,
        label,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* no pin */
  }

  const stableStringify = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
  let stateHash = "0x" + crypto.createHash("sha256").update(stableStringify(gameState)).digest("hex");
  if (process.env.GOTCHIBOT_CHECKPOINT_STATE_HASH) {
    stateHash = String(process.env.GOTCHIBOT_CHECKPOINT_STATE_HASH).trim();
  } else if (chatPin?.contentHash) {
    stateHash = String(chatPin.contentHash).trim();
  }
  const stateUri =
    process.env.GOTCHIBOT_CHECKPOINT_STATE_URI ||
    chatPin?.stateUri ||
    gameState.projects?.storage?.stateUri ||
    "";

  // Desk snapshot + hash for a later on-chain checkpointSave.
  const snapPath = `${ROOT}/sessions/.checkpoint-local.json`;
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(
    snapPath,
    `${JSON.stringify(
      {
        cartridgeId: meta.cartridgeId,
        label,
        stateHash,
        stateUri: stateUri || null,
        gameState,
        savedAt: new Date().toISOString(),
        note: chatPin
          ? "Chat-sync checkpoint — run chats onchain / MetaMask checkpointSave to finalize."
          : "Local Sepolia checkpoint — on-chain SaveStateFacet / Concierge when wired.",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "local-sepolia",
        cartridgeId: meta.cartridgeId,
        stateHash,
        stateUri: stateUri || null,
        path: "sessions/.checkpoint-local.json",
        chatSync: Boolean(chatPin),
      },
      null,
      2,
    ),
  );
}

function metaPath() { return `${ROOT}/sessions/.identity.json`; }
function loadMeta() {
  try { return JSON.parse(readFileSync(metaPath(), "utf8")); } catch { return null; }
}
function saveMeta(m) {
  const prev = loadMeta() ?? {};
  mkdirSync(dirname(metaPath()), { recursive: true });
  writeFileSync(metaPath(), JSON.stringify({ ...prev, ...m }, null, 2));
}

async function bind() {
  const meta = loadMeta();
  const cartridgeId = requireSepoliaCart(meta);
  const sessionIdx = process.argv.indexOf("--session");
  const sessionId = sessionIdx > -1 ? process.argv[sessionIdx + 1] : null;
  const heroIdx = process.argv.indexOf("--hero");
  const existingHero =
    (heroIdx > -1 ? process.argv[heroIdx + 1] : null) ||
    process.env.GOTCHIBOT_HERO_ID ||
    null;
  if (!sessionId || !existingHero) {
    console.error(
      "identity bind pins an existing cartridge hero: --session <id> --hero <id>\n" +
        "  new cAavegotchis: cockpit mint, or templates apply <id> --mint <collateral>",
    );
    process.exit(1);
  }
  const { heroes } = await readSepoliaHeroes(cartridgeId);
  if (!heroes.some((h) => h.id === existingHero || h.heroKey === existingHero)) {
    console.error(`hero ${existingHero} not on cartridge ${cartridgeId}`);
    process.exit(1);
  }
  saveMeta({
    activeHeroId: existingHero,
    sessionHeroes: { ...(meta.sessionHeroes ?? {}), [sessionId]: existingHero },
  });
  process.stdout.write(existingHero);
}

export { loadMeta, saveMeta, owner };


if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2];
  const handlers = { bind, roster, checkpoint };
  if (!handlers[cmd]) {
    console.error("usage: identity.mjs roster|bind|checkpoint");
    process.exit(2);
  }
  handlers[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
}
