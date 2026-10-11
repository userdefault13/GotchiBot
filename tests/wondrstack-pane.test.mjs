/**
 * WondrStack terminal UI: every state, driven by scripted keys against a fake server.
 * No network, no abra, no live site.   node --test tests/wondrstack-pane.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPane, renderView, fmtCountdown } from "../scripts/wondrstack-pane.mjs";
import { credKey, deviceConfig, DEVICE_GRANT, linkState, disconnect } from "../scripts/wondrstack.mjs";

const AT = "AT-secret-123";
const RT = "RT-secret-456";
const DC = "DC-secret-789";
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function fakeFetch(script, { authError } = {}) {
  let polls = 0;
  const json = (status, o) => ({ status, ok: status < 400, json: async () => o });
  return async (url, init) => {
    if (String(url).endsWith("/oauth/device_authorization")) {
      if (authError) return json(401, { error: authError });
      return json(200, { device_code: DC, user_code: "ABCD-1234", verification_uri: "https://wondrstack.xyz/device", verification_uri_complete: "https://wondrstack.xyz/device?user_code=ABCD-1234", expires_in: 600, interval: 5 });
    }
    const body = Object.fromEntries(new URLSearchParams(init.body));
    assert.equal(body.grant_type, DEVICE_GRANT);
    const step = script[Math.min(polls++, script.length - 1)];
    return step === "ok" ? json(200, { access_token: AT, refresh_token: RT, expires_in: 3600 }) : json(400, { error: step });
  };
}

function memStore(init) {
  const m = new Map(init ? [[credKey("gotchibot"), JSON.stringify({ access_token: AT, refresh_token: RT, via: "device" })]] : []);
  return { m, get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

function harness({ keys, script = ["ok"], store = memStore(), authError, sleep } = {}) {
  const frames = [];
  const opened = [];
  const queue = [...keys];
  let t = 1_000_000;
  const deps = {
    project: "gotchibot",
    store,
    config: deviceConfig({ WONDRSTACK_DEVICE_CLIENT_ID: "cid" }),
    cache: { get: () => null, set: () => {} },
    fetchFn: fakeFetch(script, { authError }),
    now: () => t,
    sleep: sleep || (async (ms) => { t += ms; }),
    open: (u) => opened.push(u),
    tick: () => () => {},
    draw: (lines) => frames.push(strip(lines.join("\n"))),
    // A key may be gated: [key, /frame regex/] is delivered only after a frame matching it is drawn.
    readKey: async () => {
      if (!queue.length) throw new Error("test ran out of keys");
      const [key, gate] = [].concat(queue.shift());
      for (let i = 0; gate && !frames.some((f) => gate.test(f)); i++) {
        if (i > 2000) throw new Error(`gate never met: ${gate}`);
        await new Promise((r) => setTimeout(r, 1));
      }
      return key;
    },
  };
  return { deps, frames, opened, all: () => frames.join("\n---\n") };
}
const noLeak = (text) => {
  for (const s of [AT, RT, DC]) assert.ok(!text.includes(s), `leaked ${s}`);
};

describe("wondrstack pane", () => {
  it("home: not linked offers connect", async () => {
    const h = harness({ keys: ["q"] });
    await runPane(h.deps);
    assert.match(h.frames[0], /not linked/);
    assert.match(h.frames[0], /c connect/);
  });

  it("home: linked offers disconnect and shows no token", async () => {
    const h = harness({ keys: ["q"], store: memStore(true) });
    await runPane(h.deps);
    assert.match(h.frames[0], /linked/);
    assert.doesNotMatch(h.frames[0], /not linked/);
    assert.match(h.frames[0], /d disconnect/);
    noLeak(h.all());
  });

  it("home: unreadable vault says so plainly", async () => {
    const store = { get: () => { throw new Error("abra vault is locked — run: abra unlock"); }, set() {}, remove() {} };
    const h = harness({ keys: ["q"], store });
    await runPane(h.deps);
    assert.match(h.frames[0], /Could not read the vault: abra vault is locked/);
  });

  it("confirm: shows the full-scope warning and n goes back without starting", async () => {
    const h = harness({ keys: ["c", "n", "q"] });
    await runPane(h.deps);
    const confirm = h.frames.find((f) => /Read this first/.test(f));
    assert.match(confirm, /FULL `wondrstack` scope/);
    assert.match(confirm, /deploy, delete and spend/);
    assert.ok(!h.frames.some((f) => /Waiting for approval/.test(f)));
    assert.equal(h.deps.store.m.size, 0);
  });

  it("waiting then approved: link, large code, matches line, countdown; tokens stored, never shown", async () => {
    const h = harness({ keys: ["c", "y", ["x", /Connected\./], "q"], script: ["authorization_pending", "authorization_pending", "ok"] });
    await runPane(h.deps);
    const waiting = h.frames.find((f) => /Waiting for approval/.test(f));
    assert.match(waiting, /https:\/\/wondrstack\.xyz\/device/);
    assert.match(waiting, /A B C D - 1 2 3 4/);
    assert.match(waiting, /code on the page matches/);
    assert.match(waiting, /expires in 10:00/);
    assert.ok(h.frames.some((f) => /Connected\./.test(f)));
    assert.equal(JSON.parse(h.deps.store.m.get(credKey("gotchibot"))).access_token, AT);
    noLeak(h.all());
    assert.match(h.frames.at(-1), /linked/);
  });

  it("o opens the link in one key", async () => {
    // keep the poll pending until the key is read: sleep yields to the event loop
    const h = harness({ keys: ["c", "y", ["o", /Waiting for approval/], "q", ["x", /Cancelled\./], "q"], script: ["authorization_pending"], sleep: () => new Promise((r) => setTimeout(r, 5)) });
    await runPane(h.deps);
    assert.deepEqual(h.opened, ["https://wondrstack.xyz/device?user_code=ABCD-1234"]);
  });

  it("denied: plain wording, nothing stored", async () => {
    const h = harness({ keys: ["c", "y", ["x", /Not approved/], "q"], script: ["authorization_pending", "access_denied"] });
    await runPane(h.deps);
    assert.ok(h.frames.some((f) => /Not approved\./.test(f) && /nothing was connected/.test(f)));
    assert.equal(h.deps.store.m.size, 0);
    noLeak(h.all());
  });

  it("expired: plain wording, nothing stored", async () => {
    const h = harness({ keys: ["c", "y", ["x", /code expired/], "q"], script: ["expired_token"] });
    await runPane(h.deps);
    assert.ok(h.frames.some((f) => /The code expired/.test(f)));
    assert.equal(h.deps.store.m.size, 0);
  });

  it("error: server refusal is shown plainly", async () => {
    const h = harness({ keys: ["c", "y", ["x", /Could not connect/], "q"], authError: "invalid_client" });
    await runPane(h.deps);
    assert.ok(h.frames.some((f) => /Could not connect\./.test(f) && /invalid_client/.test(f)));
    assert.equal(h.deps.store.m.size, 0);
    noLeak(h.all());
  });

  it("q while waiting cancels", async () => {
    const h = harness({ keys: ["c", "y", ["q", /Waiting for approval/], ["x", /Cancelled\./], "q"], script: ["authorization_pending"], sleep: () => new Promise((r) => setTimeout(r, 5)) });
    await runPane(h.deps);
    assert.ok(h.frames.some((f) => /Cancelled\./.test(f)));
    assert.equal(h.deps.store.m.size, 0);
  });

  it("disconnect: confirm says revocation is unsupported; n keeps tokens, y removes them", async () => {
    const keep = harness({ keys: ["d", "n", "q"], store: memStore(true) });
    await runPane(keep.deps);
    const ask = keep.frames.find((f) => /DISCONNECT/.test(f));
    assert.match(ask, /revocation is not supported/);
    assert.match(ask, /only the stored tokens are deleted/);
    assert.equal(keep.deps.store.m.size, 1);

    const gone = harness({ keys: ["d", "y", "x", "q"], store: memStore(true) });
    await runPane(gone.deps);
    assert.ok(gone.frames.some((f) => /Removed the stored WondrStack sign-in/.test(f) && /Not revoked/.test(f)));
    assert.equal(gone.deps.store.m.size, 0);
    assert.match(gone.frames.at(-1), /not linked/);
    noLeak(gone.all());
  });
});

describe("wondrstack library for the pane", () => {
  it("linkState answers yes/no only; disconnect reports it did not revoke", () => {
    const s = memStore(true);
    const st = linkState("gotchibot", { store: s });
    assert.deepEqual(st, { linked: true, via: "device" });
    assert.equal(JSON.stringify(st).includes(AT), false);
    assert.deepEqual(disconnect("gotchibot", { store: s }), { removed: true, revoked: false });
    assert.deepEqual(linkState("gotchibot", { store: s }), { linked: false });
  });
  it("formats the countdown", () => {
    assert.equal(fmtCountdown(600000), "10:00");
    assert.equal(fmtCountdown(61000), "01:01");
    assert.equal(fmtCountdown(-5), "00:00");
  });
  it("renders every view without throwing", () => {
    for (const name of ["home", "confirm", "starting", "approved", "denied", "expired", "cancelled", "error", "disconnect-confirm", "disconnected"]) {
      assert.ok(renderView({ name, state: {}, message: "x" }, { cols: 60 }).length > 2);
    }
  });
});
