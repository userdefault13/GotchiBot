/**
 * Status bar chat model: live OpenCode session wins; pins are the fallback.
 *   node --test tests/session-status-bar.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatSessionModel, resolveLiveChatModel, chatBackend, lastKnownHubModel } from "../scripts/live-chat-model.mjs";
import { sshMasterOpts } from "../scripts/hub-desk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bar = join(root, "scripts/session-status-bar.sh");

function tree() {
  const dir = mkdtempSync(join(tmpdir(), "status-bar-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

describe("formatSessionModel", () => {
  it("joins provider and id", () => {
    assert.equal(
      formatSessionModel({ providerID: "openrouter", id: "acme/widget-preview:free", variant: "high" }),
      "openrouter/acme/widget-preview:free",
    );
  });

  it("does not double-prefix an id that already includes the provider", () => {
    assert.equal(
      formatSessionModel({ provider: "opencode-go", id: "opencode-go/pin-model" }),
      "opencode-go/pin-model",
    );
  });

  it("accepts a raw ref or JSON text", () => {
    assert.equal(formatSessionModel("vendor/some-model"), "vendor/some-model");
    assert.equal(
      formatSessionModel('{"providerID":"vendor","modelID":"some-model"}'),
      "vendor/some-model",
    );
  });

  it("returns empty when nothing is set", () => {
    assert.equal(formatSessionModel(""), "");
    assert.equal(formatSessionModel(null), "");
    assert.equal(formatSessionModel({}), "");
  });
});

describe("resolveLiveChatModel", () => {
  it("uses GOTCHIBOT_LIVE_MODEL_JSON and does not call the desk", async () => {
    let called = false;
    const model = await resolveLiveChatModel({
      root: tree(),
      env: { GOTCHIBOT_LIVE_MODEL_JSON: '{"providerID":"openrouter","id":"acme/widget-preview:free"}' },
      hubRequest: async () => {
        called = true;
        return {};
      },
    });
    assert.equal(model, "openrouter/acme/widget-preview:free");
    assert.equal(called, false);
  });

  it("reads the desk session model", async () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.project-current"), "demo\n");
    writeFileSync(join(dir, "sessions/.hub-desk.json"), '{"ssh":"user@hub"}\n');
    const seen = [];
    const model = await resolveLiveChatModel({
      root: dir,
      env: {},
      hubRequest: async (method, path) => {
        seen.push([method, path]);
        return {
          sessionId: "ses_abc",
          opencodeUrl: "http://127.0.0.1:4096",
          repoDir: "/remote/GotchiBot",
        };
      },
      readSession: async (opts) => {
        seen.push(opts.sessionId);
        return { providerID: "openrouter", id: "acme/widget-preview:free", variant: "high" };
      },
    });
    assert.equal(model, "openrouter/acme/widget-preview:free");
    assert.equal(seen[0][0], "GET");
    assert.equal(seen[0][1], "/api/gotchibot/projects/demo/desk");
    assert.equal(seen[1], "ses_abc");
  });

  it("returns empty when the desk has no session", async () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.project-current"), "demo\n");
    const model = await resolveLiveChatModel({
      root: dir,
      env: {},
      hubRequest: async () => ({ sessionId: null, opencodeUrl: "http://127.0.0.1:4096" }),
      readSession: async () => {
        throw new Error("should not read");
      },
    });
    assert.equal(model, "");
  });
});

describe("session-status-bar.sh --print-chat-model", () => {
  function printModel(dir, extra = {}) {
    const env = {
      ...process.env,
      GOTCHIBOT_STATUS_ROOT: dir,
      GOTCHIBOT_OPENCODE_MODEL: "",
      GOTCHIBOT_LIVE_MODEL_JSON: "",
      ...extra,
    };
    return execFileSync("bash", [bar, "--print-chat-model"], { encoding: "utf8", env }).trim();
  }

  it("shows the live session model, short form, ahead of the pin file", () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.chat-model"), "vendor/stale-pin\n");
    const out = printModel(dir, {
      GOTCHIBOT_LIVE_MODEL_JSON: '{"providerID":"openrouter","id":"acme/widget-preview:free"}',
    });
    assert.equal(out, "widget-preview:free");
  });

  it("falls back to .chat-model when no live session model exists", () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.chat-model"), "vendor/stale-pin\n");
    assert.equal(printModel(dir), "stale-pin");
  });

  it("prefers .chat-model over a stale tmux-server GOTCHIBOT_OPENCODE_MODEL", () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.chat-model"), "openrouter/dots-studio/widget-preview:free\n");
    const out = printModel(dir, {
      GOTCHIBOT_OPENCODE_MODEL: "openrouter/stealth/space-bunny-alpha",
    });
    assert.equal(out, "widget-preview:free");
  });
});

describe("desk ↔ Hub model sync", () => {
  it("does not report the Hub session's model while the chat pane runs local OpenCode", async () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.project-current"), "proj\n");
    writeFileSync(join(dir, "sessions/.chat-backend"), "local\n");
    let called = false;
    const model = await resolveLiveChatModel({
      root: dir,
      env: {},
      hubRequest: async () => {
        called = true;
        return { sessionId: "ses_x", opencodeUrl: "http://127.0.0.1:4096" };
      },
      readSession: async () => ({ providerID: "opencode-go", id: "glm-5.3" }),
    });
    assert.equal(model, "");
    assert.equal(called, false);
  });

  it("reads the Hub session while the chat is the Hub's", async () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.project-current"), "proj\n");
    writeFileSync(join(dir, "sessions/.chat-backend"), "hub proj\n");
    const model = await resolveLiveChatModel({
      root: dir,
      env: {},
      hubRequest: async () => ({ sessionId: "ses_x", opencodeUrl: "http://127.0.0.1:4096" }),
      readSession: async () => ({ providerID: "opencode-go", id: "glm-5.3" }),
    });
    assert.equal(model, "opencode-go/glm-5.3");
    assert.deepEqual(chatBackend(dir), { mode: "hub", slug: "proj" });
    // …and remembers it, so a later local fallback starts on the Hub's model.
    assert.equal(lastKnownHubModel(dir), "opencode-go/glm-5.3");
  });

  it("marks a paired desk's local fallback chat in the status bar", () => {
    const dir = tree();
    writeFileSync(join(dir, "sessions/.hub.json"), "{}");
    writeFileSync(join(dir, "sessions/.chat-backend"), "local\n");
    writeFileSync(join(dir, "sessions/.chat-model"), "opencode-go/glm-5.3\n");
    const out = execFileSync("bash", [bar, "--print-chat-model"], { encoding: "utf8", env: { ...process.env, GOTCHIBOT_STATUS_ROOT: dir } });
    assert.match(out, /glm-5\.3 \(local\)/);
  });

  it("attaches over recovery's SSH master and falls back on the Hub's model in a fresh session", () => {
    assert.deepEqual(sshMasterOpts("/home/u"), ["-o", "ControlPath=/home/u/.ssh/gb-%C", "-o", "ControlMaster=no"]);
    const pane = readFileSync(join(root, "scripts/chat-pane.sh"), "utf8");
    assert.match(pane, /printf 'hub %s\\n' "\$hub_slug" > "\$ROOT\/sessions\/\.chat-backend"/);
    assert.match(pane, /printf 'local\\n' > "\$ROOT\/sessions\/\.chat-backend"/);
    assert.match(pane, /live-chat-model\.mjs" --last-known/);
    assert.match(pane, /if \[ "\$a" = "--session" \]; then skip_next=1/);
  });
});
