/**
 * Cockpit "What next?" list is nested. Does not start tmux.
 *   node --test tests/cockpit-menu.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts/onboarding-gate.mjs");

function printed(args) {
  return execFileSync(process.execPath, [gate, "--print-cockpit-menu", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      GOTCHIBOT_HUB_CONFIG: path.join(root, "sessions", "not-the-hub-api.json"),
    },
  });
}

function parse(text) {
  const lines = text.trim().split("\n");
  const top = Number(lines[0].replace("top ", ""));
  const flatLine = lines.findIndex((l) => l.startsWith("flat "));
  const labels = lines.slice(1, flatLine);
  const flat = Number(lines[flatLine].replace("flat ", ""));
  const groups = {};
  let cur = null;
  for (const line of lines.slice(flatLine + 1)) {
    if (line.startsWith("# ")) {
      cur = line.slice(2);
      groups[cur] = [];
    } else if (cur && line.startsWith("  ")) {
      groups[cur].push(line.trim());
    }
  }
  return { top, labels, flat, groups };
}

const LEAVES_DOWN = [
  "launch",
  "select-project",
  "checkpoint-project",
  "hub-network",
  "hub-lite",
  "hub-implement",
  "meet",
  "kanban",
  "inbox",
  "pstack",
  "factory",
  "roster",
  "export-roster",
  "import",
  "marketplace",
  "mint",
  "mint-collateral",
  "settings",
  "avatar",
  "roster-order",
];

describe("cockpit menu nesting", () => {
  it("prints a shorter top list and keeps every action", () => {
    const down = parse(printed(["--tree"]));
    const up = parse(printed(["--ssh-hub", "--tree"]));
    assert.equal(down.top, 8);
    assert.equal(up.top, 8);
    assert.equal(down.flat, 20);
    assert.equal(up.flat, 21);
    assert.ok(down.top < down.flat);
    assert.deepEqual(down.labels, [
      "Open desk",
      "Project…",
      "Hub…",
      "Start meeting / morning recap",
      "Desk panes…",
      "View & browse…",
      "Mint…",
      "Settings…",
    ]);
    assert.deepEqual(down.groups["group:project"], ["select-project", "checkpoint-project"]);
    assert.deepEqual(down.groups["group:hub"], ["hub-network", "hub-lite", "hub-implement"]);
    assert.deepEqual(up.groups["group:hub"], ["hub-network", "hub-lite", "hub", "hub-infra"]);
    assert.deepEqual(down.groups["group:desk"], ["kanban", "inbox", "pstack", "factory"]);
    assert.deepEqual(down.groups["group:view"], ["roster", "export-roster", "import", "marketplace"]);
    assert.deepEqual(down.groups["group:mint"], ["mint", "mint-collateral"]);
    assert.deepEqual(down.groups["group:settings"], ["settings", "avatar", "roster-order"]);
    const leaves = [
      "launch",
      "meet",
      ...Object.values(down.groups).flat(),
    ];
    assert.deepEqual(leaves.sort(), [...LEAVES_DOWN].sort());
  });
});
