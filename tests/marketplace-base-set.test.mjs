/**
 * Base set membership and the fe-marketing display title.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadCatalog,
  resolvePackScope,
  scopeLabel,
  STARTER_PACK_IDS,
} from "../scripts/template-pack.mjs";

const root = new URL("..", import.meta.url).pathname;

const BASE_SET = [
  "accountant",
  "architect",
  "auditor",
  "bend-crew",
  "brand-design",
  "chief-of-staff",
  "customer-support",
  "fe-marketing",
  "game-art-director",
  "jev",
  "kanban-manager",
  "mail-courier",
  "market-news",
  "market-research",
  "marketing-agency",
  "product-manager",
  "security-engineer",
  "social-media-manager",
  "worker",
];

describe("marketplace Base set", () => {
  it("labels the public set Base set and lists the roster", () => {
    assert.equal(scopeLabel("starter"), "Base set");
    assert.deepEqual([...STARTER_PACK_IDS].sort(), BASE_SET);
    const catalog = loadCatalog();
    const ids = catalog.packs.filter((p) => resolvePackScope(p) === "starter").map((p) => p.id).sort();
    assert.deepEqual(ids, BASE_SET);
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    assert.equal(fe.id, "fe-marketing");
    const pack = JSON.parse(readFileSync(join(root, "templates/marketplace/packs/fe-marketing/pack.json"), "utf8"));
    const playbook = JSON.parse(readFileSync(join(root, "templates/marketplace/packs/fe-marketing/playbook.json"), "utf8"));
    assert.equal(pack.title, "UI/UX");
    assert.equal(pack.id, "fe-marketing");
    assert.equal(playbook.title, "UI/UX");
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.match(html, /Base set/);
    assert.doesNotMatch(html.slice(0, html.indexOf("catalog-fallback")), /starter/);
  });

  it("renders Base set ASCII wearables and leaves the bend-crew suite without one", () => {
    const catalog = loadCatalog();
    const wearables = JSON.parse(readFileSync(join(root, "templates/marketplace/wearables.json"), "utf8"));
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    assert.equal(fe.wearable.name, "VR Headset");
    assert.equal(fe.wearable.id, 202);
    assert.equal(fe.wearable.ascii, wearables["fe-marketing"].ascii);
    assert.ok(fe.wearable.ascii.split("\n").length > 1);
    const crew = catalog.packs.find((p) => p.id === "bend-crew");
    assert.equal(crew.kind, "suite");
    assert.equal(crew.wearable, undefined);
    assert.equal(wearables["bend-crew"], undefined);
    assert.equal(wearables["prof-link-cube"], undefined);
    for (const id of [...BASE_SET, "bend-chief", "bend-laws", "bend-proofs"]) {
      if (id === "bend-crew") continue;
      const pack = catalog.packs.find((p) => p.id === id);
      assert.equal(typeof pack.wearable?.ascii, "string", id);
      assert.ok(pack.wearable.ascii.length > 0, id);
      const onDisk = JSON.parse(readFileSync(join(root, "templates/marketplace/packs", id, "pack.json"), "utf8"));
      assert.equal(onDisk.wearable.ascii, pack.wearable.ascii, id);
      assert.equal(onDisk.wearable.name, wearables[id].name, id);
    }
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.ok(html.includes('createElement("pre")'));
    assert.ok(html.includes('pre.className = "wearable"'));
    assert.equal(html.includes("assets/templates/"), false);
    assert.ok(html.includes("Trezor Wallet"));
  });
});
