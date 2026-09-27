import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tailscaleState, hubProbeTargets, tailscaleDownloadUrl } from "../scripts/tailscale-cli.mjs";
import { discoverHubs, HUB_PORTS } from "../scripts/hub-network.mjs";

const status = (over = {}) => ({
  BackendState: "Running",
  Self: { DNSName: "desk.tail1.ts.net.", HostName: "desk", UserID: 1, OS: "macOS", TailscaleIPs: ["100.64.0.1", "fd7a::1"] },
  User: { 1: { LoginName: "me@example.com" } },
  CurrentTailnet: { Name: "me@example.com" },
  Peer: {
    a: { DNSName: "hub.tail1.ts.net.", HostName: "hub", UserID: 1, OS: "linux", Online: true, TailscaleIPs: ["100.64.0.2"] },
    b: { DNSName: "phone.tail1.ts.net.", HostName: "phone", UserID: 1, OS: "iOS", Online: true, TailscaleIPs: ["100.64.0.3"] },
    c: { DNSName: "old.tail1.ts.net.", HostName: "old", UserID: 1, OS: "linux", Online: false, TailscaleIPs: ["100.64.0.4"] },
    d: { DNSName: "friend.tail1.ts.net.", HostName: "friend", UserID: 2, OS: "linux", Online: true, TailscaleIPs: ["100.64.0.5"] },
  },
  ...over,
});

describe("tailscaleState", () => {
  it("missing CLI", () => {
    assert.equal(tailscaleState({ missing: true, json: null }).state, "missing");
  });
  it("daemon down when status is not JSON", () => {
    assert.equal(tailscaleState({ missing: false, json: null, err: "failed to connect" }).state, "daemon-down");
  });
  it("running exposes MagicDNS name and login", () => {
    const s = tailscaleState({ missing: false, json: status() });
    assert.equal(s.state, "running");
    assert.equal(s.dnsName, "desk.tail1.ts.net");
    assert.equal(s.login, "me@example.com");
  });
  it("maps backend states", () => {
    const of = (b) => tailscaleState({ missing: false, json: status({ BackendState: b }) }).state;
    assert.equal(of("NeedsLogin"), "needs-login");
    assert.equal(of("NoState"), "needs-login");
    assert.equal(of("NeedsMachineAuth"), "needs-approval");
    assert.equal(of("Stopped"), "stopped");
    assert.equal(of("Starting"), "starting");
  });
});

describe("hubProbeTargets", () => {
  it("keeps online non-phone devices, self included, IPv4 first", () => {
    const t = hubProbeTargets(status());
    assert.deepEqual(t.map((x) => x.name).sort(), ["desk", "friend", "hub"]);
    const self = t.find((x) => x.self);
    assert.equal(self.ip, "100.64.0.1");
    assert.equal(t.find((x) => x.name === "friend").sameUser, false);
    assert.equal(t.find((x) => x.name === "hub").sameUser, true);
  });
});

describe("discoverHubs", () => {
  it("finds the Hub by MagicDNS name on a non-default port", async () => {
    const probe = async (host, port) =>
      host === "hub.tail1.ts.net" && port === 8794 ? { service: "gotchibot-api", version: "1" } : null;
    const hits = await discoverHubs(status(), { probe });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "hub");
    assert.equal(hits[0].port, 8794);
    assert.equal(hits[0].joinHost, "hub.tail1.ts.net");
  });
  it("never probes bare IPs (serve routes by hostname)", async () => {
    const seen = new Set();
    const probe = async (host) => (seen.add(host), null);
    const s = status();
    s.Peer.e = { HostName: "nodns", UserID: 1, OS: "linux", Online: true, TailscaleIPs: ["100.64.0.9"] };
    await discoverHubs(s, { probe });
    assert.ok([...seen].every((h) => h.endsWith(".ts.net")));
  });
  it("same-account Hubs sort first", async () => {
    const probe = async (host, port) =>
      (host === "hub.tail1.ts.net" || host === "friend.tail1.ts.net") && port === HUB_PORTS[0] ? { service: "gotchibot-api" } : null;
    const hits = await discoverHubs(status(), { probe });
    assert.deepEqual(hits.map((h) => h.name), ["hub", "friend"]);
  });
});

describe("tailscaleDownloadUrl", () => {
  it("per platform", () => {
    assert.match(tailscaleDownloadUrl("darwin"), /mac$/);
    assert.match(tailscaleDownloadUrl("linux"), /linux$/);
    assert.match(tailscaleDownloadUrl("win32"), /windows$/);
  });
});
