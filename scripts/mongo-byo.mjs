#!/usr/bin/env node
/**
 * BYO Mongo wizard — chat bodies stay on the user's Hub, never Arcade.
 *
 *   gotchibot db wizard
 *   gotchibot db local-install | local
 *   gotchibot db atlas [--uri mongodb+srv://…]
 *   gotchibot db none
 *   gotchibot db status
 *   gotchibot db pin-desk   # set deskApiBase from .hub.json MagicDNS:8793
 *
 * Secrets: abra set gotchibot MONGODB_URI  and/or sessions/.mongo.json (gitignored).
 * Arcade only gets chatStore.kind (+ optional atlasHostHint) — never the URI.
 */
import {
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { createInterface as createReadline } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import {
  infraHeaders,
  soloApiBase,
  hasInstallToken,
  deskApiBase,
  deskApiBaseFromHubPin,
  readHubPin,
  readMongoPin,
  isArcadeSharedChatBase,
} from "./infra-client.mjs";
import { hasAbra, abraInstallHint } from "./platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const MONGO_PIN = `${SESSIONS}/.mongo.json`;
const HUB_PIN = `${SESSIONS}/.hub.json`;
const COMPOSE_DIR = `${ROOT}/docker/chat-mongo`;
const DEFAULT_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB = "GotchiBot";

function writeMongoPin(pin) {
  mkdirSync(SESSIONS, { recursive: true });
  const out = {
    kind: pin.kind,
    uriEnv: pin.uriEnv || "MONGODB_URI",
    dbName: pin.dbName || DEFAULT_DB,
    atlasHostHint: pin.atlasHostHint || null,
    localUri: pin.localUri || null,
    configuredAt: new Date().toISOString(),
  };
  writeFileSync(MONGO_PIN, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

function ask(rl, q) {
  return new Promise((resolveAsk) => rl.question(q, resolveAsk));
}

function extractAtlasHost(uri) {
  try {
    const u = String(uri || "")
      .replace(/^mongodb(\+srv)?:\/\//i, "")
      .split("/")[0]
      .split("@")
      .pop();
    return u ? u.slice(0, 253) : null;
  } catch {
    return null;
  }
}

async function publishChatStore(kind, { dbName, atlasHostHint } = {}) {
  if (!hasInstallToken()) {
    console.warn("No GOTCHIBOT_INFRA_TOKEN — skipping Arcade chatStore pin (local pin ok).");
    console.warn("  abra run gotchibot -- ./scripts/gotchibot hub chat-store --kind " + kind);
    return null;
  }
  const base = soloApiBase();
  const chatStore = {
    kind,
    dbName: kind === "none" ? null : dbName || DEFAULT_DB,
    atlasHostHint: kind === "atlas" ? atlasHostHint || null : null,
  };
  const res = await fetch(`${base}/api/gotchibot/hub/chat-store`, {
    method: "POST",
    headers: { ...infraHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ chatStore }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn(`Arcade chat-store failed (${res.status}): ${json.error || res.statusText}`);
    console.warn("  Local pin still written. Retry: gotchibot hub chat-store --kind " + kind);
    return null;
  }
  // Refresh hub pin chatStore field
  try {
    const hub = readHubPin() || {};
    if (json.hub) {
      writeFileSync(
        HUB_PIN,
        `${JSON.stringify({ ...hub, ...json.hub, chatStore: json.hub.chatStore, writtenAt: new Date().toISOString() }, null, 2)}\n`,
      );
    }
  } catch {
    /* non-fatal */
  }
  return json;
}

function dockerAvailable() {
  const r = spawnSync("docker", ["info"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}

function cmdLocalInstall() {
  if (!dockerAvailable()) {
    throw new Error(
      "Docker not running. Start Docker Desktop, or use: gotchibot db atlas",
    );
  }
  mkdirSync(COMPOSE_DIR, { recursive: true });
  const composePath = `${COMPOSE_DIR}/docker-compose.yml`;
  if (!existsSync(composePath)) {
    writeFileSync(
      composePath,
      `# GotchiBot BYO chat Mongo — bind 127.0.0.1 only (Hub Mac).
# Desk reaches chats via gotchibot-api (:8793) over Tailscale, never mongod.
services:
  gotchibot-chat-mongo:
    image: mongo:7
    container_name: gotchibot-chat-mongo
    restart: unless-stopped
    ports:
      - "127.0.0.1:27017:27017"
    volumes:
      - gotchibot_chat_mongo_data:/data/db
volumes:
  gotchibot_chat_mongo_data:
`,
    );
  }
  console.log(`Starting local Mongo (compose: ${composePath})…`);
  const up = spawnSync("docker", ["compose", "-f", composePath, "up", "-d"], {
    cwd: COMPOSE_DIR,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (up.status !== 0) throw new Error("docker compose up failed");

  const pin = writeMongoPin({
    kind: "local",
    localUri: DEFAULT_URI,
    dbName: DEFAULT_DB,
    uriEnv: "MONGODB_URI",
  });
  console.log(`pin → sessions/.mongo.json (kind=local)`);
  console.log(`Set on Hub API env: MONGODB_URI=${DEFAULT_URI}  MONGO_DB_NAME=${DEFAULT_DB}`);
  console.log(`  (services/gotchibot-api/.env or LaunchAgent)`);
  return pin;
}

async function cmdAtlas(uriArg) {
  let uri = uriArg || process.env.MONGODB_URI || "";
  if (!uri) {
    const rl = createReadline({ input: process.stdin, output: process.stdout });
    uri = (await ask(rl, "Paste MongoDB / Atlas URI (not stored on Arcade): ")).trim();
    rl.close();
  }
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new Error("need a mongodb:// or mongodb+srv:// URI");
  }
  const hostHint = extractAtlasHost(uri);
  if (hasAbra()) {
    console.log("Saving URI to abra project gotchibot (MONGODB_URI)…");
    const r = spawnSync(
      "abra",
      ["set", "gotchibot", "MONGODB_URI", "--stdin"],
      {
        input: uri + "\n",
        encoding: "utf8",
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (r.status !== 0) {
      console.warn("abra set failed — write URI yourself: abra set gotchibot MONGODB_URI --stdin");
    }
  } else {
    console.warn(abraInstallHint());
    console.warn("URI not written to disk. Use abra when available.");
  }

  const pin = writeMongoPin({
    kind: "atlas",
    dbName: DEFAULT_DB,
    atlasHostHint: hostHint,
    uriEnv: "MONGODB_URI",
  });
  await publishChatStore("atlas", { dbName: DEFAULT_DB, atlasHostHint: hostHint });
  console.log(`pin → sessions/.mongo.json (kind=atlas, hostHint=${hostHint || "—"})`);
  return pin;
}

async function cmdNone() {
  const pin = writeMongoPin({ kind: "none", dbName: null });
  await publishChatStore("none");
  console.log("chatStore=none — Hub works; chats push/pull disabled until you pick local/atlas.");
  return pin;
}

async function cmdLocal() {
  const pin = cmdLocalInstall();
  await publishChatStore("local", { dbName: DEFAULT_DB });
  return pin;
}

function cmdPinDesk() {
  const hub = readHubPin();
  if (!hub?.tailscaleHost) {
    throw new Error("no sessions/.hub.json — run: gotchibot hub enable <MagicDNS>");
  }
  const base = deskApiBaseFromHubPin(hub);
  if (!base) throw new Error("could not derive deskApiBase from hub pin");
  const next = {
    ...hub,
    deskApiBase: base,
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(HUB_PIN, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`deskApiBase → ${base}`);
  console.log(`  (also: export GOTCHIBOT_DESK_API_BASE=${base})`);
  if (isArcadeSharedChatBase(base)) {
    console.warn("Warning: still Arcade shared host — unexpected for BYO.");
  }
  return next;
}

function cmdStatus() {
  const mongo = readMongoPin();
  const hub = readHubPin();
  const base = deskApiBase();
  const out = {
    mongoPin: mongo,
    hubPin: hub
      ? {
          enabled: hub.enabled,
          tailscaleHost: hub.tailscaleHost,
          chatStore: hub.chatStore,
          deskApiBase: hub.deskApiBase || null,
        }
      : null,
    deskApiBase: base,
    hubPinned: Boolean(base),
    arcadeShared: isArcadeSharedChatBase(base),
  };
  console.log(JSON.stringify(out, null, 2));
  if (!base) {
    console.log("\nNo Hub pinned — run: gotchibot db wizard / gotchibot db pin-desk");
  } else if (out.arcadeShared) {
    console.log("\nArcade shared desk base is blocked. Pin your Hub: gotchibot db pin-desk");
  }
  return out;
}

async function cmdWizard() {
  const rl = createReadline({ input: process.stdin, output: process.stdout });
  console.log(`
BYO chat storage (Arcade never holds your messages)

  1) Local Mongo on this Hub (Docker, recommended)
  2) Atlas / self-hosted URI (abra)
  3) Skip chat sync for now
`);
  const choice = (await ask(rl, "Pick 1/2/3 [1]: ")).trim() || "1";
  rl.close();

  if (choice === "2") {
    await cmdAtlas();
  } else if (choice === "3") {
    await cmdNone();
  } else {
    await cmdLocal();
  }

  const hub = readHubPin();
  if (hub?.tailscaleHost) {
    const rl2 = createReadline({ input: process.stdin, output: process.stdout });
    const pin = (await ask(rl2, `Pin deskApiBase to Hub ${hub.tailscaleHost}? [Y/n]: `))
      .trim()
      .toLowerCase();
    rl2.close();
    if (pin !== "n" && pin !== "no") cmdPinDesk();
  } else {
    console.log("No Hub pin yet — after hub enable, run: gotchibot db pin-desk");
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(`usage:
  gotchibot db wizard
  gotchibot db local | local-install
  gotchibot db atlas [--uri mongodb+srv://…]
  gotchibot db none
  gotchibot db status
  gotchibot db pin-desk`);
    process.exit(cmd ? 0 : 2);
  }
  try {
    if (cmd === "wizard") await cmdWizard();
    else if (cmd === "local" || cmd === "local-install") await cmdLocal();
    else if (cmd === "atlas") {
      const uriIdx = rest.indexOf("--uri");
      const uri = uriIdx >= 0 ? rest[uriIdx + 1] : rest[0] && !rest[0].startsWith("-") ? rest[0] : null;
      await cmdAtlas(uri);
    } else if (cmd === "none" || cmd === "skip") await cmdNone();
    else if (cmd === "status") cmdStatus();
    else if (cmd === "pin-desk" || cmd === "pin") cmdPinDesk();
    else {
      console.error(`unknown db command: ${cmd}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { writeMongoPin, cmdLocalInstall, extractAtlasHost };
