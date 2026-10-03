/**
 * Hub dashboard page + its Hub… menu entry. No QEMU, no hub API, no tmux.
 *   node --test tests/hub-dashboard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  HUB_DASHBOARD_SECTIONS,
  assembleHubDashboard,
  renderHubDashboard,
} from "../scripts/hub-dashboard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function menuGroups(args) {
  const text = execFileSync(process.execPath, ["scripts/onboarding-gate.mjs", "--print-cockpit-menu", "--tree", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
  });
  const groups = {};
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) {
      cur = line.slice(2);
      groups[cur] = [];
    } else if (cur && line.startsWith("  ")) groups[cur].push(line.trim());
  }
  return groups;
}

describe("hub dashboard", () => {
  it("is a Hub… option when the hub is down and when SSH is up", () => {
    const down = menuGroups([]);
    const up = menuGroups(["--ssh-hub"]);
    assert.ok(down["group:hub"].includes("hub-dashboard"));
    assert.ok(up["group:hub"].includes("hub-dashboard"));
    assert.equal(down["group:hub"][1], "hub-dashboard");
    assert.equal(up["group:hub"][1], "hub-dashboard");
  });

  it("renders every section and does not invent counts when sources are missing", () => {
    const model = assembleHubDashboard({
      at: "2026-10-03T00:00:00.000Z",
      local: { state: "unavailable", reason: "desk receiver and tmux could not be checked", source: "receiver · tmux" },
      remote: { state: "unavailable", reason: "tailscale status unavailable", source: "hub-roster" },
      db: { state: "unavailable", reason: "nothing answered", source: "GET /health", pin: "no mongo pin (sessions/.mongo.json) — not a live ping" },
      projects: { state: "unavailable", reason: "project list failed", source: "sessions/pstack" },
      logs: { state: "unavailable", reason: "sessions/.gotchibot-api.log is not on this desk", source: "hub api log" },
      vm: { state: "unavailable", reason: "shared guest is not running and has no serial log — this page does not start QEMU", source: "gbvm-shared serial" },
    });
    const text = stripVTControlCharacters(renderHubDashboard(model, 72));
    for (const title of HUB_DASHBOARD_SECTIONS) assert.match(text, new RegExp(title));
    assert.match(text, /unavailable/);
    assert.match(text, /does not start QEMU/);
    assert.match(text, /q back to Hub/);
    assert.doesNotMatch(text, /\b\d+\/\d+\b/);
    assert.doesNotMatch(text, /running\s+ssh/);
  });

  it("shows live facts it was given, including the shared-guest serial preview", () => {
    const model = assembleHubDashboard({
      local: { state: "up", detail: "receiver :45679 · tmux gotchibot", pair: "pin desk-a · hub.tail", source: "receiver · tmux" },
      remote: {
        state: "up",
        source: "hub-roster",
        desks: [{ label: "imac-2020", connected: true, detail: "gateway✓" }],
      },
      db: { state: "up", detail: "GET /health on 127.0.0.1:8793", pin: "pin local · GotchiBot — config only, not a live ping", source: "GET /health" },
      projects: { state: "up", source: "sessions/pstack", items: [{ slug: "gotchibot", current: true }] },
      logs: { state: "up", source: "hub api log", lines: ["api listening token=sekrit"] },
      vm: {
        state: "up",
        running: true,
        detail: "gbvm-shared · Debian 12 shared guest",
        lines: ["Debian GNU/Linux 12"],
        source: "gbvm-shared serial",
      },
    });
    const text = stripVTControlCharacters(renderHubDashboard(model, 80));
    assert.match(text, /receiver :45679/);
    assert.match(text, /imac-2020/);
    assert.match(text, /GET \/health on 127\.0\.0\.1:8793/);
    assert.match(text, /gotchibot/);
    assert.match(text, /Debian GNU\/Linux 12/);
    assert.match(text, /token=\*\*\*/);
    assert.doesNotMatch(text, /sekrit/);
  });
});
