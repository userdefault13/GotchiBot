/**
 * /local: the desk tools runner (scripts/desk-tools.mjs), the reroute plugin
 * (.opencode/plugins/gotchi-local-tools.js), and the Hub attach's reverse tunnel.
 * No CLI is run here (the runner's `run` is injected).
 *   node --test tests/desk-tools.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toolArgs, parseToolOutput, toolOf, lastUserText, createDeskToolsServer, deskToolsToken } from "../scripts/desk-tools.mjs";
import { reverseTunnelOpts, sshMasterOpts } from "../scripts/hub-desk.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("tool commands", () => {
  it("runs each CLI headless in the project with edits allowed, resuming its own conversation", () => {
    assert.deepEqual(toolArgs("codex", { prompt: "p", cwd: "/w", outFile: "/o" }), ["exec", "-C", "/w", "--json", "-c", "sandbox_mode=workspace-write", "--skip-git-repo-check", "-o", "/o", "p"]);
    assert.deepEqual(toolArgs("codex", { prompt: "p", cwd: "/w", resume: "T1", outFile: "/o" }).slice(0, 3), ["exec", "resume", "T1"]);
    assert.deepEqual(toolArgs("claude", { prompt: "p", cwd: "/w", resume: "S1" }), ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--resume", "S1", "p"]);
    assert.deepEqual(toolArgs("cursor", { prompt: "p", cwd: "/w" }), ["--print", "--output-format", "json", "--force", "--trust", "--workspace", "/w", "p"]);
    assert.throws(() => toolArgs("vim", { prompt: "p" }), /unknown tool/);
  });

  it("parses each CLI's answer and conversation id", () => {
    const codex = ['{"type":"thread.started","thread_id":"T9"}', '{"type":"item.completed","item":{"type":"agent_message","text":"from events"}}'].join("\n");
    assert.deepEqual(parseToolOutput("codex", codex, "from -o file\n"), { text: "from -o file", resume: "T9" });
    assert.deepEqual(parseToolOutput("codex", codex, ""), { text: "from events", resume: "T9" });
    assert.deepEqual(parseToolOutput("claude", '{"type":"result","result":"hi","session_id":"S2","is_error":false}'), { text: "hi", resume: "S2", error: undefined });
    assert.deepEqual(parseToolOutput("cursor", 'noise\n{"type":"result","result":"done","session_id":"C3"}'), { text: "done", resume: "C3", error: undefined });
  });

  it("maps models and reads the last user turn", () => {
    assert.equal(toolOf("desk/codex"), "codex");
    assert.equal(toolOf("claude"), "claude");
    assert.equal(toolOf("desk/vim"), null);
    assert.equal(lastUserText([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }, { type: "image" }] }]), "c");
  });
});

describe("runner", () => {
  let root;
  let server;
  let port;
  const calls = [];
  let release;
  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "gb-desk-tools-"));
    mkdirSync(path.join(root, "sessions"));
    server = createDeskToolsServer({
      root,
      token: "tok",
      cwdOf: async () => "/proj",
      run: async (tool, o) => {
        calls.push({ tool, ...o });
        if (o.prompt === "slow") await new Promise((r) => (release = r));
        return { ok: true, text: `${tool} says ${o.prompt}`, resume: `${tool}-conv` };
      },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json", "x-gotchibot-session": "ses_A", ...headers }, body: JSON.stringify(body) });

  it("refuses requests without the desk's token", async () => {
    assert.equal((await post({ model: "desk/codex", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer nope" })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
  });

  it("answers in OpenAI chat format and resumes the tool's conversation per chat session", async () => {
    const r1 = await (await post({ model: "desk/codex", messages: [{ role: "user", content: "one" }] })).json();
    assert.equal(r1.choices[0].message.content, "codex says one");
    await post({ model: "desk/codex", messages: [{ role: "user", content: "two" }] });
    assert.equal(calls.at(-2).resume, null);
    assert.equal(calls.at(-1).resume, "codex-conv");
    assert.equal(calls.at(-1).cwd, "/proj");
    const map = JSON.parse(readFileSync(path.join(root, "sessions", ".desk-tools-sessions.json"), "utf8"));
    assert.equal(map.ses_A.codex, "codex-conv");
  });

  it("streams SSE chunks ending in [DONE]", async () => {
    const text = await (await post({ model: "desk/claude", stream: true, messages: [{ role: "user", content: "s" }] })).text();
    assert.match(text, /"content":"claude says s"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]\n\n$/);
  });

  it("refuses a second prompt for the same chat and tool while the first runs", async () => {
    const first = post({ model: "desk/cursor", messages: [{ role: "user", content: "slow" }] });
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await post({ model: "desk/cursor", messages: [{ role: "user", content: "again" }] })).status, 409);
    release();
    assert.equal((await first).status, 200);
  });

  it("keeps its token in a 0600 file", (t) => {
    const r = mkdtempSync(path.join(tmpdir(), "gb-tok-"));
    t.after(() => rmSync(r, { recursive: true, force: true }));
    const tok = deskToolsToken(r);
    assert.ok(tok.length >= 24);
    assert.equal(deskToolsToken(r), tok);
  });
});

describe("reroute plugin", () => {
  let root;
  let listener;
  let mod;
  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "gb-local-"));
    mkdirSync(path.join(root, "sessions"));
    listener = createServer((s) => s.end());
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    process.env.GOTCHIBOT_ROOT = root;
    process.env.GOTCHIBOT_DESK_TOOLS_PORT = String(listener.address().port);
    mod = await import(`../.opencode/plugins/gotchi-local-tools.js?t=${Date.now()}`);
  });
  after(() => {
    listener.close();
    delete process.env.GOTCHIBOT_ROOT;
    delete process.env.GOTCHIBOT_DESK_TOOLS_PORT;
    rmSync(root, { recursive: true, force: true });
  });

  it("exports only the plugin function (OpenCode calls every export as a plugin)", () => {
    assert.deepEqual(Object.keys(mod), ["GotchiLocalTools"]);
  });

  it("reroutes only chats with /local on, and adds the desk headers", async () => {
    writeFileSync(path.join(root, "sessions", ".local-mode.json"), JSON.stringify({ sessions: { s1: { tool: "codex" }, s2: { tool: "hub-claude" } }, deskToken: "handed" }));
    const hooks = await mod.GotchiLocalTools();
    const msg = (sid) => ({ message: { model: { providerID: "opencode-go", modelID: "glm-5.3" } }, parts: [] });
    const a = msg();
    await hooks["chat.message"]({ sessionID: "s1" }, a);
    assert.deepEqual(a.message.model, { providerID: "desk", modelID: "codex" });
    const b = msg();
    await hooks["chat.message"]({ sessionID: "s2" }, b);
    assert.deepEqual(b.message.model, { providerID: "claudemode", modelID: "@claudemode" });
    const c = msg();
    await hooks["chat.message"]({ sessionID: "other" }, c);
    assert.deepEqual(c.message.model, { providerID: "opencode-go", modelID: "glm-5.3" });
    const h = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "s1", model: { providerID: "desk" } }, h);
    assert.deepEqual(h.headers, { "x-gotchibot-session": "s1", authorization: "Bearer handed" });
  });

  it("leaves the message on the chat's model when the desk runner is unreachable", async () => {
    listener.close();
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path.join(root, "sessions", ".local-mode.json"), JSON.stringify({ sessions: { s1: { tool: "claude" } } }));
    const hooks = await mod.GotchiLocalTools();
    const m = { message: { model: { providerID: "opencode-go", modelID: "glm-5.3" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "s1" }, m);
    assert.deepEqual(m.message.model, { providerID: "opencode-go", modelID: "glm-5.3" });
    assert.match(readFileSync(path.join(root, "sessions", ".local-mode.log"), "utf8"), /desk runner not reachable/);
  });
});

describe("wiring", () => {
  it("the Hub attach opens the reverse tunnel over the SSH master and hands the token over", () => {
    assert.deepEqual(reverseTunnelOpts(45690), ["-o", "ExitOnForwardFailure=no", "-R", "127.0.0.1:45690:127.0.0.1:45690"]);
    assert.equal(sshMasterOpts("/h")[1], "ControlPath=/h/.ssh/gb-%C");
    const src = readFileSync(path.join(repo, "scripts", "hub-desk.mjs"), "utf8");
    assert.match(src, /syncEnv\.GOTCHIBOT_DESK_TOOLS_TOKEN = deskTools\.token/);
  });

  it("registers the desk provider, the /local picker, and keeps routing models out of the relaunch pin", () => {
    const oc = JSON.parse(readFileSync(path.join(repo, "opencode.json"), "utf8"));
    assert.equal(oc.provider.desk.options.baseURL, "http://127.0.0.1:45690/v1");
    assert.deepEqual(Object.keys(oc.provider.desk.models), ["cursor", "codex", "claude"]);
    assert.ok(JSON.parse(readFileSync(path.join(repo, ".opencode", "tui.json"), "utf8")).plugin.includes("./tui-plugins/gotchi-local.tsx"));
    // The prompt row shows "● local · <tool>" while /local is on.
    const local = readFileSync(path.join(repo, ".opencode", "tui-plugins", "gotchi-local.tsx"), "utf8");
    assert.match(local, /session_prompt_right\(ctx: any, data: any\)/);
    assert.match(local, /● local/);
    assert.match(readFileSync(path.join(repo, ".opencode", "tui-plugins", "gotchi-model-sync.ts"), "utf8"), /s\.startsWith\("desk\/"\)/);
  });
});
