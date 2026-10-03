/**
 * Desk load checks the Mac desk receiver and starts it when :45679 is down.
 *   node --test tests/desk-receiver-on-load.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESK_RECEIVER_HEALTH_URL,
  DESK_RECEIVER_PORT,
  checkReceiverHealth,
  ensureDeskReceiver,
  receiverScriptCandidates,
} from "../scripts/desk-receiver-ensure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gotchi = readFileSync(join(root, "scripts/gotchibot"), "utf8");
const chat = readFileSync(join(root, "scripts/chat-pane.sh"), "utf8");
const bridge = readFileSync(join(root, "scripts/hub-bridge-ensure.mjs"), "utf8");

function fnBody(src, name) {
  const start = src.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} missing`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

describe("desk receiver ensure", () => {
  it("health URL is the desk receiver on 127.0.0.1:45679", () => {
    assert.equal(DESK_RECEIVER_PORT, 45679);
    assert.equal(DESK_RECEIVER_HEALTH_URL, "http://127.0.0.1:45679/health");
  });

  it("checkReceiverHealth is true only when /health responds ok", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(500);
      res.end("no");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      assert.equal(await checkReceiverHealth(`http://127.0.0.1:${port}/health`), true);
      assert.equal(await checkReceiverHealth(`http://127.0.0.1:${port}/missing`), false);
      assert.equal(await checkReceiverHealth("http://127.0.0.1:1/health"), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("starts mbp-receiver/receiver.js when health fails, and not when it is up", async () => {
    const home = "/Users/julius";
    const script = join(home, "Dev/gotchibot-bridge/mbp-receiver/receiver.js");
    assert.deepEqual(receiverScriptCandidates(home)[0], script);

    const spawned = [];
    let up = false;
    const down = await ensureDeskReceiver({
      home,
      exists: (p) => p === script,
      check: async () => up,
      spawnReceiver: (p) => {
        spawned.push(p);
        up = true;
      },
      sleep: async () => {},
    });
    assert.equal(down.started, true);
    assert.equal(down.ok, true);
    assert.equal(down.port, 45679);
    assert.deepEqual(spawned, [script]);

    const healthy = await ensureDeskReceiver({
      home,
      exists: () => true,
      check: async () => true,
      spawnReceiver: () => {
        throw new Error("must not start");
      },
      sleep: async () => {},
    });
    assert.deepEqual(healthy, { ok: true, started: false, port: 45679 });
  });

  it("does not spawn when the receiver script is missing", async () => {
    const result = await ensureDeskReceiver({
      home: "/tmp/nobody",
      exists: () => false,
      check: async () => false,
      spawnReceiver: () => {
        throw new Error("must not start");
      },
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.started, false);
    assert.equal(result.reason, "script-missing");
  });
});

describe("desk load calls the receiver check", () => {
  it("gotchibot tmux (cmd_tmux) ensures the receiver and does not open the VS bridge", () => {
    const tmux = fnBody(gotchi, "cmd_tmux");
    assert.match(tmux, /ensure_desk_receiver_on_load/);
    const ensure = fnBody(gotchi, "ensure_desk_receiver_on_load");
    assert.match(ensure, /scripts\/desk-receiver-ensure\.mjs/);
    assert.equal(tmux.includes("hub-bridge-ensure"), false);
    assert.equal(ensure.includes("hub-bridge-ensure"), false);
    assert.equal(ensure.includes("vscode"), false);
  });

  it("chat pane load checks the receiver next to the wisp proxy", () => {
    const wisp = chat.indexOf("ensure_wisp_proxy\n");
    const recv = chat.indexOf("ensure_desk_receiver\n");
    assert.ok(wisp > 0 && recv > wisp);
    const body = fnBody(chat, "ensure_desk_receiver");
    assert.match(body, /scripts\/desk-receiver-ensure\.mjs/);
    assert.equal(body.includes("hub-bridge-ensure"), false);
  });

  it("hub-bridge-ensure still starts a down receiver without being the desk-load path", () => {
    assert.match(bridge, /ensureDeskReceiver/);
    assert.match(bridge, /checkReceiverHealth/);
    assert.match(bridge, /45679/);
  });
});
