/**
 * Read-only hub MCP: snapshot word, secret omission, gateway-check predicate.
 *   node --test tests/mcp-hub-status.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubWord,
  publicCacheFields,
  readHubSnapshot,
  decideGatewayWouldRun,
} from "../mcp-servers/hub-status/hub-status-lib.mjs";

describe("hub snapshot word", () => {
  it("says ok only when remoteOk is true", () => {
    assert.equal(hubWord({ remoteOk: true, openclawReachable: false }), "ok");
  });

  it("says bad when ssh was attempted and the hub is down", () => {
    assert.equal(hubWord({ remoteOk: false, reason: "ssh failed" }), "bad");
  });

  it("says ? when ssh was not configured", () => {
    assert.equal(
      hubWord({ remoteOk: false, reason: "no-remote-ssh-env (abra run gotchibot -- …)" }),
      "?",
    );
  });

  it("says ? when the snapshot has no hub fields", () => {
    assert.equal(hubWord({ openclawReachable: true, fetchedAt: "2026-10-02T00:00:00.000Z" }), "?");
  });

  it("reads a barLine when remoteOk was not stored", () => {
    assert.equal(hubWord({ barLine: "Hub: bad · idle · OC?" }), "bad");
    assert.equal(hubWord({ barLine: "Hub: no-ssh · OC?" }), "?");
  });

  it("is ? when the cache file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-mcp-"));
    try {
      const snap = readHubSnapshot(dir);
      assert.deepEqual(snap, { snapshot: "missing", hub: "?", fields: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secret omission", () => {
  it("keeps the allowlist and drops tokens, keys, and cookies", () => {
    const fields = publicCacheFields({
      remoteOk: false,
      reason: "ssh failed",
      openclawReachable: null,
      fetchedAt: "2026-10-02T19:15:00.000Z",
      barLine: "Hub: bad · OC?",
      token: "should-not-appear",
      deskToken: "desk-secret",
      apiKey: "sk_live_abcdefghij",
      password: "hunter2",
      sessionCookie: "sid=abc",
      gateway: "http://127.0.0.1:18789/?token=sekret",
      containers: [{ name: "mongo" }],
    });
    assert.equal(fields.remoteOk, false);
    assert.equal(fields.reason, "ssh failed");
    assert.equal(fields.fetchedAt, "2026-10-02T19:15:00.000Z");
    assert.equal(JSON.stringify(fields).includes("sekret"), false);
    assert.equal(JSON.stringify(fields).includes("hunter2"), false);
    assert.equal(JSON.stringify(fields).includes("desk-secret"), false);
    assert.equal(JSON.stringify(fields).includes("sk_live"), false);
    assert.equal(Object.hasOwn(fields, "gateway"), false);
    assert.equal(Object.hasOwn(fields, "containers"), false);
  });

  it("drops a secret-shaped reason", () => {
    const fields = publicCacheFields({
      remoteOk: false,
      reason: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature",
    });
    assert.equal(Object.hasOwn(fields, "reason"), false);
  });

  it("does not echo a token planted in a cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-mcp-"));
    try {
      mkdirSync(join(dir, "sessions"));
      writeFileSync(
        join(dir, "sessions/.imac-status-cache.json"),
        JSON.stringify({
          remoteOk: true,
          running: 1,
          total: 2,
          openclawReachable: true,
          fetchedAt: "2026-10-02T19:15:00.000Z",
          token: "super-secret-token",
          SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
        }),
      );
      const snap = readHubSnapshot(dir);
      assert.equal(snap.hub, "ok");
      const text = JSON.stringify(snap);
      assert.equal(text.includes("super-secret-token"), false);
      assert.equal(text.includes("PRIVATE KEY"), false);
      assert.equal(snap.fields.running, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateway check predicate", () => {
  it("does not probe when the port is not all digits", () => {
    const d = decideGatewayWouldRun({
      port: "18789;rm",
      route: { kind: "ssh", host: "hub" },
      hostname: "desk",
    });
    assert.equal(d.wouldRun, false);
    assert.equal(d.localProbeWouldRun, false);
    assert.equal(d.remoteCheckWouldRun, false);
  });

  it("does not run the remote check when hubHealthRoute is none", () => {
    const d = decideGatewayWouldRun({
      port: "18789",
      route: { kind: "none", host: "" },
      hostname: "desk",
    });
    assert.equal(d.wouldRun, false);
    assert.equal(d.remoteCheckWouldRun, false);
    assert.equal(d.localProbeWouldRun, true);
    assert.match(d.reason, /would not run/);
  });

  it("does not SSH when this machine is the hub", () => {
    const d = decideGatewayWouldRun({
      port: "18789",
      route: { kind: "ssh", host: "imacOmarchy.local" },
      hostname: "imacomarchy",
    });
    assert.equal(d.wouldRun, false);
    assert.equal(d.remoteCheckWouldRun, false);
    assert.match(d.reason, /does not SSH/);
  });

  it("is unknown when the remote check depends on loopback", () => {
    const d = decideGatewayWouldRun({
      port: "18789",
      route: { kind: "remote-lib", host: "hub.example" },
      hostname: "desk.local",
    });
    assert.equal(d.wouldRun, null);
    assert.equal(d.remoteCheckWouldRun, null);
    assert.match(d.reason, /^unknown:/);
    assert.equal(d.reason.includes("hub.example"), false);
  });
});
