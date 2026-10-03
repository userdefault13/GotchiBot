/**
 * Hub dashboard page + its Hub… menu entry. No QEMU, no hub API, no tmux.
 *   node --test tests/hub-dashboard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  HUB_DASHBOARD_DESK_REASON,
  HUB_DASHBOARD_SECTIONS,
  HUB_LITE_SECTIONS,
  assembleHubDashboard,
  assembleHubLite,
  collectHubLite,
  renderHubDashboard,
  renderHubLite,
} from "../scripts/hub-dashboard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function menuGroups(args, env = {}) {
  const text = execFileSync(process.execPath, ["scripts/onboarding-gate.mjs", "--print-cockpit-menu", "--tree", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      GOTCHIBOT_HUB_CONFIG: path.join(root, "sessions", "not-the-hub-api.json"),
      ...env,
    },
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
  it("hides the hub dashboard on a desk and offers the lite view instead", () => {
    const down = menuGroups([]);
    const up = menuGroups(["--ssh-hub"]);
    assert.ok(down["group:hub"].includes("hub-lite"));
    assert.ok(up["group:hub"].includes("hub-lite"));
    assert.equal(down["group:hub"][1], "hub-lite");
    assert.equal(up["group:hub"][1], "hub-lite");
    assert.ok(!down["group:hub"].includes("hub-dashboard"));
    assert.ok(!up["group:hub"].includes("hub-dashboard"));
    assert.ok(down["group:hub"].includes("hub-network"));
    assert.ok(up["group:hub"].includes("hub"));
    assert.equal(Object.keys(down).length > 0, true);
  });

  it("keeps the hub dashboard, not the lite view, when this computer is the hub", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-api-"));
    const cfg = path.join(dir, "hub-api.json");
    writeFileSync(cfg, "{}\n");
    try {
      const down = menuGroups([], { GOTCHIBOT_HUB_CONFIG: cfg });
      const up = menuGroups(["--ssh-hub"], { GOTCHIBOT_HUB_CONFIG: cfg });
      assert.equal(down["group:hub"][1], "hub-dashboard");
      assert.equal(up["group:hub"][1], "hub-dashboard");
      assert.ok(!down["group:hub"].includes("hub-lite"));
      assert.ok(down["group:hub"].includes("hub-network"));
      assert.ok(down["group:hub"].includes("hub-implement"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open the full dashboard when this desk is not the hub", () => {
    const r = spawnSync(process.execPath, ["scripts/hub-dashboard.mjs", "--once"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        GOTCHIBOT_HUB_CONFIG: path.join(root, "sessions", "not-the-hub-api.json"),
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(HUB_DASHBOARD_DESK_REASON));
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /HUB DASHBOARD/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /VM PREVIEW|DATABASE/);
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

  it("lite view shows pairing and remote names, not logs, database, or VM", async () => {
    const model = assembleHubLite({
      local: {
        state: "up",
        paired: true,
        detail: "macbook · imacomarchy.tail4120f5.ts.net",
        source: "sessions/.hub.json",
      },
      remote: {
        state: "up",
        source: "hub-roster",
        desks: [{ label: "imacomarchy", connected: true, detail: "gateway✓" }],
      },
    });
    const text = stripVTControlCharacters(renderHubLite(model, 72));
    assert.match(text, /HUB LITE/);
    assert.match(text, /lite view/);
    assert.match(text, /not the hub dashboard/);
    assert.match(text, /paired/);
    assert.match(text, /imacomarchy/);
    for (const title of HUB_LITE_SECTIONS) assert.match(text, new RegExp(title));
    assert.doesNotMatch(text, /HUB DASHBOARD/);
    assert.doesNotMatch(text, /DATABASE/);
    assert.doesNotMatch(text, /LOGS/);
    assert.doesNotMatch(text, /VM PREVIEW/);
    assert.equal(model.sections.length, HUB_LITE_SECTIONS.length);

    const unpaired = stripVTControlCharacters(
      renderHubLite(
        assembleHubLite({
          local: { state: "down", paired: false, detail: "no hub pin (sessions/.hub.json)" },
          remote: { state: "unavailable", reason: "tailscale status unavailable" },
        }),
        72,
      ),
    );
    assert.match(unpaired, /not paired/);
    assert.match(unpaired, /unavailable/);
    assert.doesNotMatch(unpaired, /imacomarchy/);
  });

  it("lite collect uses the pin and a given roster and does not print the desk token", async () => {
    const pin = path.join(root, "sessions", "test-hub-pin.json");
    writeFileSync(
      pin,
      JSON.stringify({
        deskToken: "sekrit-token",
        deskApiBase: "http://imacomarchy.tail4120f5.ts.net:8794",
        deskName: "macbook",
      }),
    );
    const prev = process.env.GOTCHIBOT_HUB_PIN;
    process.env.GOTCHIBOT_HUB_PIN = pin;
    try {
      const model = await collectHubLite({
        roster: {
          tailnet: { ok: true },
          desks: [
            { self: true, host: "macbook", online: true, why: "this desk" },
            { self: false, host: "imacomarchy", online: true, why: "gateway✓" },
          ],
        },
      });
      const text = stripVTControlCharacters(renderHubLite(model, 80));
      assert.match(text, /paired/);
      assert.match(text, /macbook/);
      assert.match(text, /imacomarchy/);
      assert.doesNotMatch(text, /sekrit-token/);
      assert.doesNotMatch(text, /DATABASE|LOGS|VM PREVIEW|HUB DASHBOARD/);
    } finally {
      if (prev == null) delete process.env.GOTCHIBOT_HUB_PIN;
      else process.env.GOTCHIBOT_HUB_PIN = prev;
      rmSync(pin, { force: true });
    }
  });
});
