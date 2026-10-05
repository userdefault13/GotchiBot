/**
 * Status-bar OpenClaw probe: local health on the gateway machine, hub SSH otherwise.
 *   node --test tests/openclaw-status-gateway.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statusGatewayReachable } from "../scripts/openclaw-fleet.mjs";

function boom() {
  throw new Error("execRemote should not be called");
}

describe("statusGatewayReachable", () => {
  it("uses a local 2xx and does not ssh", async () => {
    let called = false;
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => true,
      execRemote: async () => {
        called = true;
        return "OC_HEALTHZ:500\n";
      },
    });
    assert.equal(ok, true);
    assert.equal(called, false);
  });

  it("treats a local HTTP error as down", async () => {
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => false,
      execRemote: boom,
    });
    assert.equal(ok, false);
  });

  it("on the hub, local unreachable is down and does not ssh", async () => {
    let called = false;
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy.tail4120f5.ts.net",
      hostname: "imacOmarchy",
      probeLocal: async () => null,
      execRemote: async () => {
        called = true;
        return "OC_HEALTHZ:200\n";
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("on a desk, ssh curl 200 is up", async () => {
    let port = null;
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => null,
      probeTailnet: async () => null,
      execRemote: async (p) => {
        port = p;
        return "OC_HEALTHZ:200\n";
      },
    });
    assert.equal(ok, true);
    assert.equal(port, "18789");
  });

  it("on a desk, a completed non-2xx curl is down", async () => {
    for (const marker of ["OC_HEALTHZ:000\n", "OC_HEALTHZ:503\n", "OC_HEALTHZ:\n"]) {
      const ok = await statusGatewayReachable({
        port: "18789",
        hubHost: "imacomarchy",
        hostname: "Mac.lan",
        probeLocal: async () => null,
        probeTailnet: async () => null,
        execRemote: async () => marker,
      });
      assert.equal(ok, false, marker);
    }
  });

  it("is unknown when ssh fails or the marker never arrives", async () => {
    const thrown = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => null,
      probeTailnet: async () => null,
      execRemote: async () => {
        throw new Error("ssh failed");
      },
    });
    assert.equal(thrown, null);
    const bare = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => null,
      probeTailnet: async () => null,
      execRemote: async () => "ssh: connect to host: Operation timed out\n",
    });
    assert.equal(bare, null);
  });

  it("is unknown when there is no hub target", async () => {
    let called = false;
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "",
      hostname: "Mac.lan",
      probeLocal: async () => null,
      probeTailnet: async () => null,
      execRemote: async () => {
        called = true;
        return "OC_HEALTHZ:200\n";
      },
    });
    assert.equal(ok, null);
    assert.equal(called, false);
  });

  it("refuses a non-digit port without probing", async () => {
    let local = false;
    let remote = false;
    const ok = await statusGatewayReachable({
      port: "18789;rm",
      hubHost: "imacomarchy",
      hostname: "Mac.lan",
      probeLocal: async () => {
        local = true;
        return null;
      },
      execRemote: async () => {
        remote = true;
        return "OC_HEALTHZ:200\n";
      },
    });
    assert.equal(ok, null);
    assert.equal(local, false);
    assert.equal(remote, false);
  });

  it("on a desk, a healthy gateway over the tailnet is up without SSH", async () => {
    let url = null;
    const ok = await statusGatewayReachable({
      port: "18789",
      hubHost: "imacomarchy.tail4120f5.ts.net",
      hostname: "Mac.lan",
      probeLocal: async () => null,
      probeTailnet: async (u) => {
        url = u;
        return true;
      },
      execRemote: boom,
    });
    assert.equal(ok, true);
    assert.equal(url, "http://imacomarchy.tail4120f5.ts.net:18789/healthz");
  });
});
