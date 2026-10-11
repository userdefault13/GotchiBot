/**
 * Read-only desk MCP tools: fakes only, output free of tokens.
 *   node --test tests/mcp-desk-tools.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { deskRedact, deskStatus, deskLogs, deskGit, deskPanes, deskMailCheck, pairingLine } from "../mcp-servers/hub-status/desk-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "gbd_SuperSecretDeskToken1234567890";
const RAW = "rawtokenvalue-NotInGbdShape99";
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "desk-"));
  mkdirSync(join(root, "sessions"));
  writeFileSync(
    join(root, "sessions/.hub.json"),
    JSON.stringify({ deskToken: RAW, deskName: "mbp", deskId: "d1", deskApiBase: "http://hub.ts.net:8794", pairedAt: "2026-10-01T00:00:00Z" }),
  );
  writeFileSync(
    join(root, "sessions/a.log"),
    ["start", `auth Bearer abcdefghijklmnop`, `X-GotchiBot-Desk-Token: ${TOKEN}`, `leak ${RAW}`, `deskToken="zzzzzzzz"`, "url http://x/?token=hunter22secret", "end"].join("\n"),
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

const noLeak = (v) => {
  const s = JSON.stringify(v);
  for (const bad of [TOKEN, RAW, "abcdefghijklmnop", "zzzzzzzz", "hunter22secret"]) assert.ok(!s.includes(bad), `leaked ${bad}`);
};

describe("redaction", () => {
  it("scrubs token shapes and literal values", () => {
    const out = deskRedact(`a ${TOKEN} b Bearer abcdefghijklmnop c ${RAW} d password=hunter2xx`, [RAW]);
    noLeak(out);
    assert.ok(!out.includes("hunter2xx"));
  });
});

describe("desk tools", () => {
  it("status: pairing line has no token, health from fake fetch, tmux from fake run", async () => {
    const r = await deskStatus({
      root,
      env: {},
      fetchImpl: async () => ({ ok: true, status: 200 }),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    assert.equal(r.receiver.ok, true);
    assert.equal(r.tmux.up, true);
    assert.match(r.pairing.line, /token present \(not shown\)/);
    noLeak(r);
  });
  it("status: reports receiver down and tmux down plainly", async () => {
    const r = await deskStatus({
      root,
      env: {},
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    assert.equal(r.receiver.ok, false);
    assert.equal(r.tmux.up, false);
  });
  it("pairing line without a pin", () => {
    assert.equal(pairingLine(null).paired, false);
  });
  it("logs: lists, tails redacted, rejects paths", async () => {
    const list = await deskLogs({ root, env: {} });
    assert.deepEqual(list.files.map((f) => f.name), ["a.log"]);
    const t = await deskLogs({ root, env: {}, file: "a.log", lines: 50 });
    assert.equal(t.lines.length, 7);
    noLeak(t);
    await assert.rejects(deskLogs({ root, env: {}, file: "../.hub.json" }));
    await assert.rejects(deskLogs({ root, env: {}, file: "nope.log" }));
  });
  it("git: branch, sha, dirty", async () => {
    const run = async (_c, args) => {
      if (args[0] === "status") return { code: 0, stdout: "## main...origin/main\n M a.js\n?? b.txt\n", stderr: "" };
      if (args.includes("--abbrev-ref")) return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 0, stdout: "abc1234\n", stderr: "" };
    };
    const r = await deskGit({ root, env: {}, run });
    assert.equal(r.branch, "main");
    assert.equal(r.sha, "abc1234");
    assert.deepEqual(r.dirty, [" M a.js", "?? b.txt"]);
  });
  it("panes: parses tmux and ps; down session is plain", async () => {
    const run = async (cmd) =>
      cmd === "tmux"
        ? { code: 0, stdout: "0.0\tchat\tnode\t0\t101\n1.0\tlogs\ttail\t1\t102\n", stderr: "" }
        : { code: 0, stdout: "101 01:02 0.5 1.0 /usr/bin/node\n5 00:01 0 0 /sbin/launchd\n", stderr: "" };
    const r = await deskPanes({ run });
    assert.equal(r.panes[1].dead, true);
    assert.equal(r.processes.length, 1);
    const down = await deskPanes({ run: async () => ({ code: 1, stdout: "", stderr: "" }) });
    assert.equal(down.up, false);
  });
  it("mail check: up, down, and leaks nothing", async () => {
    const up = await deskMailCheck({ root: ROOT, env: {}, run: async () => ({ code: 0, stdout: "OK gotchibot@gotchibot.xyz (imaps)\n", stderr: "" }) });
    assert.equal(up.status, "up");
    const down = await deskMailCheck({
      root: ROOT,
      env: {},
      run: async () => ({ code: 1, stdout: "", stderr: `FAIL x stage=connect password=${RAW}\n` }),
    });
    assert.equal(down.status, "down");
    assert.ok(!JSON.stringify(down).includes(RAW));
  });
});

describe("stdio catalog", () => {
  it("lists the 4 old tools plus 5 read-only desk tools", async () => {
    const child = spawn(process.execPath, ["mcp-servers/hub-status/stdio.mjs"], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const [chunk] = await once(child.stdout, "data");
    child.kill();
    const names = JSON.parse(String(chunk).split("\n")[0]).result.tools.map((t) => t.name);
    assert.deepEqual(names, [
      "hub_status", "openclaw_gateway_check_would_run", "gotchibot_chat", "gotchibot_handoff",
      "desk_status", "desk_logs", "desk_git", "desk_panes", "desk_mail_check",
    ]);
  });
});
