/**
 * Hub chat MCP: ping is an ordinary send, handoff is an ack, secrets stay out.
 *   node --test tests/mcp-hub-chat.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeChatArgs, redactSecrets, talkToHub } from "../mcp-servers/hub-status/chat-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = {
  ...process.env,
  GOTCHIBOT_DESK_API_BASE: "http://hub.test.ts.net:8794",
  GOTCHIBOT_DESK_TOKEN: "gbd_testtokenvalue",
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("chat args", () => {
  it("treats ping as ordinary chat text with the expected word pong", () => {
    const args = normalizeChatArgs({ mode: "chat", text: "ping" });
    assert.equal(args.ping, true);
    assert.equal(args.title, "ping");
    assert.equal(args.waitMs, 8000);
  });

  it("names a handoff and does not wait by default", () => {
    const args = normalizeChatArgs({ mode: "handoff", text: "check the roster" });
    assert.equal(args.mode, "handoff");
    assert.equal(args.title, "handoff");
    assert.equal(args.ping, false);
    assert.equal(args.waitMs, 0);
  });

  it("rejects a blank task", () => {
    assert.throws(() => normalizeChatArgs({ mode: "handoff", text: "  " }), /task required/);
  });
});

describe("talkToHub", () => {
  it("returns pong only when the hub wrote it", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      const u = new URL(url);
      calls.push({ path: u.pathname, method: opts.method, body: opts.body, header: opts.headers["X-GotchiBot-Desk-Token"] });
      if (u.pathname.endsWith("/chats/send")) {
        return jsonResponse(200, {
          ok: true,
          threadId: "thread-1",
          messageId: "m1",
          seq: 4,
          reply: { status: "pending" },
        });
      }
      if (u.pathname.endsWith("/hub/runner")) {
        return jsonResponse(200, { ok: true, runner: { status: "ok", detail: "up", model: "chat" } });
      }
      return jsonResponse(200, {
        ok: true,
        messages: [
          { seq: 5, role: "assistant", op: "message", text: "pong", messageId: "m2" },
        ],
      });
    };
    const result = await talkToHub({
      mode: "chat",
      text: "ping",
      env: ENV,
      fetchImpl,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    assert.equal(result.ping.matched, true);
    assert.equal(result.ping.expected, "pong");
    assert.equal(result.reply.text, "pong");
    assert.equal(result.accepted, true);
    assert.equal(JSON.stringify(result).includes("gbd_testtokenvalue"), false);
    assert.equal(calls[0].header, "gbd_testtokenvalue");
    assert.equal(JSON.parse(calls[0].body).text, "ping");
  });

  it("acknowledges a handoff when the desk token does not queue a run", async () => {
    let pulls = 0;
    const fetchImpl = async (url, opts) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/chats/send")) {
        assert.equal(JSON.parse(opts.body).title, "handoff");
        return jsonResponse(200, {
          ok: true,
          threadId: "thread-h",
          messageId: "mh",
          seq: 9,
          reply: { status: "none" },
        });
      }
      if (path.endsWith("/hub/runner")) {
        return jsonResponse(200, { ok: true, runner: { status: "offline", detail: "no beat" } });
      }
      pulls += 1;
      return jsonResponse(200, { ok: true, messages: [] });
    };
    const result = await talkToHub({
      mode: "handoff",
      text: "note the avatar order",
      env: ENV,
      fetchImpl,
      sleep: async () => {},
    });
    assert.equal(result.accepted, true);
    assert.equal(result.ack.status, "none");
    assert.equal(result.reply, null);
    assert.match(result.note, /accepted the handoff/);
    assert.match(result.note, /none/);
    assert.equal(pulls, 1);
    assert.equal(result.ping, undefined);
  });

  it("does not invent pong when the queued reply never arrives", async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/chats/send")) {
        return jsonResponse(200, {
          ok: true,
          threadId: "thread-1",
          messageId: "m1",
          seq: 1,
          reply: { status: "pending" },
        });
      }
      if (path.endsWith("/hub/runner")) {
        return jsonResponse(200, {
          ok: true,
          runner: { status: "offline", detail: "bridge down", lastBeatAt: "2026-10-02T19:36:20.000Z" },
        });
      }
      return jsonResponse(200, { ok: true, messages: [] });
    };
    let clock = 0;
    const result = await talkToHub({
      mode: "chat",
      text: "ping",
      waitMs: 0,
      env: ENV,
      fetchImpl,
      sleep: async () => {},
      now: () => clock,
    });
    assert.equal(result.reply, null);
    assert.equal(result.ping.matched, false);
    assert.equal(result.ping.expected, "pong");
    assert.match(result.note, /No assistant reply/);
    assert.match(result.note, /were not started/);
  });

  it("redacts a desk token echoed in an error", async () => {
    const fetchImpl = async () => jsonResponse(401, { error: "bad token gbd_testtokenvalue" });
    await assert.rejects(
      () => talkToHub({ mode: "chat", text: "ping", env: ENV, fetchImpl }),
      (err) => {
        assert.equal(String(err.message).includes("gbd_testtokenvalue"), false);
        assert.match(err.message, /gbd_\[redacted\]/);
        return true;
      },
    );
  });

  it("does not call the network when the desk is not paired", async () => {
    let called = false;
    await assert.rejects(
      () =>
        talkToHub({
          mode: "chat",
          text: "ping",
          env: { ...process.env, GOTCHIBOT_DESK_API_BASE: "", GOTCHIBOT_DESK_TOKEN: "", GOTCHIBOT_HUB_PIN: "/no/such/pin.json" },
          fetchImpl: async () => {
            called = true;
            throw new Error("should not fetch");
          },
        }),
      /not paired|No Hub pinned/,
    );
    assert.equal(called, false);
  });
});

describe("redact", () => {
  it("strips desk tokens and private keys", () => {
    const out = redactSecrets("see gbd_abcDEF123456 and -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
    assert.equal(out.includes("gbd_abcDEF"), false);
    assert.equal(out.includes("PRIVATE KEY"), false);
  });
});

describe("stdio tools", () => {
  it("lists the old tools and the chat tools", async () => {
    const child = spawn(process.execPath, ["mcp-servers/hub-status/stdio.mjs"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const lines = buf.trim().split("\n").map((l) => JSON.parse(l));
    const listed = lines.find((m) => m.id === 2);
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "gotchibot_chat",
      "gotchibot_handoff",
      "hub_status",
      "openclaw_gateway_check_would_run",
    ]);
  });
});
