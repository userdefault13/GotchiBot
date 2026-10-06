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
 * Hooks: chat.message (reroute) + chat.headers (session + bearer token for desk).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.GOTCHIBOT_DESK_TOOLS_PORT) || 45690;
const STATE = join(ROOT, "sessions", ".local-mode.json");

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
    const tool = readJson(STATE)?.sessions?.[input.sessionID]?.tool;
    const target = tool && LOCAL_TARGETS[tool];
    if (!target || !output?.message) return;
    if (target.providerID === "desk" && !(await deskUp())) {
      log(`${input.sessionID} ${tool}: desk runner not reachable — kept ${output.message.model?.providerID}/${output.message.model?.modelID}`);
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
