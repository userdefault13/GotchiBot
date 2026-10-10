/**
 * Cockpit option 9 (Remote picker). Never connects: tmux/ssh are injected.
 *   node --test tests/remote-picker.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDesks } from "../scripts/gliff-desk.mjs";
import { buildRemoteDesks, tailnetState, sshArgv, tmuxOpenArgv, openDesk, renderTiles } from "../scripts/remote-picker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reg = loadDesks();
const ts = (selfIp, hostName, peers) => () =>
  JSON.stringify({ Self: { TailscaleIPs: [selfIp], HostName: hostName }, Peer: peers });

describe("remote picker", () => {
  it("builds the desk list from config/desks.json", () => {
    const l = buildRemoteDesks(reg, undefined, "some-macbook");
    assert.deepEqual(l.map((d) => d.name), Object.keys(reg.desks));
    assert.equal(l[0].target, "user_default@100.97.16.64");
    assert.ok(l.every((d) => d.state === "unknown"));
  });
  it("skips the current machine by tailnet IP or hostname", () => {
    const byIp = buildRemoteDesks(reg, tailnetState(ts("100.82.137.20", "x", {})), "mbp");
    assert.ok(!byIp.some((d) => d.name === "omarchymini"));
    assert.equal(byIp.length, Object.keys(reg.desks).length - 1);
    const byHost = buildRemoteDesks(reg, undefined, "omarchyM1");
    assert.ok(!byHost.some((d) => d.name === "omarchym1"));
  });
  it("marks online/offline from tailscale status, unknown otherwise", () => {
    const t = tailnetState(ts("100.1.1.1", "mbp", {
      a: { TailscaleIPs: ["100.97.16.64"], Online: true },
      b: { TailscaleIPs: ["100.110.220.76"], Online: false },
      c: { DNSName: "omarchym1.tail4120f5.ts.net.", Online: true },
    }));
    const by = Object.fromEntries(buildRemoteDesks(reg, t, "mbp").map((d) => [d.name, d.state]));
    assert.deepEqual(by, { imacomarchy: "online", omarchyimac: "offline", omarchymini: "unknown", omarchym1: "online" });
    assert.equal(tailnetState(() => { throw new Error("no tailscale"); }).ok, false);
  });
  it("constructs ssh argv and rejects bad targets", () => {
    const d = buildRemoteDesks(reg, undefined, "mbp")[1];
    assert.deepEqual(sshArgv(d), ["ssh", "user_default@100.110.220.76"]);
    assert.deepEqual(tmuxOpenArgv(d, "=gotchibot"), ["new-window", "-n", "omarchyimac", "-t", "gotchibot:", "ssh", "user_default@100.110.220.76"]);
    assert.throws(() => sshArgv({ target: "x@y; rm -rf /" }));
    assert.throws(() => sshArgv({ target: "-oProxyCommand=x@y" }) && sshArgv({ target: "a b@c" }));
  });
  it("openDesk runs only the injected tmux argv", () => {
    const calls = [];
    const d = buildRemoteDesks(reg, undefined, "mbp")[0];
    openDesk(d, { session: "", run: (a) => { calls.push(a); return 0; } });
    assert.deepEqual(calls, [["new-window", "-n", "imacomarchy", "ssh", "user_default@100.97.16.64"]]);
  });
  it("renders a tile per desk with the key hint", () => {
    const text = renderTiles(buildRemoteDesks(reg, undefined, "mbp"), 0, 100).join("\n");
    assert.match(text, /omarchymini/);
    assert.match(text, /enter open ssh tile/);
  });
  it("cockpit menu routes option 9 to remote", () => {
    const out = execFileSync(process.execPath, [path.join(root, "scripts/onboarding-gate.mjs"), "--print-cockpit-menu", "--tree"], {
      cwd: root, encoding: "utf8", timeout: 20000,
      env: { ...process.env, GOTCHIBOT_HUB_CONFIG: path.join(root, "sessions", "not-the-hub-api.json") },
    }).split("\n");
    assert.equal(out[0], "top 9");
    assert.equal(out[9], "Remote (ssh into another desk)");
  });
});
