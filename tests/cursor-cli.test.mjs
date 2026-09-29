import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStreamEvent,
  chatFor,
  chatKey,
  cursorArgs,
  followRun,
  jobEnv,
  rememberChat,
  toolSummary,
} from "../scripts/cursor-cli.mjs";

const sink = () => {
  const out = { text: "", write: (s) => (out.text += s) };
  return out;
};

function runDir({ status = "running", pid = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gb-cursor-"));
  writeFileSync(join(dir, "state.env"), `status=${status}\nstarted=2026-09-29T00:00:00Z\nprovider=cursor-cli\n`);
  if (pid != null) writeFileSync(join(dir, "job.pid"), `${pid}\n`);
  return dir;
}

describe("cursor-cli", () => {
  it("each OpenCode session / hero keeps its own Cursor chat; plain CLI keeps the shared one", () => {
    assert.equal(chatKey({ OPENCODE_SESSION_ID: "ses_a", GOTCHIBOT_HERO_ID: "h1" }), "oc:ses_a");
    assert.equal(chatKey({ GOTCHIBOT_HERO_ID: "h1" }), "hero:h1");
    assert.equal(chatKey({}), null);

    const state = { activeChatId: "shared", chats: [], bySession: {} };
    const save = () => {};
    rememberChat(state, "chat-a", "prompt a", "oc:ses_a", { save });
    rememberChat(state, "chat-b", "prompt b", "oc:ses_b", { save });
    assert.equal(chatFor(state, "oc:ses_a"), "chat-a");
    assert.equal(chatFor(state, "oc:ses_b"), "chat-b");
    assert.equal(chatFor(state, "oc:ses_new"), null, "a new session starts a new Cursor chat");
    assert.equal(chatFor(state, null), "shared", "sessions never move the shared chat");
    rememberChat(state, "chat-c", "manual", null, { save });
    assert.equal(chatFor(state, null), "chat-c");
  });

  it("headless runs stream json; interactive launch does not", () => {
    const args = cursorArgs({ cwd: "/r" }, "chat-1", "PROMPT");
    assert.deepEqual(args.slice(0, 7), ["--workspace", "/r", "--trust", "--print", "--output-format", "stream-json", "--stream-partial-output"]);
    assert.deepEqual(args.slice(-3), ["--resume", "chat-1", "PROMPT"]);
    assert.ok(!cursorArgs({ cwd: "/r", interactive: true }, null, "P").includes("--print"));
  });

  it("stream-json events become progress lines, live text, and the final answer", () => {
    const run = { live: "", final: null, isError: false };
    const tool = {
      type: "tool_call",
      subtype: "started",
      tool_call: { globToolCall: { args: { targetDirectory: "/r", globPattern: "scripts/lib/**/*" } } },
    };
    assert.deepEqual(applyStreamEvent(run, tool, "/r"), { progress: "· glob scripts/lib/**/*" });
    assert.deepEqual(applyStreamEvent(run, { ...tool, subtype: "completed" }, "/r"), {});

    const delta = (text) => ({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text }] } });
    assert.deepEqual(applyStreamEvent(run, delta("Nine "), "/r"), { text: "Nine ", progress: "· writing the reply" });
    assert.deepEqual(applyStreamEvent(run, delta("files."), "/r"), { text: "files.", progress: null });
    applyStreamEvent(run, { type: "assistant", message: { content: [{ type: "text", text: "Nine files." }] } });
    assert.equal(run.live, "Nine files.", "the closing full message is not double-counted");
    applyStreamEvent(run, { type: "result", is_error: false, result: "Nine files." });
    assert.equal(run.final, "Nine files.");

    assert.equal(toolSummary({ editToolCall: { args: { path: "/r/scripts/x.mjs" } } }, "/r"), "edit scripts/x.mjs");
    assert.equal(toolSummary({ shellToolCall: { args: { command: "npm   test\n--watch" } } }), "shell npm test --watch");
    assert.equal(toolSummary({ weirdToolCall: {} }), "weird");
    assert.equal(toolSummary({}), "tool");
  });

  it("the job environment carries no provider keys", () => {
    const env = jobEnv({ HOME: "/h", PATH: "/bin", TERM: "dumb", OPENAI_API_KEY: "x", GOTCHIBOT_DESK_TOKEN: "y", NVIDIA_API_KEY: "z" });
    assert.deepEqual(env, { HOME: "/h", PATH: "/bin", TERM: "xterm-256color" });
  });

  it("followRun streams progress and returns the answer when the job finishes", async () => {
    const dir = runDir({ pid: process.pid });
    const out = sink();
    const p = followRun(dir, { waitMs: 5_000, out, pollMs: 20 });
    appendFileSync(join(dir, "progress.log"), "· read a.mjs\n");
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(join(dir, "progress.log"), "· writing the reply\n");
    writeFileSync(join(dir, "output.md"), "all done");
    writeFileSync(join(dir, "state.env"), "status=done\n");
    const r = await p;
    assert.deepEqual(r, { done: true, ok: true, output: "all done" });
    assert.equal(out.text, "· read a.mjs\n· writing the reply\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the job runs cursor-agent to a result even when the binary lingers after it (Linux)", () => {
    const dir = runDir();
    const fake = join(dir, "fake-cursor-agent");
    const events = [
      { type: "system", subtype: "init" },
      { type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: `${dir}/a.mjs` } } } },
      { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "It is " }] } },
      { type: "assistant", timestamp_ms: 2, message: { content: [{ type: "text", text: "fine." }] } },
      { type: "result", is_error: false, result: "It is fine." },
    ];
    writeFileSync(
      fake,
      `#!${process.execPath}\n` +
        `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));\n` +
        "setInterval(() => {}, 1000);\n",
    );
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, "job.json"), JSON.stringify({ bin: fake, args: [], cwd: dir, chatId: "chat-x", timeoutMs: 20_000 }));
    writeFileSync(join(dir, "prompt.txt"), "PROMPT");
    const r = spawnSync(process.execPath, [new URL("../scripts/cursor-cli.mjs", import.meta.url).pathname, "job", dir], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, "state.env"), "utf8"), /^status=done$/m);
    assert.equal(readFileSync(join(dir, "output.md"), "utf8"), "It is fine.");
    assert.equal(readFileSync(join(dir, "progress.log"), "utf8"), "· read a.mjs\n· writing the reply\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("followRun gives up waiting (job keeps running), and fails a job that died or never started", async () => {
    const running = runDir({ pid: process.pid });
    assert.deepEqual(await followRun(running, { waitMs: 50, out: sink(), pollMs: 10 }), { done: false });

    const dead = runDir({ pid: 2 ** 22 + 12345 });
    const r = await followRun(dead, { waitMs: 5_000, out: sink(), pollMs: 10 });
    assert.equal(r.ok, false);
    assert.match(r.output, /exited without a result/);

    const never = runDir();
    const n = await followRun(never, { waitMs: 5_000, out: sink(), pollMs: 10, startMs: 30 });
    assert.equal(n.ok, false);
    assert.match(n.output, /never started/);
    for (const d of [running, dead, never]) rmSync(d, { recursive: true, force: true });
  });
});
