/**
 * Hub tmux status: a known hub is ok or bad. Unreachable is unavailable, never "?".
 *   node --test tests/imac-status-format.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../scripts/imac-status.mjs";

const quiet = {
  readCache: () => ({}),
  loadSnapshot: () => null,
};

function line(fields, deps = {}) {
  return formatStatus(fields, { ...quiet, ...deps });
}

describe("formatStatus hub word", () => {
  it("says ok when the hub is up", () => {
    const text = line({ remoteOk: true, running: 2, total: 3, openclawReachable: true });
    assert.match(text, /^Hub: ok · 2 run · OC✓/);
    assert.equal(text.includes("Hub: up"), false);
  });

  it("says bad when the hub is down", () => {
    const text = line({ remoteOk: false, reason: "ssh failed", openclawReachable: false });
    assert.equal(text, "Hub: bad · OC✗");
    assert.equal(text.includes("down"), false);
  });

  it("keeps no-ssh separate from a down hub", () => {
    const text = line({
      remoteOk: false,
      reason: "no-remote-ssh-env",
      openclawReachable: null,
    });
    assert.equal(text, "Hub: no-ssh · OC?");
  });

  it("says unavailable when there is no ssh and no snapshot", () => {
    const text = line({ staleNoSsh: true, remoteOk: false, openclawReachable: null });
    assert.equal(text, "Hub: unavailable · OC?");
    assert.equal(text.includes("Hub: ?"), false);
    assert.equal(text.includes("…"), false);
    assert.equal(text.includes("..."), false);
    assert.equal(text.includes("ok"), false);
    assert.equal(text.includes("bad"), false);
  });

  it("rewrites a cached question mark to unavailable", () => {
    const text = line(
      { remoteOk: false, openclawReachable: null },
      {
        readCache: () => ({
          barLine: "Hub: ? · idle · OC?",
          hubFetchedAt: new Date().toISOString(),
        }),
      },
    );
    assert.equal(text, "Hub: unavailable · idle · OC?");
  });

  it("says ok from a stale snapshot that was up", () => {
    const text = line(
      { staleNoSsh: true, openclawReachable: true },
      { loadSnapshot: () => ({ remoteOk: true, running: 1, total: 2 }) },
    );
    assert.match(text, /^Hub: ok · 1 run · OC✓/);
  });

  it("says bad from a stale snapshot that was down", () => {
    const text = line(
      { staleNoSsh: true, openclawReachable: false },
      { loadSnapshot: () => ({ remoteOk: false }) },
    );
    assert.equal(text, "Hub: bad · OC✗");
  });
});

describe("formatStatus live hub probe", () => {
  const freshUnavailable = () => ({
    barLine: "Hub: unavailable · idle",
    hubFetchedAt: new Date().toISOString(),
  });

  it("says ok when the probe answers, over no-ssh and a fresh cached unavailable", () => {
    const text = line(
      {
        apiReachable: true,
        staleNoSsh: true,
        remoteOk: false,
        reason: "no-remote-ssh-env",
        running: 1,
        total: 2,
        openclawReachable: true,
      },
      { readCache: freshUnavailable, loadSnapshot: () => null },
    );
    assert.equal(text, "Hub: ok · 1 run · OC✓");
  });

  it("says ok · idle when the probe answers and nothing runs", () => {
    const text = line(
      { apiReachable: true, staleNoSsh: true, remoteOk: false, openclawReachable: null },
      { readCache: freshUnavailable },
    );
    assert.equal(text, "Hub: ok · idle · OC?");
  });

  it("says unavailable when the probe fails, never ? or bad for missing ssh", () => {
    const text = line(
      {
        apiReachable: false,
        staleNoSsh: true,
        remoteOk: false,
        reason: "no-remote-ssh-env",
        openclawReachable: false,
      },
      {
        readCache: () => ({ barLine: "Hub: ? · idle · OC?", hubFetchedAt: new Date().toISOString() }),
        loadSnapshot: () => ({ remoteOk: false }),
      },
    );
    assert.equal(text, "Hub: unavailable · OC✗");
    assert.equal(text.includes("Hub: ?"), false);
    assert.equal(text.includes("bad"), false);
  });

  it("keeps the cached barLine when there is no probe result", () => {
    const text = line(
      { apiReachable: null, remoteOk: true, running: 3, openclawReachable: true },
      { readCache: freshUnavailable },
    );
    assert.equal(text, "Hub: unavailable · idle");
  });

  it("keeps stale-snapshot behavior when apiReachable is undefined", () => {
    const text = line(
      { staleNoSsh: true, openclawReachable: false },
      { loadSnapshot: () => ({ remoteOk: false }) },
    );
    assert.equal(text, "Hub: bad · OC✗");
  });
});
