/**
 * /local — run a chat's prompts on THIS desk's CPU (Cursor, Codex, Claude Code),
 * or on the Hub's VS Code Claude, while the prompt and reply stay in the chat
 * session (so a Hub chat stays synced to the phone and other desks).
 *
 * The /local picker (tui-plugins/gotchi-local.ts) writes the chat's choice to
 * sessions/.local-mode.json. Per user message, this hook rewrites the message's
 * model to desk/<tool> (scripts/desk-tools.mjs, reached on 127.0.0.1:45690 — on the
 * Hub through the desk's reverse tunnel) or claudemode/@claudemode. If the desk
 * runner is not answering, the message stays on the chat's own model.
 *
 * Turning /local off: OpenCode's chat keeps using the model of its last message,
 * so after a reroute the chat itself is on desk/<tool>. The model the chat had
 * before /local is kept in sessions/.local-origins.json and restored on every
 * message still addressed to a /local target (default: opencode.json's model).
 *
 * Hooks: chat.message (reroute) + chat.headers (session + bearer token for desk).
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.GOTCHIBOT_DESK_TOOLS_PORT) || 45690;
const STATE = join(ROOT, "sessions", ".local-mode.json");
const ORIGINS = join(ROOT, "sessions", ".local-origins.json");

const LOCAL_TARGETS = {
  cursor: { providerID: "desk", modelID: "cursor" },
  codex: { providerID: "desk", modelID: "codex" },
  claude: { providerID: "desk", modelID: "claude" },
  "hub-claude": { providerID: "claudemode", modelID: "@claudemode" },
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function log(msg) {
  try {
    appendFileSync(join(ROOT, "sessions", ".local-mode.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function writeJson(path, value) {
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${path}.tmp`, path);
  } catch {}
}

const same = (a, b) => a?.providerID === b?.providerID && a?.modelID === b?.modelID;
const isTarget = (m) => Object.values(LOCAL_TARGETS).some((t) => same(t, m));

/** The chat's model before /local: remembered origin, else opencode.json's model. */
function originFor(sessionID) {
  const o = readJson(ORIGINS)?.[sessionID];
  if (o?.providerID && o?.modelID) return { providerID: o.providerID, modelID: o.modelID };
  const ref = String(readJson(join(ROOT, "opencode.json"))?.model || "opencode-go/glm-5.3");
  const i = ref.indexOf("/");
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

/** Is the desk runner reachable on this machine's loopback (directly or via the tunnel)? */
function deskUp(timeoutMs = 600) {
  return new Promise((ok) => {
    const s = createConnection({ host: "127.0.0.1", port: PORT });
    const t = setTimeout(() => {
      s.destroy();
      ok(false);
    }, timeoutMs);
    s.on("connect", () => {
      clearTimeout(t);
      s.end();
      ok(true);
    });
    s.on("error", () => {
      clearTimeout(t);
      ok(false);
    });
  });
}

/** Desk runner token: the one the attaching desk handed over, else this desk's own. */
function deskToken() {
  const st = readJson(STATE);
  if (st?.deskToken) return st.deskToken;
  try {
    return readFileSync(join(ROOT, "sessions", ".desk-tools-token"), "utf8").trim();
  } catch {
    return "";
  }
}

export const GotchiLocalTools = async () => ({
  "chat.message": async (input, output) => {
    if (!output?.message) return;
    const sid = input.sessionID;
    const tool = readJson(STATE)?.sessions?.[sid]?.tool;
    const target = tool && LOCAL_TARGETS[tool];
    const cur = output.message.model;
    const origins = readJson(ORIGINS) || {};
    if (!target) {
      // /local is off. A message still on a /local target is the chat's sticky
      // model from the last reroute: put it back. A desk/* model always counts;
      // @claudemode only when /local put the chat there (it is also a /model pick).
      if (cur?.providerID === "desk" || (origins[sid] && isTarget(cur))) {
        const back = originFor(sid);
        log(`${sid}: /local off — ${cur.providerID}/${cur.modelID} → ${back.providerID}/${back.modelID}`);
        output.message.model = back;
      } else if (origins[sid]) {
        delete origins[sid];
        writeJson(ORIGINS, origins);
      }
      return;
    }
    if (cur && !isTarget(cur) && !same(origins[sid], cur)) writeJson(ORIGINS, { ...origins, [sid]: { ...cur, at: new Date().toISOString() } });
    if (target.providerID === "desk" && !(await deskUp())) {
      // The chat's own model may itself be the sticky desk/* one: use the origin.
      if (isTarget(cur)) output.message.model = originFor(sid);
      log(`${sid} ${tool}: desk runner not reachable — answered on ${output.message.model?.providerID}/${output.message.model?.modelID}`);
      return;
    }
    output.message.model = { ...target };
  },
  "chat.headers": async (input, output) => {
    if (input?.model?.providerID !== "desk" && input?.provider?.info?.id !== "desk") return;
    output.headers["x-gotchibot-session"] = input.sessionID;
    const token = deskToken();
    if (token) output.headers.authorization = `Bearer ${token}`;
  },
});
